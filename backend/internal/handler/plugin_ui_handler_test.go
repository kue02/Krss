package handler_test

import (
	"io/fs"
	"net/http"
	"testing"
	"testing/fstest"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/require"

	"krss/backend/internal/handler"
	"krss/backend/internal/plugin"
	"krss/backend/internal/service"
)

// uiAssetsPlugin test-only 假插件：自带一份界面资源（56-24）。
// perm 由用例决定 —— 没有 ui:custom 的插件就算有资源也不许被加载。
type uiAssetsPlugin struct {
	id   string
	perm []string
	fsys fs.FS
}

func (p uiAssetsPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: p.id, Name: p.id, Builtin: true, Permissions: p.perm}
}
func (p uiAssetsPlugin) Actions() []plugin.Action                   { return nil }
func (p uiAssetsPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p uiAssetsPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p uiAssetsPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }
func (p uiAssetsPlugin) UIAssets() fs.FS                            { return p.fsys }

const uiIndexHTML = "<!doctype html><title>ui-demo</title>"

func uiDemoFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte(uiIndexHTML)},
		"app.js":     &fstest.MapFile{Data: []byte("console.log('ui-demo')")},
	}
}

// newUIServer 真注册表 + 真 service 挂到 echo 上：验「路由 → 门禁 → FileServer → 响应头」整条链。
func newUIServer(t *testing.T) (*echo.Echo, *plugin.Registry) {
	t.Helper()
	registry := plugin.NewRegistry()
	require.NoError(t, registry.Register(uiAssetsPlugin{
		id: "ui-demo", perm: []string{plugin.PermissionUICustom}, fsys: uiDemoFS(),
	}))
	// 有资源但没声明 ui:custom：不许通过
	require.NoError(t, registry.Register(uiAssetsPlugin{id: "ui-noperm", fsys: uiDemoFS()}))
	svc := service.NewPluginService(registry, nil, nil)
	e := echo.New()
	handler.NewPluginHandler(svc).RegisterRoutes(e.Group("/api"))
	return e, registry
}

// TestPluginUIHandler_Builtin 内置插件的资源能被服务出来，并带沙箱响应头；
// /ui/ 与 /ui 目录访问补成 index.html。
func TestPluginUIHandler_Builtin(t *testing.T) {
	e, _ := newUIServer(t)

	rec := doJSON(e, http.MethodGet, "/api/plugins/ui-demo/ui/index.html", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, uiIndexHTML, rec.Body.String())
	require.Contains(t, rec.Header().Get("Content-Type"), "text/html")
	// 沙箱三条头：CSP 限死外链与出网、nosniff、插件更新后不许拿旧页
	require.Equal(t, "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; img-src 'self' data: blob:",
		rec.Header().Get("Content-Security-Policy"))
	require.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))

	// 目录访问 = index.html（前端 iframe 的 src 就是这个）
	for _, target := range []string{"/api/plugins/ui-demo/ui/", "/api/plugins/ui-demo/ui"} {
		rec = doJSON(e, http.MethodGet, target, "")
		require.Equal(t, http.StatusOK, rec.Code, target+" → "+rec.Body.String())
		require.Equal(t, uiIndexHTML, rec.Body.String(), target)
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"), target)
	}

	// 子资源照常服务（CSP 里的 default-src 'self' 就是给它们用的）
	rec = doJSON(e, http.MethodGet, "/api/plugins/ui-demo/ui/app.js", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Header().Get("Content-Type"), "javascript")
	require.Equal(t, "console.log('ui-demo')", rec.Body.String())
}

// TestPluginUIHandler_NoPermission 没声明 ui:custom → 403，文案要说清是缺哪个权限。
func TestPluginUIHandler_NoPermission(t *testing.T) {
	e, _ := newUIServer(t)

	rec := doJSON(e, http.MethodGet, "/api/plugins/ui-noperm/ui/index.html", "")
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "ui:custom", "错误文案要告诉插件作者缺哪个权限")
	require.NotEqual(t, "no-store", rec.Header().Get("Cache-Control"), "403 不该带上资源响应头")
}

// TestPluginUIHandler_Disabled 停用的插件 409（与 /settings、/invoke、/data 同口径）。
func TestPluginUIHandler_Disabled(t *testing.T) {
	e, registry := newUIServer(t)
	require.True(t, registry.SetEnabled("ui-demo", false))

	rec := doJSON(e, http.MethodGet, "/api/plugins/ui-demo/ui/index.html", "")
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "plugin disabled")
}

// TestPluginUIHandler_Traversal 路径穿越（明文 / 编码两种写法）一律 400，绝不落到 FileServer。
func TestPluginUIHandler_Traversal(t *testing.T) {
	e, _ := newUIServer(t)

	for _, target := range []string{
		"/api/plugins/ui-demo/ui/../secret",
		"/api/plugins/ui-demo/ui/%2e%2e/secret",
		"/api/plugins/ui-demo/ui/sub/../../secret",
		"/api/plugins/ui-demo/ui//etc/passwd",
	} {
		rec := doJSON(e, http.MethodGet, target, "")
		require.Equal(t, http.StatusBadRequest, rec.Code, target+" → "+rec.Body.String())
		require.NotContains(t, rec.Body.String(), "ui-demo</title>", target+" 不该服务出任何文件")
	}

	// 未知插件 404（不是 400，也不是 500）
	rec := doJSON(e, http.MethodGet, "/api/plugins/ghost/ui/index.html", "")
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
}
