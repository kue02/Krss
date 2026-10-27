package sdk_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin/sdk"
)

// TestData_UsesHostAPIWithPluginToken 插件进程没有登录态，只能拿 spawn 时注入的 token
// 读写**自己**的 data（56-32 单库）：路径必须带自己的 id、必须带 X-Krss-Plugin-Token。
func TestData_UsesHostAPIWithPluginToken(t *testing.T) {
	var gotPath, gotToken, gotMethod, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotToken, gotMethod = r.URL.Path, r.Header.Get("X-Krss-Plugin-Token"), r.Method
		if r.Method == http.MethodPut {
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			gotBody = body["value"]
			_ = json.NewEncoder(w).Encode(map[string]string{"key": "k", "value": gotBody})
			return
		}
		if r.URL.Path == "/api/plugins/annotate/data/annotations" {
			_ = json.NewEncoder(w).Encode(map[string]any{"values": map[string]string{"1": "x"}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"key": "k", "value": "stored"})
	}))
	defer server.Close()

	t.Setenv("KRSS_PLUGIN_API", server.URL)
	t.Setenv("KRSS_PLUGIN_TOKEN", "token-1234567890abcdef")
	t.Setenv("KRSS_PLUGIN_ID", "annotate")

	data := sdk.NewData()
	require.True(t, data.Usable())

	require.NoError(t, data.Put(context.Background(), "annotations", "2114685590489272320", `[{"start":1}]`))
	require.Equal(t, "/api/plugins/annotate/data/annotations/2114685590489272320", gotPath)
	require.Equal(t, "token-1234567890abcdef", gotToken)
	require.Equal(t, http.MethodPut, gotMethod)
	require.JSONEq(t, `[{"start":1}]`, gotBody)

	value, ok, err := data.Get(context.Background(), "annotations", "2114685590489272320")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "stored", value)

	values, err := data.List(context.Background(), "annotations", "")
	require.NoError(t, err)
	require.Equal(t, "x", values["1"])
}

// TestData_UnusableWithoutHostEnv 单独跑插件（没有宿主注入）时要「不可用」而不是 panic。
func TestData_UnusableWithoutHostEnv(t *testing.T) {
	t.Setenv("KRSS_PLUGIN_API", "")
	t.Setenv("KRSS_PLUGIN_TOKEN", "")
	t.Setenv("KRSS_PLUGIN_ID", "")

	data := sdk.NewData()
	require.False(t, data.Usable())
	_, _, err := data.Get(context.Background(), "annotations", "1")
	require.Error(t, err, "没有宿主时要明确报错，不能静默当成空")
}
