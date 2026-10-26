package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"krss/backend/internal/handler"
	"krss/backend/internal/plugin"
	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"
)

// newPluginTestContext 起一个带 JSON body 的 echo 上下文（自包含，不改既有测试文件）。
func newPluginTestContext(method, target string, body interface{}, paramNames ...string) (echo.Context, *httptest.ResponseRecorder) {
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			panic(err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	e := echo.New()
	c := e.NewContext(req, rec)
	if len(paramNames) > 0 {
		c.SetParamNames(paramNames...)
	}
	return c, rec
}

func demoCatalog() []plugin.CatalogItem {
	return []plugin.CatalogItem{{
		Meta:    plugin.Meta{ID: "demo", Name: "Demo", Description: "样板", Version: "1.0.0", Builtin: true},
		Enabled: true,
		Actions: []plugin.ActionMeta{{
			PluginID: "demo", PluginName: "Demo", ActionID: "log", Label: "写一条调试日志（demo）", Enabled: true,
			Fields: []plugin.Field{{Key: "note", Label: "附带一句话（可选）", Type: "text"}},
		}},
	}}
}

// TestPluginHandler_List 清单接口：200 且插件/动作元数据在位。
func TestPluginHandler_List(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := mock.NewMockPluginService(ctrl)
	svc.EXPECT().Catalog(gomock.Any()).Return(demoCatalog(), nil)

	h := handler.NewPluginHandler(svc)
	c, rec := newPluginTestContext(http.MethodGet, "/api/plugins", nil)
	require.NoError(t, h.List(c))
	require.Equal(t, http.StatusOK, rec.Code)

	var resp struct {
		Plugins []struct {
			ID      string `json:"id"`
			Enabled bool   `json:"enabled"`
			Actions []struct {
				PluginID string `json:"pluginId"`
				ActionID string `json:"actionId"`
				Label    string `json:"label"`
				Enabled  bool   `json:"enabled"`
			} `json:"actions"`
		} `json:"plugins"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp.Plugins, 1)
	require.Equal(t, "demo", resp.Plugins[0].ID)
	require.True(t, resp.Plugins[0].Enabled)
	require.Len(t, resp.Plugins[0].Actions, 1)
	require.Equal(t, "demo", resp.Plugins[0].Actions[0].PluginID)
	require.Equal(t, "log", resp.Plugins[0].Actions[0].ActionID)
	require.True(t, resp.Plugins[0].Actions[0].Enabled)
}

// TestPluginHandler_SetEnabled 启停：把 enabled=false 带给 service，回包反映新状态。
func TestPluginHandler_SetEnabled(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	disabled := demoCatalog()
	disabled[0].Enabled = false

	svc := mock.NewMockPluginService(ctrl)
	svc.EXPECT().SetEnabled(gomock.Any(), "demo", false).Return(disabled, nil)

	h := handler.NewPluginHandler(svc)
	c, rec := newPluginTestContext(http.MethodPatch, "/api/plugins/demo", map[string]bool{"enabled": false}, "id")
	c.SetParamValues("demo")
	require.NoError(t, h.SetEnabled(c))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"enabled":false`)
}

// TestPluginHandler_SetEnabled_NotFound 插件不存在 → 404（不是 500）。
func TestPluginHandler_SetEnabled_NotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := mock.NewMockPluginService(ctrl)
	svc.EXPECT().SetEnabled(gomock.Any(), "ghost", true).Return(nil, service.ErrPluginNotFound)

	h := handler.NewPluginHandler(svc)
	c, rec := newPluginTestContext(http.MethodPatch, "/api/plugins/ghost", map[string]bool{"enabled": true}, "id")
	c.SetParamValues("ghost")
	require.NoError(t, h.SetEnabled(c))
	require.Equal(t, http.StatusNotFound, rec.Code)
}

// TestPluginHandler_GetSettings 读设置：secret 字段出接口是掩码。
func TestPluginHandler_GetSettings(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := mock.NewMockPluginService(ctrl)
	svc.EXPECT().GetSettings(gomock.Any(), "bark").Return(
		service.PluginSettingsResult{Values: map[string]string{"url": service.PluginMaskedValue}}, nil)

	h := handler.NewPluginHandler(svc)
	c, rec := newPluginTestContext(http.MethodGet, "/api/plugins/bark/settings", nil, "id")
	c.SetParamValues("bark")
	require.NoError(t, h.GetSettings(c))
	require.Equal(t, http.StatusOK, rec.Code)

	var resp struct {
		Values map[string]string `json:"values"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Equal(t, service.PluginMaskedValue, resp.Values["url"])
}

// TestPluginHandler_PutSettings 写设置：values 原样交给 service，回包仍是掩码。
func TestPluginHandler_PutSettings(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := mock.NewMockPluginService(ctrl)
	svc.EXPECT().PutSettings(gomock.Any(), "bark", map[string]string{"url": "https://api.day.app/NEW"}).
		Return(service.PluginSettingsResult{Values: map[string]string{"url": service.PluginMaskedValue}}, nil)

	h := handler.NewPluginHandler(svc)
	c, rec := newPluginTestContext(http.MethodPut, "/api/plugins/bark/settings",
		map[string]map[string]string{"values": {"url": "https://api.day.app/NEW"}}, "id")
	c.SetParamValues("bark")
	require.NoError(t, h.PutSettings(c))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "••••••••")
}

// TestPluginHandler_TestAction 动作测试：成功 200；插件不存在 404；没配地址 400；真投递失败 502 且带原因。
func TestPluginHandler_TestAction(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := mock.NewMockPluginService(ctrl)
	svc.EXPECT().TestAction(gomock.Any(), "bark", "notify").Return(nil)
	svc.EXPECT().TestAction(gomock.Any(), "ghost", "notify").Return(service.ErrPluginNotFound)
	svc.EXPECT().TestAction(gomock.Any(), "bark", "notify").Return(service.ErrInvalid)
	svc.EXPECT().TestAction(gomock.Any(), "bark", "notify").
		Return(errors.New("先填全局推送地址再测试（HTTP 500，目标 api.day.app）"))

	h := handler.NewPluginHandler(svc)

	c, rec := newPluginTestContext(http.MethodPost, "/api/plugins/bark/actions/notify/test", nil, "id", "actionId")
	c.SetParamValues("bark", "notify")
	require.NoError(t, h.TestAction(c))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"status":200`)

	c2, rec2 := newPluginTestContext(http.MethodPost, "/api/plugins/ghost/actions/notify/test", nil, "id", "actionId")
	c2.SetParamValues("ghost", "notify")
	require.NoError(t, h.TestAction(c2))
	require.Equal(t, http.StatusNotFound, rec2.Code)

	// 没配地址 / 动作不可测 → 400（前端据此提示「先填地址」）
	c3, rec3 := newPluginTestContext(http.MethodPost, "/api/plugins/bark/actions/notify/test", nil, "id", "actionId")
	c3.SetParamValues("bark", "notify")
	require.NoError(t, h.TestAction(c3))
	require.Equal(t, http.StatusBadRequest, rec3.Code)

	// 真投递失败 → 502 + 插件给的原因（不能只回 internal error，用户要知道为什么没发出去）
	c4, rec4 := newPluginTestContext(http.MethodPost, "/api/plugins/bark/actions/notify/test", nil, "id", "actionId")
	c4.SetParamValues("bark", "notify")
	require.NoError(t, h.TestAction(c4))
	require.Equal(t, http.StatusBadGateway, rec4.Code)
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec4.Body.Bytes(), &body))
	require.Contains(t, body.Error, "api.day.app")
}

// TestPluginHandler_Rescan 重新扫描：与 List 同一份 Catalog。
func TestPluginHandler_Rescan(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := mock.NewMockPluginService(ctrl)
	svc.EXPECT().Catalog(gomock.Any()).Return(demoCatalog(), nil)

	h := handler.NewPluginHandler(svc)
	c, rec := newPluginTestContext(http.MethodPost, "/api/plugins/rescan", nil)
	require.NoError(t, h.Rescan(c))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"id":"demo"`)
}

// contributionsPlugin test-only 假插件：只声明一条合法的右键菜单项。
type contributionsPlugin struct{}

func (contributionsPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: "contrib-demo", Name: "Contrib Demo", Builtin: true}
}
func (contributionsPlugin) Actions() []plugin.Action                   { return nil }
func (contributionsPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (contributionsPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (contributionsPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }
func (contributionsPlugin) Contributions() []plugin.Contribution {
	return []plugin.Contribution{
		{ID: "demo-open", Surface: plugin.SurfaceEntryContextMenu, Action: "open", Label: "用 Demo 打开"},
	}
}

// newContributionsServer 真注册表 + 真 service 挂到 echo 上（本组用例要验「注册 → 启用 → 停用」整条链，
// 用 mock 只能验 handler 转手）。repos 传 nil —— Contributions 只读注册表，不碰库。
func newContributionsServer(t *testing.T) (*echo.Echo, *plugin.Registry) {
	t.Helper()
	registry := plugin.NewRegistry()
	require.NoError(t, registry.Register(contributionsPlugin{}))
	e := echo.New()
	handler.NewPluginHandler(service.NewPluginService(registry, nil, nil)).RegisterRoutes(e.Group("/api"))
	return e, registry
}

// TestPluginHandler_Contributions 启用的插件贡献 → 200 且按 surface 分组可见。
// 走真 HTTP 请求顺带证明 /plugins/contributions 没被 /plugins/:id 吃掉。
func TestPluginHandler_Contributions(t *testing.T) {
	e, _ := newContributionsServer(t)

	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/plugins/contributions", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	var resp struct {
		Surfaces map[string][]plugin.Contribution `json:"surfaces"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	items := resp.Surfaces[string(plugin.SurfaceEntryContextMenu)]
	require.Len(t, items, 1)
	require.Equal(t, "demo-open", items[0].ID)
	require.Equal(t, "open", items[0].Action)
	require.Equal(t, plugin.SelectionNone, items[0].Selection, "宿主补的默认 selection 要出得去")
}

// TestPluginHandler_Invoke 界面直调：200 原样回插件结果；动作不存在 404；surface 未声明 400；插件执行失败 502 且带原因。
func TestPluginHandler_Invoke(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := mock.NewMockPluginService(ctrl)
	svc.EXPECT().Invoke(gomock.Any(), "demo", "open", gomock.Any()).
		DoAndReturn(func(_ context.Context, _, _ string, req plugin.InvokeRequest) (plugin.InvokeResult, error) {
			// body 里的 surface / selection / config 要原样递给 service
			require.Equal(t, plugin.SurfaceEntryContextMenu, req.Surface)
			require.Equal(t, []int64{10}, req.Selection.EntryIDs)
			require.Equal(t, "v", req.Config["k"])
			return plugin.InvokeResult{Message: "ok"}, nil
		})
	svc.EXPECT().Invoke(gomock.Any(), "demo", "ghost", gomock.Any()).
		Return(plugin.InvokeResult{}, service.ErrPluginActionNotFound)
	svc.EXPECT().Invoke(gomock.Any(), "demo", "open", gomock.Any()).
		Return(plugin.InvokeResult{}, service.ErrPluginSurfaceUndeclared)
	svc.EXPECT().Invoke(gomock.Any(), "demo", "open", gomock.Any()).
		Return(plugin.InvokeResult{}, errors.New("推送失败：目标地址不可达（api.day.app）"))

	h := handler.NewPluginHandler(svc)
	body := map[string]any{
		"surface":   string(plugin.SurfaceEntryContextMenu),
		"selection": map[string]any{"entryIds": []int64{10}},
		"config":    map[string]string{"k": "v"},
	}

	call := func(actionID string) *httptest.ResponseRecorder {
		c, rec := newPluginTestContext(http.MethodPost, "/api/plugins/demo/actions/"+actionID+"/invoke", body, "id", "actionId")
		c.SetParamValues("demo", actionID)
		require.NoError(t, h.InvokePluginAction(c))
		return rec
	}

	// ① 正常：结果原样回给界面（插件自己给的文案）
	rec := call("open")
	require.Equal(t, http.StatusOK, rec.Code)
	require.JSONEq(t, `{"message":"ok"}`, rec.Body.String())

	// ② 动作不存在 → 404
	rec = call("ghost")
	require.Equal(t, http.StatusNotFound, rec.Code)

	// ③ 这个 surface 没声明 → 400
	rec = call("open")
	require.Equal(t, http.StatusBadRequest, rec.Code)

	// ④ 插件真执行失败 → 502 + 插件给的原因（不能只回 internal error）
	rec = call("open")
	require.Equal(t, http.StatusBadGateway, rec.Code)
	var errBody struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &errBody))
	require.Contains(t, errBody.Error, "api.day.app")
}

// TestPluginHandler_Invoke_BadBody 请求体不是 JSON → 400 统一错误（前端拿它当「参数坏了」）。
func TestPluginHandler_Invoke_BadBody(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := mock.NewMockPluginService(ctrl)
	h := handler.NewPluginHandler(svc)

	req := httptest.NewRequest(http.MethodPost, "/api/plugins/demo/actions/open/invoke",
		strings.NewReader("{not json"))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	e := echo.New()
	c := e.NewContext(req, rec)
	c.SetParamNames("id", "actionId")
	c.SetParamValues("demo", "open")

	require.NoError(t, h.InvokePluginAction(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.JSONEq(t, `{"error":"invalid request"}`, rec.Body.String())
}

// TestPluginHandler_InvokeRoute 路由在位：POST /api/plugins/:id/actions/:actionId/invoke 打到 InvokePluginAction。
func TestPluginHandler_InvokeRoute(t *testing.T) {
	e, _ := newContributionsServer(t)

	rec := httptest.NewRecorder()
	body := strings.NewReader(`{"surface":"app.command"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/plugins/contrib-demo/actions/open/invoke", body)
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	e.ServeHTTP(rec, req)

	// contrib-demo 没装这个动作 ⇒ 走真 service 回 404 且带我们的错误文案
	// （echo 自己的 404 是 {"message":"Not Found"} —— 有 "plugin action not found" 就证明路由打到了 handler）
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Contains(t, rec.Body.String(), "plugin action not found")
}

// TestPluginHandler_Contributions_Disabled 停用后 surfaces 必须是 {}（不是 null —— 前端要能直接遍历）。
func TestPluginHandler_Contributions_Disabled(t *testing.T) {
	e, registry := newContributionsServer(t)
	require.True(t, registry.SetEnabled("contrib-demo", false))

	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/plugins/contributions", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.NotContains(t, rec.Body.String(), "null", "空结果不许序列化成 null")
	require.JSONEq(t, `{"surfaces":{}}`, rec.Body.String())
}
