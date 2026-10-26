package service_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/service"
)

// 本文件用**真子进程**测外部插件宿主：现编 cmd/pluginsrv（demo 的外部轨），
// 丢进临时 plugins 目录，跑真 spawn / 真 Unix socket / 真信号。不 mock 网络。

var (
	pluginsrvOnce sync.Once
	pluginsrvBin  string
	pluginsrvErr  error
)

// pluginsrvBinary 现编外部插件二进制（只编一次，多个用例共用）。
func pluginsrvBinary(t *testing.T) string {
	t.Helper()
	pluginsrvOnce.Do(func() {
		dir, err := os.MkdirTemp("", "krss-plugin-bin-*")
		if err != nil {
			pluginsrvErr = err
			return
		}
		built := filepath.Join(dir, "pluginsrv")
		cmd := exec.Command("go", "build", "-o", built, "./cmd/pluginsrv")
		cmd.Dir = "../.." // backend/（测试 cwd = backend/internal/service）
		if out, err := cmd.CombinedOutput(); err != nil {
			pluginsrvErr = fmt.Errorf("go build ./cmd/pluginsrv: %v: %s", err, out)
			return
		}
		pluginsrvBin = built
	})
	require.NoError(t, pluginsrvErr)
	return pluginsrvBin
}

// installExternalPlugin 模拟「用户把插件文件夹丢进 plugins/」：
// 二进制 + plugin.json（manifest），autostart 由参数决定。
func installExternalPlugin(t *testing.T, pluginsDir, id, bin string, autostart bool) string {
	t.Helper()
	dir := filepath.Join(pluginsDir, id)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	raw, err := os.ReadFile(bin)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, id), raw, 0o755))
	manifest := fmt.Sprintf(
		`{"id":%q,"name":"Demo 外部插件","version":"1.0.0","transport":"http","entrypoint":"./%s","autostart":%t}`,
		id, id, autostart)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifest), 0o644))
	return dir
}

// installCrashPlugin 装一个「起来就 exit 1」的插件（验证看护退避与崩溃上限）。
func installCrashPlugin(t *testing.T, pluginsDir, id string) string {
	t.Helper()
	dir := filepath.Join(pluginsDir, id)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	script := filepath.Join(dir, id)
	require.NoError(t, os.WriteFile(script, []byte("#!/bin/sh\nexit 1\n"), 0o755))
	manifest := fmt.Sprintf(
		`{"id":%q,"name":"会崩的插件","version":"0.0.1","transport":"http","entrypoint":"./%s","autostart":true}`,
		id, id)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifest), 0o644))
	return dir
}

// newTestHost 起一个用临时插件目录的真宿主（快退避，测试不必等 30s）。
func newTestHost(t *testing.T, pluginsDir string, reg *plugin.Registry, repo *fakePluginRepo) *service.PluginHost {
	t.Helper()
	host := service.NewPluginHost(reg, repo, pluginsDir,
		service.WithPluginReadyTimeout(5*time.Second),
		service.WithPluginBackoff(20*time.Millisecond, 200*time.Millisecond),
		service.WithPluginStopGrace(2*time.Second),
	)
	t.Cleanup(host.Stop)
	return host
}

// waitUntil 轮询直到 cond 成立（看护是异步的，断言要等它发生）。
func waitUntil(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	require.FailNow(t, "等待超时："+what)
}

// TestPluginHost_InstallTakesEffectWithoutRestart 即装即用：目录里丢文件夹 ⇒ 不重启即在册、被拉起、动作真能执行。
func TestPluginHost_InstallTakesEffectWithoutRestart(t *testing.T) {
	ctx := context.Background()
	pluginsDir := shortTempDir(t)
	reg := plugin.NewRegistry()
	repo := newFakePluginRepo()
	host := newTestHost(t, pluginsDir, reg, repo)

	require.NoError(t, host.Ensure(ctx))
	_, exists := reg.Meta("demo-ext")
	require.False(t, exists, "安装前不在册")

	installExternalPlugin(t, pluginsDir, "demo-ext", pluginsrvBinary(t), true)
	require.NoError(t, host.Ensure(ctx))

	meta, exists := reg.Meta("demo-ext")
	require.True(t, exists, "不重启即在册")
	require.Equal(t, "http", meta.Transport, "外部插件标 http")
	require.False(t, meta.Builtin, "外部插件不是内置")
	require.True(t, reg.Enabled("demo-ext"), "autostart=true ⇒ 直接启用")
	require.Equal(t, true, repo.states["demo-ext"], "发现即落库")

	action, ok := reg.LookupAction("demo-ext", "log")
	require.True(t, ok, "动作已包成内置同形")
	require.NoError(t, action.Execute(ctx, plugin.ActionRequest{Config: map[string]string{"note": "hot"}}),
		"真 socket 真执行")

	// 阅读期处理与失败归类也走同一条 socket（适配器形状与内置一模一样）
	processors := reg.EntryProcessors()
	require.Len(t, processors, 1, "阅读期处理器已注册")
	processed, err := processors[0].Process(model.Entry{})
	require.NoError(t, err)
	require.NotNil(t, processed.Content)
	require.Contains(t, *processed.Content, "demo 插件处理过本条")
	classifiers := reg.FetchClassifiers()
	require.Len(t, classifiers, 1, "失败归类器已注册")
	require.Empty(t, classifiers[0].Classify(ctx, model.Feed{}, 500, []byte("boom"), nil), "demo 分类器不认")

	// 插件设置也走真进程（settings.json 在插件目录）
	values, err := host.GetSettings(ctx, "demo-ext")
	require.NoError(t, err)
	require.NotNil(t, values)
	_, err = host.PutSettings(ctx, "demo-ext", map[string]string{"note": "hello-hot"})
	require.NoError(t, err)
	values, err = host.GetSettings(ctx, "demo-ext")
	require.NoError(t, err)
	require.Equal(t, "hello-hot", values["note"])

	// 卸载 = 删目录 ⇒ 下次扫描摘掉、进程被收走
	require.NoError(t, os.RemoveAll(filepath.Join(pluginsDir, "demo-ext")))
	state, ok := host.State("demo-ext")
	require.True(t, ok)
	pid := state.PID
	require.NoError(t, host.Ensure(ctx))
	_, exists = reg.Meta("demo-ext")
	require.False(t, exists, "目录没了 ⇒ 摘除")
	waitUntil(t, 5*time.Second, "进程被杀", func() bool { return processGone(pid) })
}

// TestPluginHost_CrashRestartsAndCapsOut 崩了自动重启；连崩 ≥5 次 ⇒ crashed、不再拉起、清单带 lastError。
func TestPluginHost_CrashRestartsAndCapsOut(t *testing.T) {
	ctx := context.Background()
	pluginsDir := shortTempDir(t)
	reg := plugin.NewRegistry()
	repo := newFakePluginRepo()
	host := newTestHost(t, pluginsDir, reg, repo)

	installCrashPlugin(t, pluginsDir, "crashy")
	// 首次就起不来：Ensure 不该把整个清单接口搞挂（错在插件不在宿主）
	require.NoError(t, host.Ensure(ctx))

	waitUntil(t, 5*time.Second, "自动重启发生", func() bool {
		st, ok := host.State("crashy")
		return ok && st.Restarts >= 1
	})
	waitUntil(t, 10*time.Second, "连崩到上限后 retired", func() bool {
		st, ok := host.State("crashy")
		return ok && st.Crashed
	})

	st, ok := host.State("crashy")
	require.True(t, ok)
	require.GreaterOrEqual(t, st.Restarts, 5, "连续崩 ≥5 次")
	require.NotEmpty(t, st.LastError, "崩溃原因留在 state")

	// 封顶后不再拉起：再扫一次也不许复活
	require.NoError(t, host.Ensure(ctx))
	st2, ok := host.State("crashy")
	require.True(t, ok)
	require.Equal(t, st.Restarts, st2.Restarts, "crashed 后不再重启")

	// Catalog 带 lastError（UI 显示「已崩溃」）：判死的插件不会凭空消失。
	items := reg.Catalog()
	require.Len(t, items, 1)
	require.Equal(t, "crashy", items[0].ID)
	host.Decorate(items)
	require.Contains(t, items[0].LastError, "已崩溃")
	require.Contains(t, items[0].LastError, "崩溃")
}

// TestPluginHost_DisableKillsProcess 停用 ⇒ 进程真没了（SIGTERM 后等它退出），再启用 ⇒ 又起来。
func TestPluginHost_DisableKillsProcess(t *testing.T) {
	ctx := context.Background()
	pluginsDir := shortTempDir(t)
	reg := plugin.NewRegistry()
	repo := newFakePluginRepo()
	host := newTestHost(t, pluginsDir, reg, repo)
	svc := service.NewPluginService(reg, repo, newSettingsStub(), service.WithPluginHost(host))

	installExternalPlugin(t, pluginsDir, "demo-ext", pluginsrvBinary(t), true)
	require.NoError(t, host.Ensure(ctx))

	st, ok := host.State("demo-ext")
	require.True(t, ok)
	require.NotZero(t, st.PID)
	require.NoError(t, syscall.Kill(st.PID, 0), "停用前进程活着")

	// 走 service 真链路（PATCH /api/plugins/demo-ext {enabled:false} 的落点）
	_, err := svc.SetEnabled(ctx, "demo-ext", false)
	require.NoError(t, err)
	require.False(t, repo.states["demo-ext"], "停用落库")
	require.True(t, processGone(st.PID), "SIGTERM 后进程真的没了")
	// 停用 ≠ 消失：壳还在册（清单看得见、勾得回来），但启停位是 false 且没有动作可引用
	meta, exists := reg.Meta("demo-ext")
	require.True(t, exists, "停用 ⇒ 壳留册（用户要能勾回来）")
	require.False(t, reg.Enabled("demo-ext"))
	require.Equal(t, plugin.TransportHTTP, meta.Transport)
	_, hasAction := reg.LookupAction("demo-ext", "log")
	require.False(t, hasAction, "壳没有动作 ⇒ 停用的插件不被规则引用")

	// 停用状态下扫描不许把它拉起来（DB 说了算）
	require.NoError(t, host.Ensure(ctx))
	_, exists = reg.Meta("demo-ext")
	require.True(t, exists, "DB 停用的插件保持壳在册")
	require.True(t, processGone(st.PID), "停用的插件不被扫描拉起")

	// 再启用 ⇒ 起新进程、重新在册
	_, err = svc.SetEnabled(ctx, "demo-ext", true)
	require.NoError(t, err)
	require.True(t, reg.Enabled("demo-ext"))
	_, exists = reg.Meta("demo-ext")
	require.True(t, exists)
	action, ok := reg.LookupAction("demo-ext", "log")
	require.True(t, ok)
	require.NoError(t, action.Execute(ctx, plugin.ActionRequest{}))
}

// shortTempDir 短路径临时目录：Unix socket 路径有 104 字节上限（macOS），
// t.TempDir() 会带上长长的测试名，加上 /demo-ext/plugin.sock 就超了，插件 listen 会直接失败。
func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "krss-plugins-*")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// TestPluginHost_RelativeDirResolvedAbsolute KRSS_DATA_DIR 写成相对路径时（真机踩过）：
// 插件目录必须转绝对，否则 entrypoint 会按「chdir 之后」的插件目录解析 ⇒ fork/exec ENOENT。
func TestPluginHost_RelativeDirResolvedAbsolute(t *testing.T) {
	host := service.NewPluginHost(plugin.NewRegistry(), newFakePluginRepo(), ".data/plugins-test")
	require.True(t, filepath.IsAbs(host.Dir()), "Dir() 应是绝对路径：%s", host.Dir())
}

// processGone 进程是否已退出（ESRCH = 没有这个进程；EPERM 也算没了权限之外还活着，不算退出）。
func processGone(pid int) bool {
	if pid <= 0 {
		return true
	}
	err := syscall.Kill(pid, 0)
	return err == syscall.ESRCH
}

// TestPluginHost_ManifestDeclaresUI 外部插件的界面贡献 / 视图 / 权限只认 manifest（56-31）：
// 插件进程自报的 /meta 不算，磁盘上的 plugin.json 才是宿主信任边界。
func TestPluginHost_ManifestDeclaresUI(t *testing.T) {
	ctx := context.Background()
	pluginsDir := shortTempDir(t)
	reg := plugin.NewRegistry()
	repo := newFakePluginRepo()
	host := newTestHost(t, pluginsDir, reg, repo)
	require.NoError(t, host.Ensure(ctx))

	dir := filepath.Join(pluginsDir, "demo-ext")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	raw, err := os.ReadFile(pluginsrvBinary(t))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "demo-ext"), raw, 0o755))
	manifest := `{"id":"demo-ext","name":"Demo 外部插件","version":"1.0.0","transport":"http","entrypoint":"./demo-ext","autostart":true,
	  "permissions":["entries:read","data"],
	  "contributions":[{"id":"log-entry","surface":"entry.contextmenu","action":"log","label":"记一条日志","selection":"single"}],
	  "views":[{"id":"demo","label":"演示","kind":"declarative","layout":"list"}]}`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "plugin.json"), []byte(manifest), 0o644))

	require.NoError(t, host.Ensure(ctx))
	require.True(t, reg.Enabled("demo-ext"), "安装即启用")

	items := reg.AllContributions()[plugin.SurfaceEntryContextMenu]
	require.Len(t, items, 1, "manifest 里声明的界面贡献要进清单")
	require.Equal(t, "demo-ext", items[0].Plugin, "归属由宿主注入")
	require.Equal(t, "log", items[0].Action)

	views := reg.AllViews()
	require.Len(t, views, 1, "manifest 里声明的视图要进清单")
	require.Equal(t, "demo-ext", views[0].Plugin)

	meta, ok := reg.Meta("demo-ext")
	require.True(t, ok)
	require.Equal(t, []string{"entries:read", "data"}, meta.Permissions, "权限也要从 manifest 带出来")
}
