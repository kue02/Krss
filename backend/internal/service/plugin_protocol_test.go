package service

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
)

// newMetaUnixServer 起一个监听 Unix socket 的假插件进程（只实现 /ready 与 /meta），
// 返回 socket 路径。用于在不真编译子进程的前提下测 registerLocked 的协议版本校验。
func newMetaUnixServer(t *testing.T, meta map[string]interface{}) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "krss-meta-*")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "plugin.sock")
	ln, err := net.Listen("unix", sock)
	require.NoError(t, err)

	mux := http.NewServeMux()
	mux.HandleFunc("/ready", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/meta", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(meta)
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return sock
}

func registerFakeMetaPlugin(t *testing.T, reg *plugin.Registry, meta map[string]interface{}) error {
	t.Helper()
	sock := newMetaUnixServer(t, meta)
	dir := filepath.Dir(sock)
	h := NewPluginHost(reg, nil, dir)
	p := &externalPluginProcess{
		id:         "fake-meta",
		dir:        dir,
		socketPath: sock,
		token:      "tok",
		client:     plugin.NewRemoteClient(sock, "tok"),
	}
	return h.registerLocked(p)
}

// 插件运行时安全：宿主注册 apiVersion=0 的旧插件 ⇒ 报明确的「协议版本不兼容」错误。
func TestRegisterLocked_RejectsIncompatibleAPIVersion(t *testing.T) {
	reg := plugin.NewRegistry()
	err := registerFakeMetaPlugin(t, reg, map[string]interface{}{
		"id": "fake-meta", "name": "旧插件", "version": "0.1.0", "apiVersion": 0,
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "插件协议版本不兼容：需要 v1，插件报 v0")
	_, exists := reg.Meta("fake-meta")
	require.False(t, exists, "版本不兼容不注册")
}

// 插件运行时安全：apiVersion=1 与宿主一致 ⇒ 正常注册。
func TestRegisterLocked_AcceptsMatchingAPIVersion(t *testing.T) {
	reg := plugin.NewRegistry()
	err := registerFakeMetaPlugin(t, reg, map[string]interface{}{
		"id": "fake-meta", "name": "新插件", "version": "1.0.0", "apiVersion": plugin.ProtocolVersion,
	})
	require.NoError(t, err)
	meta, exists := reg.Meta("fake-meta")
	require.True(t, exists, "版本一致时正常注册")
	require.Equal(t, "新插件", meta.Name)
}
