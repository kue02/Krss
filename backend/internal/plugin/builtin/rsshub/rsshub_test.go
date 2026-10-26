package rsshub

// 错误页分类的测试（55-18：从 service/rsshub_error_test.go 随迁，口径不变）。
//
// 与本体期的区别只有一处数据源：实例地址从「通用设置 general.rsshub_base_url」
// 换成「插件设置 plugin.rsshub.base_url」（迁移 33 会把旧值复制过来）。

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"

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

// fakeStore 只实现插件设置助手用到的那几个方法。
type fakeStore struct {
	mu     sync.Mutex
	values map[string]string
}

func newFakeStore(values map[string]string) *fakeStore {
	if values == nil {
		values = map[string]string{}
	}
	return &fakeStore{values: values}
}

func (s *fakeStore) Get(_ context.Context, key string) (*model.Setting, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	if !ok {
		return nil, errors.New("not found")
	}
	return &model.Setting{Key: key, Value: value, UpdatedAt: time.Now()}, nil
}

func (s *fakeStore) Set(_ context.Context, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
	return nil
}

func (s *fakeStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.values, key)
	return nil
}

// settingsForTest 造一份「配了实例地址」的插件设置。
func settingsForTest(baseURL string) plugin.Settings {
	values := map[string]string{}
	if baseURL != "" {
		values["plugin.rsshub.base_url"] = baseURL
	}
	return plugin.Settings{PluginID: "rsshub", Store: newFakeStore(values)}
}

func TestClassifyRSSHubHTTPFailure(t *testing.T) {
	settings := settingsForTest("https://rsshub.example.com")
	ctx := context.Background()
	feedURL := "https://rsshub.example.com/twitter/user/elikikosk"

	msg := classifyRSSHubHTTPFailure(ctx, settings, feedURL, 404, []byte(rsshubRouteNotFoundPage))
	require.True(t, strings.HasPrefix(msg, rssHubRouteNotFoundPrefix), "got %q", msg)
	require.NotContains(t, msg, "Node Version", "路由名之外的页脚信息不该进错误串")

	msg = classifyRSSHubHTTPFailure(ctx, settings, feedURL, 503, []byte(rsshubUpstreamFailPage))
	require.Equal(t, rssHubUpstreamErrPrefix+"Twitter API returned an incomplete user response", msg)
}

func TestClassifyRSSHubHTTPFailureNonRssHubPassthrough(t *testing.T) {
	settings := settingsForTest("https://rsshub.example.com")
	ctx := context.Background()

	// 源不是 RSSHub 实例：即使正文长得像，也保持「HTTP xxx」原样
	other := classifyRSSHubHTTPFailure(ctx, settings, "https://blog.example.com/feed.xml", 404, []byte(rsshubRouteNotFoundPage))
	require.Equal(t, "HTTP 404", other)

	// RSSHub 源但错误页不是 RSSHub 形态：同样原样
	plain := classifyRSSHubHTTPFailure(ctx, settings, "https://rsshub.example.com/x", 502, []byte(genericErrorPage))
	require.Equal(t, "HTTP 502", plain)

	// 没配 RSSHub 实例地址：不过笼
	noBase := settingsForTest("")
	require.Equal(t, "HTTP 503", classifyRSSHubHTTPFailure(ctx, noBase, "https://rsshub.example.com/x", 503, []byte(rsshubUpstreamFailPage)))
}

func TestClassifyRSSHubFetchFailure(t *testing.T) {
	settings := settingsForTest("https://rsshub.example.com")
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

	settings := settingsForTest("https://rsshub.example.com")
	msg := classifyRSSHubHTTPFailure(context.Background(), settings,
		"https://rsshub.example.com/x", 503, []byte(page))
	require.Len(t, msg, len(rssHubUpstreamErrPrefix)+rssHubMaxDetail+3) // 截断 + 「…」
	require.True(t, strings.HasSuffix(msg, "…"))
}

// 55-18 新增：插件链语义 —— 不是自己实例的源不认领（返回空串，交给下一家）。
func TestClassifier_OnlyClaimsOwnInstance(t *testing.T) {
	old := store
	store = newFakeStore(map[string]string{"plugin.rsshub.base_url": "https://rsshub.example.com"})
	t.Cleanup(func() { store = old })

	var c plugin.FetchClassifier = classifier{}
	require.NotEmpty(t, c.ID())

	// 自己的实例：认领，按错误页归类
	msg := c.Classify(context.Background(),
		model.Feed{URL: "https://rsshub.example.com/twitter/user/x"},
		404, []byte(rsshubRouteNotFoundPage), nil)
	require.True(t, strings.HasPrefix(msg, rssHubRouteNotFoundPrefix), "got %q", msg)

	// 别人的源：不认领（空串 = 调用方按原 err 透传）
	require.Equal(t, "", c.Classify(context.Background(),
		model.Feed{URL: "https://blog.example.com/feed.xml"},
		404, []byte(rsshubRouteNotFoundPage), nil))

	// transport 失败（fetchErr 非空）同样只认自己的实例
	require.Equal(t, rssHubUnreachablePrefix+"connection refused",
		c.Classify(context.Background(),
			model.Feed{URL: "https://rsshub.example.com/x"},
			0, nil, errors.New("connection refused")))
	require.Equal(t, "", c.Classify(context.Background(),
		model.Feed{URL: "https://blog.example.com/feed.xml"},
		0, nil, errors.New("connection refused")))
}

// 设置段契约：字段键 / 类型被前端与迁移 33 依赖，改了就炸这里。
func TestSettingsSections_Shape(t *testing.T) {
	sections := Plugin{}.SettingsSections()
	require.Len(t, sections, 1)
	require.Equal(t, "rsshub-instance", sections[0].ID)

	fields := map[string]plugin.Field{}
	for _, f := range sections[0].Fields {
		fields[f.Key] = f
	}
	require.Equal(t, "text", fields["base_url"].Type)
	require.Equal(t, "secret", fields["access_key"].Type)
	require.Equal(t, []string{"plugin.rsshub.access_key"}, plugin.SecretKeys(Plugin{}.Meta(), sections[0].Fields))
}

func TestMeta_Defaults(t *testing.T) {
	meta := Plugin{}.Meta()
	require.Equal(t, "rsshub", meta.ID)
	require.True(t, meta.Builtin)
	require.Nil(t, meta.DefaultEnabled, "稳定能力：默认启用 ⇒ 老实例升级后行为零变化")
	require.Empty(t, Plugin{}.Actions(), "RSSHub 不联动自动化")
	require.Empty(t, Plugin{}.EntryProcessors())
	require.Len(t, Plugin{}.FetchClassifiers(), 1)
}
