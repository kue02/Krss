package network

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// 14 批：按来源（订阅）取代理 —— 「订阅 → 文件夹父级链 → 全局」的解析在 service 层，
// pkg/network 只负责「用解析出来的那份」；这里钉住三件事：
// ① 解析成功时以解析结果为准（空串 = 直连，不再回落全局）② 解析不出来才回落全局
// ③ 每次现读，不缓存（改完设置立刻生效）。

type fakeSourceProvider struct {
	url   string
	ok    bool
	calls int
	seen  []int64
}

func (p *fakeSourceProvider) ProxyURLForFeed(_ context.Context, feedID int64) (string, bool) {
	p.calls++
	p.seen = append(p.seen, feedID)
	return p.url, p.ok
}

func proxyOf(t *testing.T, client *http.Client) string {
	t.Helper()
	transport, ok := client.Transport.(*http.Transport)
	require.True(t, ok)
	// Proxy 为 nil = 直连（既有的 newOneShotTransport(dialFunc, nil) 分支）
	if transport.Proxy == nil {
		return ""
	}
	req, err := http.NewRequest(http.MethodGet, "https://example.com/feed", nil)
	require.NoError(t, err)
	url, err := transport.Proxy(req)
	require.NoError(t, err)
	if url == nil {
		return ""
	}
	return url.String()
}

func TestClientFactory_HTTPClientForFeed_UsesSourceProxy(t *testing.T) {
	global := &mockProvider{proxyURL: "http://global-proxy.local:1080", ipStack: "default"}
	source := &fakeSourceProvider{url: "http://feed-proxy.local:7890", ok: true}
	factory := NewClientFactory(global, global).WithSourceProxy(source)

	client := factory.NewHTTPClientForFeed(context.Background(), 42, 5*time.Second)
	require.Equal(t, "http://feed-proxy.local:7890", proxyOf(t, client))
	require.Equal(t, []int64{42}, source.seen)
}

// SOCKS5 那条走的是自建 dialer（Proxy 函数为 nil 是既有实现），这里只钉「解析器被按 feed 调到了」。
func TestClientFactory_HTTPClientForFeed_SocksSource(t *testing.T) {
	global := &mockProvider{proxyURL: "http://global-proxy.local:1080", ipStack: "default"}
	source := &fakeSourceProvider{url: "socks5://feed-proxy.local:1080", ok: true}
	factory := NewClientFactory(global, global).WithSourceProxy(source)

	client := factory.NewHTTPClientForFeed(context.Background(), 99, 5*time.Second)
	transport, ok := client.Transport.(*http.Transport)
	require.True(t, ok)
	require.Nil(t, transport.Proxy, "SOCKS5 用自建 dialer，不设 Proxy 函数（既有行为）")
	require.Equal(t, []int64{99}, source.seen)
}

// 解析结果为空串 = 「这一条直连」——不能再回落全局那份（否则「订阅设直连」就白设了）。
func TestClientFactory_HTTPClientForFeed_DirectWinsOverGlobal(t *testing.T) {
	global := &mockProvider{proxyURL: "http://global-proxy.local:1080", ipStack: "default"}
	source := &fakeSourceProvider{url: "", ok: true}
	factory := NewClientFactory(global, global).WithSourceProxy(source)

	client := factory.NewHTTPClientForFeed(context.Background(), 7, 5*time.Second)
	require.Empty(t, proxyOf(t, client))
}

// 解析不出来（库里查不到等）→ 退回全局那份，保持老行为。
func TestClientFactory_HTTPClientForFeed_FallsBackToGlobal(t *testing.T) {
	global := &mockProvider{proxyURL: "http://global-proxy.local:1080", ipStack: "default"}
	source := &fakeSourceProvider{ok: false}
	factory := NewClientFactory(global, global).WithSourceProxy(source)

	client := factory.NewHTTPClientForFeed(context.Background(), 7, 5*time.Second)
	require.Equal(t, "http://global-proxy.local:1080", proxyOf(t, client))

	// feedID 非法 / 没装解析器 → 同样走全局
	require.Equal(t, "http://global-proxy.local:1080", proxyOf(t, factory.NewHTTPClientForFeed(context.Background(), 0, 5*time.Second)))
	bare := NewClientFactory(global, global)
	require.Equal(t, "http://global-proxy.local:1080", proxyOf(t, bare.NewHTTPClientForFeed(context.Background(), 7, 5*time.Second)))
}

// **不许加缓存**：改完设置下一轮就要用新的（11-20 那条「每轮重读」的规矩）。
func TestClientFactory_HTTPClientForFeed_ReadsEveryCall(t *testing.T) {
	global := &mockProvider{proxyURL: "http://global-proxy.local:1080", ipStack: "default"}
	source := &fakeSourceProvider{url: "http://first.local:1111", ok: true}
	factory := NewClientFactory(global, global).WithSourceProxy(source)

	require.Equal(t, "http://first.local:1111", proxyOf(t, factory.NewHTTPClientForFeed(context.Background(), 1, time.Second)))

	// 模拟「用户改了设置」
	source.url = "http://second.local:2222"
	require.Equal(t, "http://second.local:2222", proxyOf(t, factory.NewHTTPClientForFeed(context.Background(), 1, time.Second)))
	require.Equal(t, 2, source.calls, "每次建客户端都要问一次解析器")
}

func TestClientFactory_AzureSessionForFeed(t *testing.T) {
	global := &mockProvider{proxyURL: "http://global-proxy.local:1080", ipStack: "default"}
	source := &fakeSourceProvider{url: "http://feed-proxy.local:3128", ok: true}
	factory := NewClientFactory(global, global).WithSourceProxy(source)

	session := factory.NewAzureSessionForFeed(context.Background(), 3, 5*time.Second)
	require.NotNil(t, session)
	defer session.Close()
	require.Equal(t, []int64{3}, source.seen)
}
