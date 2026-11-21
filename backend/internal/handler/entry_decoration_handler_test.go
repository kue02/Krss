package handler_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/require"

	"krss/backend/internal/handler"
	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/service"
)

// entryDecoratorPlugin test-only 假插件：只声明一段正文装饰（56-21）。
type entryDecoratorPlugin struct {
	items []plugin.Decoration
}

func (entryDecoratorPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: "deco-demo", Name: "Deco", Builtin: true}
}
func (entryDecoratorPlugin) Actions() []plugin.Action                   { return nil }
func (entryDecoratorPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (entryDecoratorPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (entryDecoratorPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }
func (p entryDecoratorPlugin) Decorate(context.Context, plugin.DecorateRequest) ([]plugin.Decoration, error) {
	return p.items, nil
}

// decorationEntryRepo 只实现 GetByID 的条目读端（没有这条 = 取不到）。
type decorationEntryRepo struct {
	entries map[int64]model.Entry
}

func (r decorationEntryRepo) GetByID(_ context.Context, id int64) (model.Entry, error) {
	entry, ok := r.entries[id]
	if !ok {
		return model.Entry{}, errors.New("entry not found")
	}
	return entry, nil
}

// newDecorationServer 真注册表 + 真 service + 假条目读端挂到 echo 上：
// 这组用例要验「路由 → 参数 → 聚合 → 出参」，整条链跑真代码。
func newDecorationServer(t *testing.T, content string) (*echo.Echo, *plugin.Registry) {
	t.Helper()
	registry := plugin.NewRegistry()
	require.NoError(t, registry.Register(entryDecoratorPlugin{items: []plugin.Decoration{
		{ID: "hl", Start: 0, End: 2, Style: "highlight", Color: "#ffcc00"},
	}}))
	entries := decorationEntryRepo{entries: map[int64]model.Entry{42: {ID: 42, Content: &content}}}
	svc := service.NewPluginService(registry, nil, nil, service.WithInvokeRepos(entries, nil, nil))
	e := echo.New()
	handler.NewPluginHandler(svc).RegisterRoutes(e.Group("/api"))
	return e, registry
}

// TestEntryDecorations_HTTP GET /api/entries/:id/decorations 出参形状（handler 负责 []，不是 null）。
func TestEntryDecorations_HTTP(t *testing.T) {
	e, registry := newDecorationServer(t, "<p>现价：<b>¥0.00</b></p>")

	rec := doJSON(e, http.MethodGet, "/api/entries/42/decorations", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"decorations":[{"plugin":"deco-demo","id":"hl","start":0,"end":2,"style":"highlight","color":"#ffcc00","data":{"text":"现价"}}]}`, rec.Body.String())

	// 停用插件后同一条路由回空数组（不是 null）—— 阅读器直接遍历，不用判空。
	require.True(t, registry.SetEnabled("deco-demo", false))
	rec = doJSON(e, http.MethodGet, "/api/entries/42/decorations", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"decorations":[]}`, rec.Body.String())
}

// TestEntryDecorations_HTTP_UnknownEntry 条目不存在 → 200 空数组（装饰是可选装饰，不该让正文读不出来）。
func TestEntryDecorations_HTTP_UnknownEntry(t *testing.T) {
	e, _ := newDecorationServer(t, "<p>hi</p>")

	rec := doJSON(e, http.MethodGet, "/api/entries/999/decorations", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"decorations":[]}`, rec.Body.String())
}

// TestEntryDecorations_HTTP_BadID 非法 id → 400（与 /entries/:id 同口径）。
func TestEntryDecorations_HTTP_BadID(t *testing.T) {
	e, _ := newDecorationServer(t, "<p>hi</p>")

	rec := doJSON(e, http.MethodGet, "/api/entries/abc/decorations", "")
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "invalid id")
}
