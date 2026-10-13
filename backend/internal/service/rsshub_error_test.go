package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// 错误页样本取自真实例（rsshub.wxhdj.xyz）实测抓包，去 key 后原样保留骨架。
const rsshubRouteNotFoundPage = `<html><head><title>Welcome to RSSHub!</title></head><body>
<h2>Looks like something went wrong</h2>
<p>Error Message: NotFoundError: The route does not exist or has been deleted.</p>
<p>Route: /rsshub/routes-not-exist/test</p><p>Full Route: /rsshub/routes-not-exist/test</p>
<p>Node Version: v24.21.0</p></body></html>`

const rsshubUpstreamFailPage = `<html><head><title>Welcome to RSSHub!</title></head><body>
<h2>Looks like something went wrong</h2>
<p>Error Message: Error: Twitter API returned an incomplete user response</p>
<p>Route: /twitter/user/:id/:routeParams?</p>
<p>Node Version: v24.21.0</p></body></html>`

const genericErrorPage = `<html><head><title>Site maintenance</title></head><body>
<p>Error Message: something broke</p></body></html>`

// rssHubSettingsStub 只实现 GetGeneralSettings，其余方法不会被这些用例碰到。
type rssHubSettingsStub struct {
	SettingsService
	general *GeneralSettings
}

func (s *rssHubSettingsStub) GetGeneralSettings(ctx context.Context) (*GeneralSettings, error) {
	return s.general, nil
}

func newRssHubSettingsForTest(baseURL string) SettingsService {
	return &rssHubSettingsStub{general: &GeneralSettings{RSSHubBaseURL: baseURL}}
}

func TestClassifyRSSHubHTTPFailure(t *testing.T) {
	settings := newRssHubSettingsForTest("https://rsshub.example.com")
	ctx := context.Background()
	feedURL := "https://rsshub.example.com/twitter/user/elikikosk"

	msg := classifyRSSHubHTTPFailure(ctx, settings, feedURL, 404, []byte(rsshubRouteNotFoundPage))
	require.True(t, strings.HasPrefix(msg, rssHubRouteNotFoundPrefix), "got %q", msg)
	require.NotContains(t, msg, "Node Version", "路由名之外的页脚信息不该进错误串")

	msg = classifyRSSHubHTTPFailure(ctx, settings, feedURL, 503, []byte(rsshubUpstreamFailPage))
	require.Equal(t, rssHubUpstreamErrPrefix+"Twitter API returned an incomplete user response", msg)
}

func TestClassifyRSSHubHTTPFailureNonRssHubPassthrough(t *testing.T) {
	settings := newRssHubSettingsForTest("https://rsshub.example.com")
	ctx := context.Background()

	// 源不是 RSSHub 实例：即使正文长得像，也保持「HTTP xxx」原样
	other := classifyRSSHubHTTPFailure(ctx, settings, "https://blog.example.com/feed.xml", 404, []byte(rsshubRouteNotFoundPage))
	require.Equal(t, "HTTP 404", other)

	// RSSHub 源但错误页不是 RSSHub 形态：同样原样
	plain := classifyRSSHubHTTPFailure(ctx, settings, "https://rsshub.example.com/x", 502, []byte(genericErrorPage))
	require.Equal(t, "HTTP 502", plain)

	// 没配 RSSHub 实例地址：不过笼
	noBase := newRssHubSettingsForTest("")
	require.Equal(t, "HTTP 503", classifyRSSHubHTTPFailure(ctx, noBase, "https://rsshub.example.com/x", 503, []byte(rsshubUpstreamFailPage)))
}

func TestClassifyRSSHubFetchFailure(t *testing.T) {
	settings := newRssHubSettingsForTest("https://rsshub.example.com")
	ctx := context.Background()

	// 连不上（无正文）→ unreachable
	msg := classifyRSSHubFetchFailure(ctx, settings,
		"https://rsshub.example.com/twitter/user/x",
		errors.New("context deadline exceeded"), nil)
	require.Equal(t, rssHubUnreachablePrefix+"context deadline exceeded", msg)

	// 5xx 重试耗尽但正文是 RSSHub 错误页 → 按错误页分类，不是 unreachable
	msg = classifyRSSHubFetchFailure(ctx, settings,
		"https://rsshub.example.com/twitter/user/elikikosk",
		errors.New("HTTP 503"), []byte(rsshubUpstreamFailPage))
	require.Equal(t, rssHubUpstreamErrPrefix+"Twitter API returned an incomplete user response", msg)

	// 非 RSSHub 源：原样
	raw := classifyRSSHubFetchFailure(ctx, settings,
		"https://blog.example.com/feed.xml",
		errors.New("context deadline exceeded"), nil)
	require.Equal(t, "context deadline exceeded", raw)

	require.Equal(t, "", classifyRSSHubFetchFailure(ctx, settings, "https://rsshub.example.com/x", nil, nil))
}

func TestParseRSSHubErrorPageLongDetailTruncated(t *testing.T) {
	long := strings.Repeat("x", 500)
	page := `<html><title>Welcome to RSSHub!</title><body>Error Message: ` + long + ` Node Version: v1</body></html>`
	detail, ok := parseRSSHubErrorPage([]byte(page))
	require.True(t, ok)
	require.Len(t, detail, 500) // parse 层返回全文；截断发生在 classify 层

	settings := newRssHubSettingsForTest("https://rsshub.example.com")
	msg := classifyRSSHubHTTPFailure(context.Background(), settings,
		"https://rsshub.example.com/x", 503, []byte(page))
	require.Len(t, msg, len(rssHubUpstreamErrPrefix)+rssHubMaxDetail+3) // 截断 + 「…」
	require.True(t, strings.HasSuffix(msg, "…"))
}
