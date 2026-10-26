package sdk

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
)

const uiTestToken = "ui-token"

// uiTestPlugin 一个只有沙箱界面、别的扩展点全空的插件（外部插件的最小形态）。
type uiTestPlugin struct {
	assets fs.FS
}

func (uiTestPlugin) Meta() plugin.Meta                          { return plugin.Meta{ID: "ui-test", Name: "ui-test"} }
func (uiTestPlugin) Actions() []plugin.Action                   { return nil }
func (uiTestPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (uiTestPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (uiTestPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }
func (p uiTestPlugin) UIAssets() fs.FS                          { return p.assets }

// plainTestPlugin 不带界面的插件：/ui/ 只有 SDK 自己的 bridge.js。
type plainTestPlugin struct{ uiTestPlugin }

func (plainTestPlugin) UIAssets() fs.FS { return nil }

func newUITestHandler(t *testing.T, p plugin.Plugin) http.Handler {
	t.Helper()
	srv := &server{
		plugin: p,
		token:  uiTestToken,
		store:  newFileSettings(filepath.Join(t.TempDir(), "plugin.sock")),
	}
	return auth(uiTestToken, srv.routes())
}

func uiGet(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("X-Krss-Plugin-Token", uiTestToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestServerUI_ServesPluginAssets 外部插件的界面资源由 SDK 的 /ui/ 发（宿主把
// /api/plugins/:id/ui/* 原样代理过来）：目录根与 index.html 折成同一份、静态资源带对的类型。
func TestServerUI_ServesPluginAssets(t *testing.T) {
	assets := fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html><script src=\"./bridge.js\"></script>")},
		"app.js":     {Data: []byte("console.log('annotate')")},
	}
	h := newUITestHandler(t, uiTestPlugin{assets: assets})

	root := uiGet(t, h, "/ui/")
	require.Equal(t, http.StatusOK, root.Code)
	require.Equal(t, assets["index.html"].Data, root.Body.Bytes())
	require.Contains(t, root.Header().Get("Content-Type"), "text/html")
	require.Equal(t, "no-store", root.Header().Get("Cache-Control"))

	index := uiGet(t, h, "/ui/index.html")
	require.Equal(t, http.StatusOK, index.Code, "index.html 与目录根是同一份")
	require.Equal(t, root.Body.String(), index.Body.String())

	app := uiGet(t, h, "/ui/app.js")
	require.Equal(t, http.StatusOK, app.Code)
	require.Contains(t, app.Header().Get("Content-Type"), "javascript")
	require.Equal(t, assets["app.js"].Data, app.Body.Bytes())
}

// TestServerUI_ShipsBridgeJS bridge.js 由 SDK 发（真相源在 sdk/ui/bridge.js），
// 插件不用拷一份、也不能用自己的旧版本盖掉它；没自带界面的插件同样拿得到。
func TestServerUI_ShipsBridgeJS(t *testing.T) {
	assets := fstest.MapFS{
		"index.html": {Data: []byte("<html></html>")},
		"bridge.js":  {Data: []byte("window.krss = { stale: true };")},
	}
	h := newUITestHandler(t, uiTestPlugin{assets: assets})

	own := uiGet(t, h, "/ui/bridge.js")
	require.Equal(t, http.StatusOK, own.Code)
	require.Contains(t, own.Body.String(), "window.krss")
	require.NotContains(t, own.Body.String(), "stale", "插件目录里的旧 bridge.js 不许盖掉 SDK 版本")
	require.Contains(t, own.Header().Get("Content-Type"), "javascript")

	bare := newUITestHandler(t, plainTestPlugin{})
	require.Equal(t, http.StatusOK, uiGet(t, bare, "/ui/bridge.js").Code)
	require.Equal(t, http.StatusNotFound, uiGet(t, bare, "/ui/index.html").Code)
}

// TestServerUI_NotFoundAndMethod /ui/ 只服务已知资源：缺文件 404、非 GET 405。
func TestServerUI_NotFoundAndMethod(t *testing.T) {
	h := newUITestHandler(t, uiTestPlugin{assets: fstest.MapFS{"index.html": {Data: []byte("<html></html>")}}})

	require.Equal(t, http.StatusNotFound, uiGet(t, h, "/ui/missing.js").Code)

	req := httptest.NewRequest(http.MethodPost, "/ui/index.html", strings.NewReader(""))
	req.Header.Set("X-Krss-Plugin-Token", uiTestToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusMethodNotAllowed, rec.Code)

	// 未带 token 一样进不来（/ui/ 不是裸奔的口子）
	req = httptest.NewRequest(http.MethodGet, "/ui/index.html", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

// 编译期确认测试替身真的满足宿主契约（否则测试测的是别的东西）。
var _ plugin.Plugin = uiTestPlugin{}
var _ plugin.UIAssets = uiTestPlugin{}
