package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/require"

	"krss/backend/internal/handler"
	"krss/backend/internal/plugin"
	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
	"krss/backend/internal/service"
)

// newPluginDataServer 真注册表 + 真 service + 真仓储（内存库）挂到 echo 上：
// 这组用例要验「路由 → 校验 → SQL → 出参」整条链，mock 只能验转手。
func newPluginDataServer(t *testing.T) (*echo.Echo, *plugin.Registry) {
	t.Helper()
	registry := plugin.NewRegistry()
	require.NoError(t, registry.Register(contributionsPlugin{}))
	dataRepo := repository.NewPluginDataRepository(testutil.NewTestDB(t))
	svc := service.NewPluginService(registry, nil, nil, service.WithPluginDataRepo(dataRepo))
	e := echo.New()
	handler.NewPluginHandler(svc).RegisterRoutes(e.Group("/api"))
	return e, registry
}

// doJSON 发一个（可选带 body 的）请求，返回 recorder。
func doJSON(e *echo.Echo, method, target, body string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

// TestPluginDataHandler_PutGet PUT 写 → GET 读回同一份值；没写过的键 404。
func TestPluginDataHandler_PutGet(t *testing.T) {
	e, _ := newPluginDataServer(t)

	rec := doJSON(e, http.MethodPut, "/api/plugins/contrib-demo/data/kv/probe", `{"value":"{\"ok\":true}"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"key":"probe","value":"{\"ok\":true}"}`, rec.Body.String())

	rec = doJSON(e, http.MethodGet, "/api/plugins/contrib-demo/data/kv/probe", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"key":"probe","value":"{\"ok\":true}"}`, rec.Body.String())

	// 覆盖写：同键再 PUT，读出来是新值（不是两行）。
	rec = doJSON(e, http.MethodPut, "/api/plugins/contrib-demo/data/kv/probe", `{"value":"{\"ok\":false}"}`)
	require.Equal(t, http.StatusOK, rec.Code)

	rec = doJSON(e, http.MethodGet, "/api/plugins/contrib-demo/data/kv/probe", "")
	require.JSONEq(t, `{"key":"probe","value":"{\"ok\":false}"}`, rec.Body.String())

	// 没写过的键 → 404（不是 500，也不是空串）。
	rec = doJSON(e, http.MethodGet, "/api/plugins/contrib-demo/data/kv/ghost", "")
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
}

// TestPluginDataHandler_List 列举：?prefix= 过滤、?limit= 生效、空 collection 回 {}（不是 null）。
func TestPluginDataHandler_List(t *testing.T) {
	e, _ := newPluginDataServer(t)

	// 空 collection：{} —— 前端要能直接遍历。
	rec := doJSON(e, http.MethodGet, "/api/plugins/contrib-demo/data/kv", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"values":{}}`, rec.Body.String())

	for _, key := range []string{"feed:1", "feed:2", "other"} {
		require.Equal(t, http.StatusOK, doJSON(e, http.MethodPut, "/api/plugins/contrib-demo/data/kv/"+key, `{"value":"`+key+`"}`).Code)
	}

	rec = doJSON(e, http.MethodGet, "/api/plugins/contrib-demo/data/kv", "")
	require.Equal(t, http.StatusOK, rec.Code)
	var all struct {
		Values map[string]string `json:"values"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &all))
	require.Len(t, all.Values, 3)

	// listOf 每次拿新的 struct（json.Unmarshal 往非 nil map 里是「合并」，复用会串上一次的结果）。
	listOf := func(target string) map[string]string {
		rec := doJSON(e, http.MethodGet, target, "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var resp struct {
			Values map[string]string `json:"values"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
		return resp.Values
	}

	// prefix 过滤
	require.Equal(t, map[string]string{"feed:1": "feed:1", "feed:2": "feed:2"},
		listOf("/api/plugins/contrib-demo/data/kv?prefix=feed:"))

	// limit 生效
	require.Len(t, listOf("/api/plugins/contrib-demo/data/kv?limit=1"), 1)

	// limit 传垃圾值：当缺省处理，不 500。
	require.Len(t, listOf("/api/plugins/contrib-demo/data/kv?limit=abc"), 3)
}

// TestPluginDataHandler_Delete 删单个键 → 204，再读 404；删整 collection → 204，collection 清空、别的 collection 不动。
func TestPluginDataHandler_Delete(t *testing.T) {
	e, _ := newPluginDataServer(t)

	require.Equal(t, http.StatusOK, doJSON(e, http.MethodPut, "/api/plugins/contrib-demo/data/kv/a", `{"value":"1"}`).Code)
	rec := doJSON(e, http.MethodDelete, "/api/plugins/contrib-demo/data/kv/a", "")
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	require.Empty(t, rec.Body.String(), "204 不许带 body")

	rec = doJSON(e, http.MethodGet, "/api/plugins/contrib-demo/data/kv/a", "")
	require.Equal(t, http.StatusNotFound, rec.Code)

	// 删已经不存在的键 → 404（要删的东西不在了）。
	require.Equal(t, http.StatusNotFound, doJSON(e, http.MethodDelete, "/api/plugins/contrib-demo/data/kv/a", "").Code)

	// 整 collection：两个键一起清，另一个 collection 留着。
	require.Equal(t, http.StatusOK, doJSON(e, http.MethodPut, "/api/plugins/contrib-demo/data/kv/b", `{"value":"2"}`).Code)
	require.Equal(t, http.StatusOK, doJSON(e, http.MethodPut, "/api/plugins/contrib-demo/data/kv/c", `{"value":"3"}`).Code)
	require.Equal(t, http.StatusOK, doJSON(e, http.MethodPut, "/api/plugins/contrib-demo/data/keep/b", `{"value":"4"}`).Code)

	rec = doJSON(e, http.MethodDelete, "/api/plugins/contrib-demo/data/kv", "")
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	rec = doJSON(e, http.MethodGet, "/api/plugins/contrib-demo/data/kv", "")
	require.JSONEq(t, `{"values":{}}`, rec.Body.String())
	rec = doJSON(e, http.MethodGet, "/api/plugins/contrib-demo/data/keep/b", "")
	require.Equal(t, http.StatusOK, rec.Code, "别的 collection 不该被连带删掉")

	// 再删一次空 collection：幂等 204。
	require.Equal(t, http.StatusNoContent, doJSON(e, http.MethodDelete, "/api/plugins/contrib-demo/data/kv", "").Code)
}

// TestPluginDataHandler_InvalidInput 越界一律 400：collection 名非法、值超 256KB、请求体坏掉。
func TestPluginDataHandler_InvalidInput(t *testing.T) {
	e, _ := newPluginDataServer(t)

	// collection：^[a-z0-9_-]{1,32}$ ⇒ 大写 / 空格 / 中文 / 太长都不认。
	for _, bad := range []string{"Upper", "bad%20name", "%E4%B8%AD%E6%96%87", strings.Repeat("a", 33)} {
		rec := doJSON(e, http.MethodGet, "/api/plugins/contrib-demo/data/"+bad, "")
		require.Equal(t, http.StatusBadRequest, rec.Code, "collection=%s body=%s", bad, rec.Body.String())
	}

	// 值超 256KB → 400（不是 500，也不是静默截断）。
	big, err := json.Marshal(map[string]string{"value": strings.Repeat("a", repository.PluginDataMaxValueBytes+1)})
	require.NoError(t, err)
	rec := doJSON(e, http.MethodPut, "/api/plugins/contrib-demo/data/kv/big", string(big))
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())

	// 请求体不是 JSON → 400。
	rec = doJSON(e, http.MethodPut, "/api/plugins/contrib-demo/data/kv/probe", "{not json")
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// TestPluginDataHandler_PluginNotFoundOrDisabled 插件不存在 404、停用 409（与 /settings、/invoke 同口径）。
func TestPluginDataHandler_PluginNotFoundOrDisabled(t *testing.T) {
	e, registry := newPluginDataServer(t)

	rec := doJSON(e, http.MethodGet, "/api/plugins/ghost/data/kv/probe", "")
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "plugin not found")

	require.True(t, registry.SetEnabled("contrib-demo", false))
	rec = doJSON(e, http.MethodGet, "/api/plugins/contrib-demo/data/kv/probe", "")
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "plugin disabled")
}
