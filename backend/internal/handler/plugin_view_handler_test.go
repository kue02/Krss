package handler_test

import (
	"net/http"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/require"

	"krss/backend/internal/handler"
	"krss/backend/internal/plugin"
	"krss/backend/internal/service"
)

// viewPlugin test-only 假插件：只注册视图（56-27）。
type viewPlugin struct {
	id    string
	perm  []string
	views []plugin.View
}

func (p viewPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: p.id, Name: p.id, Builtin: true, Permissions: p.perm}
}
func (p viewPlugin) Actions() []plugin.Action                   { return nil }
func (p viewPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p viewPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p viewPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }
func (p viewPlugin) Views() []plugin.View                       { return p.views }

func unreadTrue() *bool { v := true; return &v }

// newViewServer 真注册表 + 真 service 挂 echo：验「注册 → 清洗 → 聚合 → 出参」整条链。
func newViewServer(t *testing.T) (*echo.Echo, *plugin.Registry) {
	t.Helper()
	registry := plugin.NewRegistry()
	// aaa：一条合法声明式 + 一条合法自定义（声明了 ui:custom、带 Entry）
	require.NoError(t, registry.Register(viewPlugin{
		id: "view-aaa",
		perm: []string{
			plugin.PermissionUICustom,
		},
		views: []plugin.View{
			{ID: "unread", Label: "未读", Icon: "mail", Kind: "declarative", Layout: "list",
				Query: &plugin.ViewQuery{Unread: unreadTrue(), Sort: "newest"}},
			{ID: "radar", Label: "雷达", Kind: "custom", Entry: "index.html", Open: "reader"},
		},
	}))
	// bbb：custom 但没声明 ui:custom（绕过 → 丢）
	require.NoError(t, registry.Register(viewPlugin{
		id:   "view-bbb",
		perm: nil,
		views: []plugin.View{
			{ID: "sneaky", Label: "绕过", Kind: "custom", Entry: "index.html"},
		},
	}))
	// ccc：custom 声明了权限但没给 Entry（装了也打不开 → 丢）
	require.NoError(t, registry.Register(viewPlugin{
		id:   "view-ccc",
		perm: []string{plugin.PermissionUICustom},
		views: []plugin.View{
			{ID: "empty-entry", Label: "空入口", Kind: "custom"},
		},
	}))
	svc := service.NewPluginService(registry, nil, nil)
	e := echo.New()
	handler.NewPluginHandler(svc).RegisterRoutes(e.Group("/api"))
	return e, registry
}

// TestPluginViews_Declarative 合法声明式视图出现、宿主注入 plugin；custom 缺权限 / 缺 Entry 的都不在。
func TestPluginViews_Declarative(t *testing.T) {
	e, _ := newViewServer(t)

	rec := doJSON(e, http.MethodGet, "/api/plugins/views", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"views":[
		{"plugin":"view-aaa","id":"unread","label":"未读","icon":"mail","kind":"declarative","layout":"list",
		 "permissions":["ui:custom"],
		 "query":{"unread":true,"sort":"newest"}},
		{"plugin":"view-aaa","id":"radar","label":"雷达","kind":"custom","entry":"index.html","open":"reader",
		 "permissions":["ui:custom"]}
	]}`, rec.Body.String())
}

// TestPluginViews_CustomWithoutPermission custom 视图必须声明 ui:custom，否则丢弃（防止绕过 /ui/ 门禁）。
func TestPluginViews_CustomWithoutPermission(t *testing.T) {
	e, _ := newViewServer(t)

	rec := doJSON(e, http.MethodGet, "/api/plugins/views", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), "sneaky", "没声明 ui:custom 的自定义视图不许出现在清单里")
	require.NotContains(t, rec.Body.String(), "view-bbb")
}

// TestPluginViews_Disabled 停用的插件整体消失（都没了就是空数组，不是 null）。
func TestPluginViews_Disabled(t *testing.T) {
	e, registry := newViewServer(t)
	require.True(t, registry.SetEnabled("view-aaa", false))

	rec := doJSON(e, http.MethodGet, "/api/plugins/views", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"views":[]}`, rec.Body.String())
}

// TestPluginViews_CustomWithoutEntry custom 但没 Entry 的丢弃；非法 kind 降级成 declarative。
func TestPluginViews_CustomWithoutEntry(t *testing.T) {
	e, registry := newViewServer(t)
	require.NoError(t, registry.Register(viewPlugin{
		id:   "view-ddd",
		perm: []string{plugin.PermissionUICustom},
		views: []plugin.View{
			{ID: "weird-kind", Label: "怪 kind", Kind: "framework-of-the-day"},
			{ID: "no-kind", Label: "没写 kind"},
		},
	}))

	rec := doJSON(e, http.MethodGet, "/api/plugins/views", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), "empty-entry", "custom 缺 entry 要丢弃")
	require.Contains(t, rec.Body.String(), `"id":"weird-kind"`)
	require.Contains(t, rec.Body.String(), `"kind":"declarative"`, "非法 kind 降级成 declarative")
	require.Contains(t, rec.Body.String(), `"id":"no-kind"`)
}
