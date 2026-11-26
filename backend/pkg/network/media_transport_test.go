package network

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// 必修2：媒体档 transport 必须是长连接 + 只限响应头超时（不是整请求超时）。
func TestNewMediaTransport_KeepAliveAndHeaderTimeout(t *testing.T) {
	f := NewClientFactory(&mockProvider{ipStack: "default"}, &mockProvider{})
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) { return nil, nil }
	tr := f.newMediaTransport(dial, "", 7*time.Second)

	require.False(t, tr.DisableKeepAlives, "媒体档必须复用长连接")
	require.Equal(t, 7*time.Second, tr.ResponseHeaderTimeout, "只限首字节")
	require.True(t, tr.ForceAttemptHTTP2)
	require.Equal(t, 8, tr.MaxIdleConnsPerHost)
}

// 必修2：smart 档下两条腿也必须是 media 档（长连接 + 首字节超时），不能被 newOneShotTransport 顶掉。
func TestBuildMediaTransport_SmartLegsAreMediaGrade(t *testing.T) {
	f := NewClientFactory(&mockProvider{ipStack: "default"}, &mockProvider{})
	rt := f.buildMediaTransport("smart:http://127.0.0.1:10808", "default", 5*time.Second)

	smart, ok := rt.(*SmartTransport)
	require.True(t, ok, "smart: 前缀必须包成 *SmartTransport")

	direct, ok := smart.direct.(*http.Transport)
	require.True(t, ok, "直连腿必须是 *http.Transport")
	require.False(t, direct.DisableKeepAlives, "直连腿要长连接")
	require.Equal(t, 5*time.Second, direct.ResponseHeaderTimeout, "直连腿要有首字节超时")

	via, ok := smart.viaProxy.(*http.Transport)
	require.True(t, ok, "代理腿必须是 *http.Transport")
	require.False(t, via.DisableKeepAlives, "代理腿要长连接")
	require.Equal(t, 5*time.Second, via.ResponseHeaderTimeout)
	require.NotNil(t, via.Proxy, "代理腿要真的配上代理")
}

// N7：探测超时只掐「等响应头」，不该掐断 body。超过 probe 时间后仍能读完整个 body。
func TestSmartTransport_BodySurvivesProbeTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		_, _ = w.Write([]byte("hello"))
		w.(http.Flusher).Flush()
		time.Sleep(200 * time.Millisecond) // 远超过 probe 超时
		_, _ = w.Write([]byte("world"))
	}))
	defer server.Close()

	tr := NewSmartTransport(http.DefaultTransport, nil, nil)
	tr.probe = 50 * time.Millisecond

	resp, err := tr.RoundTrip(httptest.NewRequest(http.MethodGet, server.URL, nil))
	require.NoError(t, err)
	time.Sleep(120 * time.Millisecond) // 超过探测超时后再读 body
	data, err := io.ReadAll(resp.Body)
	require.NoError(t, err, "body 不该因为探测超时被掐断")
	require.Equal(t, "helloworld", string(data))
	require.NoError(t, resp.Body.Close())
}

// cancelOnCloseBody：Close 才 cancel，读完不 cancel（避免 context 泄漏的旧 bug 反向）。
func TestCancelOnCloseBody(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	body := &cancelOnCloseBody{ReadCloser: io.NopCloser(io.LimitReader(nil, 0)), cancel: cancel}
	require.NoError(t, body.Close())
	require.ErrorIs(t, ctx.Err(), context.Canceled)
	_ = context.Background()
}
