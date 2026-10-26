package bark_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/plugin/builtin/bark"

	"github.com/stretchr/testify/require"
)

// invoker 取插件实例的「界面直调」面（同一个插件既服务自动化规则，也服务右键菜单）。
func invoker(t *testing.T) plugin.Invoker {
	t.Helper()
	got, ok := bark.New().(plugin.Invoker)
	require.True(t, ok, "bark 要实现 plugin.Invoker（界面右键菜单直调）")
	return got
}

// TestContributions 三条界面贡献，动作必须全部复用已有的 notify（不许另造动作）。
func TestContributions(t *testing.T) {
	provider, ok := bark.New().(plugin.ContributionsProvider)
	require.True(t, ok, "bark 要实现 plugin.ContributionsProvider")
	items := provider.Contributions()
	require.Len(t, items, 3, "条目右键 / 订阅右键 / 过滤规则编辑器底部各一条")

	want := map[string]plugin.Surface{
		"push-entry":   plugin.SurfaceEntryContextMenu,
		"push-feed":    plugin.SurfaceFeedContextMenu,
		"push-on-save": plugin.SurfaceFilterEditorFooter,
	}
	seen := map[string]bool{}
	for _, item := range items {
		surface, ok := want[item.ID]
		require.True(t, ok, "多出未预期的贡献项 %q", item.ID)
		require.Equal(t, surface, item.Surface)
		require.Equal(t, "notify", item.Action, "贡献项必须落到已有的 notify 动作上")
		require.NotEmpty(t, item.Label)
		seen[item.ID] = true
	}
	require.Len(t, seen, 3, "三条贡献的 id 不许重复")
}

// TestInvoke_SingleEntry ① 单选 1 条 → 假服务收到 1 条 POST，title = 条目标题。
func TestInvoke_SingleEntry(t *testing.T) {
	ctx := context.Background()
	srv, calls := newFakeBark(t, http.StatusOK, `{"code":200}`)
	bark.Configure(srv.Client(), &fakeStore{})

	result, err := invoker(t).Invoke(ctx, plugin.InvokeRequest{
		Action:    "notify",
		Surface:   plugin.SurfaceEntryContextMenu,
		Selection: plugin.Selection{EntryIDs: []int64{7}},
		Config:    map[string]string{"url": srv.URL + "/KEY"},
		Entries:   []model.Entry{{ID: 7, FeedID: 3, Title: ptr("新文章"), URL: ptr("https://example.com/1")}},
		Feeds:     []model.Feed{{ID: 3, Title: "少数派"}},
	})
	require.NoError(t, err)
	require.Len(t, *calls, 1, "单选只发一条")
	require.Equal(t, "success", result.Level)

	var payload struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		URL   string `json:"url"`
		Group string `json:"group"`
	}
	require.NoError(t, json.Unmarshal([]byte((*calls)[0].body), &payload))
	// 报文口径与自动化动作共用同一份构造：title = 条目标题；body = 来源 · 规则「名」；group 固定。
	require.Equal(t, "新文章", payload.Title)
	require.Equal(t, "少数派 · 规则「手动推送」", payload.Body, "界面直调没有规则，规则名用「手动推送」")
	require.Equal(t, "https://example.com/1", payload.URL)
	require.Equal(t, "Krss 自动化", payload.Group)
	require.Equal(t, "krss-notify/1", (*calls)[0].ua)
}

// TestInvoke_MultiEntries ② 多选 3 条 → 收到 3 条，Message == "已推送 3 条"。
func TestInvoke_MultiEntries(t *testing.T) {
	ctx := context.Background()
	srv, calls := newFakeBark(t, http.StatusOK, `{"code":200}`)
	bark.Configure(srv.Client(), &fakeStore{})

	entries := []model.Entry{
		{ID: 1, Title: ptr("一"), URL: ptr("https://example.com/1")},
		{ID: 2, Title: ptr("二"), URL: ptr("https://example.com/2")},
		{ID: 3, Title: ptr("三"), URL: ptr("https://example.com/3")},
	}
	result, err := invoker(t).Invoke(ctx, plugin.InvokeRequest{
		Action:    "notify",
		Surface:   plugin.SurfaceEntryContextMenu,
		Selection: plugin.Selection{EntryIDs: []int64{1, 2, 3}},
		// 规则名由宿主从过滤规则编辑器带进来（没有规则时为空 ⇒ 手动推送）。
		Config:  map[string]string{"url": srv.URL + "/KEY", "ruleName": "我的规则"},
		Entries: entries,
	})
	require.NoError(t, err)
	require.Len(t, *calls, 3, "三条各发一条")
	require.Equal(t, "已推送 3 条", result.Message)
	require.Equal(t, "success", result.Level)

	var payload struct {
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	require.NoError(t, json.Unmarshal([]byte((*calls)[1].body), &payload))
	require.Equal(t, "二", payload.Title, "标题跟着各自条目走")
	require.Equal(t, "规则「我的规则」", payload.Body, "没有来源时 body 只剩规则名")
}

// TestInvoke_NoEntries ③ 没条目（只有 id 没明细）→ 报错且 0 请求（v1 不去库里补明细）。
func TestInvoke_NoEntries(t *testing.T) {
	ctx := context.Background()
	srv, calls := newFakeBark(t, http.StatusOK, `{"code":200}`)
	bark.Configure(srv.Client(), &fakeStore{})

	result, err := invoker(t).Invoke(ctx, plugin.InvokeRequest{
		Action:    "notify",
		Surface:   plugin.SurfaceEntryContextMenu,
		Selection: plugin.Selection{EntryIDs: []int64{7, 8}},
		Config:    map[string]string{"url": srv.URL + "/KEY"},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "没有选中条目")
	require.Empty(t, result.Message)
	require.Empty(t, *calls, "没条目不该发出任何请求")
}
