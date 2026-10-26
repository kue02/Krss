package bark_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/plugin/builtin/bark"

	"github.com/stretchr/testify/require"
)

// fakeStore 插件设置存储的最小实现（键 = 完整键 plugin.bark.url）。
type fakeStore struct {
	values map[string]string
}

func (s *fakeStore) Get(_ context.Context, key string) (*model.Setting, error) {
	value, ok := s.values[key]
	if !ok {
		return nil, nil
	}
	return &model.Setting{Key: key, Value: value}, nil
}

func (s *fakeStore) Set(_ context.Context, key, value string) error {
	if s.values == nil {
		s.values = map[string]string{}
	}
	s.values[key] = value
	return nil
}

func (s *fakeStore) Delete(_ context.Context, key string) error {
	delete(s.values, key)
	return nil
}

// capture 记下假 Bark 服务器收到的一次请求。
type capture struct {
	path string
	ua   string
	body string
}

// newFakeBark 起一个假 Bark 服务器，把收到的请求都记进 calls。
func newFakeBark(t *testing.T, status int, reply string) (*httptest.Server, *[]capture) {
	t.Helper()
	calls := &[]capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		*calls = append(*calls, capture{path: r.URL.Path, ua: r.Header.Get("User-Agent"), body: string(body)})
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

func notifyAction(t *testing.T) plugin.Action {
	t.Helper()
	for _, action := range bark.New().Actions() {
		if action.ID() == "notify" {
			return action
		}
	}
	t.Fatal("bark 插件没有 notify 动作")
	return nil
}

func ptr(s string) *string { return &s }

// TestNotifyAction_TwoLayerURL ① 规则里填了地址用规则的；② 留空跟 plugin.bark.url；③ 两层都空明确报错。
func TestNotifyAction_TwoLayerURL(t *testing.T) {
	ctx := context.Background()
	srv, calls := newFakeBark(t, http.StatusOK, `{"code":200}`)
	store := &fakeStore{values: map[string]string{"plugin.bark.url": srv.URL + "/GLOBAL"}}
	bark.Configure(srv.Client(), store)
	action := notifyAction(t)

	// ① 规则 config.url 优先
	require.NoError(t, action.Execute(ctx, plugin.ActionRequest{
		Filter: model.Filter{Name: "krss 推送"},
		Feed:   model.Feed{Title: "少数派"},
		Entry:  model.Entry{Title: ptr("新文章"), URL: ptr("https://example.com/1")},
		Config: map[string]string{"url": srv.URL + "/RULE"},
	}))
	require.Len(t, *calls, 1)
	require.Equal(t, "/RULE", (*calls)[0].path, "规则里填的地址优先")

	// ② 规则没填 → 跟插件全局地址
	require.NoError(t, action.Execute(ctx, plugin.ActionRequest{Config: map[string]string{}}))
	require.Len(t, *calls, 2)
	require.Equal(t, "/GLOBAL", (*calls)[1].path, "留空跟全局地址")

	// ③ 两层都没有 → 明确报错，不许静默成功
	empty := &fakeStore{}
	bark.Configure(srv.Client(), empty)
	err := action.Execute(ctx, plugin.ActionRequest{})
	require.Error(t, err)
	require.Contains(t, err.Error(), "没有全局推送地址")
	require.Len(t, *calls, 2, "没地址不该发出任何请求")
}

// TestNotifyAction_RedactsKeyInError ④ 非 2xx 错误里不许出现设备 key（地址就是凭证）。
func TestNotifyAction_RedactsKeyInError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		// 模拟 Bark / 反向代理把请求地址原样写回错误里（含设备 key）。
		_, _ = fmt.Fprintf(w, `{"err":"boom %s"}`, r.URL.String())
	}))
	defer srv.Close()

	store := &fakeStore{}
	bark.Configure(srv.Client(), store)
	action := notifyAction(t)

	err := action.Execute(context.Background(), plugin.ActionRequest{
		Config: map[string]string{"url": srv.URL + "/SECRETKEY"},
	})
	require.Error(t, err)
	require.NotContains(t, err.Error(), "SECRETKEY", "错误里不许出现设备 key（会进 last_error / 日志）")
	require.Contains(t, err.Error(), srv.Listener.Addr().String(), "打码后仍要留下主机，便于判断是谁不通")
	require.Contains(t, err.Error(), "500")
}

// TestNotifyAction_PayloadAndUserAgent ⑤ 报文字段与 UA。
func TestNotifyAction_PayloadAndUserAgent(t *testing.T) {
	srv, calls := newFakeBark(t, http.StatusOK, `{"code":200}`)
	bark.Configure(srv.Client(), &fakeStore{})
	action := notifyAction(t)

	require.NoError(t, action.Execute(context.Background(), plugin.ActionRequest{
		Filter: model.Filter{Name: "  krss 推送  "},
		Feed:   model.Feed{Title: "少数派"},
		Entry:  model.Entry{Title: ptr("新文章"), URL: ptr("https://example.com/1")},
		Config: map[string]string{"url": srv.URL + "/KEY"},
	}))

	require.Len(t, *calls, 1)
	got := (*calls)[0]
	require.Equal(t, "krss-notify/1", got.ua)

	var payload struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		URL   string `json:"url"`
		Group string `json:"group"`
	}
	require.NoError(t, json.Unmarshal([]byte(got.body), &payload))
	require.Equal(t, "krss 推送", payload.Title)
	require.Equal(t, "少数派 · 新文章", payload.Body)
	require.Equal(t, "https://example.com/1", payload.URL)
	require.Equal(t, "krss 推送", payload.Group)
}

// TestNotifyAction_PayloadTruncation 报文过长要截断（手机上太长反而看不清）。
func TestNotifyAction_PayloadTruncation(t *testing.T) {
	srv, calls := newFakeBark(t, http.StatusOK, "")
	bark.Configure(srv.Client(), &fakeStore{})
	action := notifyAction(t)

	longTitle := ""
	for i := 0; i < 200; i++ {
		longTitle += "长"
	}
	require.NoError(t, action.Execute(context.Background(), plugin.ActionRequest{
		Filter: model.Filter{Name: longTitle},
		Entry:  model.Entry{Title: ptr(longTitle)},
		Config: map[string]string{"url": srv.URL},
	}))

	var payload struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		Group string `json:"group"`
	}
	require.NoError(t, json.Unmarshal([]byte((*calls)[0].body), &payload))
	require.Len(t, []rune(payload.Title), 60, "标题截 60 个字符")
	require.Len(t, []rune(payload.Body), 120, "正文截 120 个字符")
	require.Len(t, []rune(payload.Group), 120)
}

// TestActionTest ⑥ 设置页「发送测试」：没地址先报错；有地址发一条测试报文。
func TestActionTest(t *testing.T) {
	ctx := context.Background()
	srv, calls := newFakeBark(t, http.StatusOK, `{"code":200}`)
	action := notifyAction(t)
	tester, ok := action.(plugin.ActionTester)
	require.True(t, ok, "bark notify 要实现 plugin.ActionTester（设置页测试按钮）")

	bark.Configure(srv.Client(), &fakeStore{})
	err := tester.Test(ctx)
	require.Error(t, err)
	require.Contains(t, err.Error(), "先填全局推送地址再测试")
	require.Empty(t, *calls, "没地址不该发请求")

	bark.Configure(srv.Client(), &fakeStore{values: map[string]string{"plugin.bark.url": srv.URL + "/GLOBAL"}})
	require.NoError(t, tester.Test(ctx))
	require.Len(t, *calls, 1)
	require.Equal(t, "/GLOBAL", (*calls)[0].path)
	require.Equal(t, "krss-notify/1", (*calls)[0].ua)
	require.Contains(t, (*calls)[0].body, "测试推送")
}
