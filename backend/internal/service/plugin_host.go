// 外部插件宿主 / 看护（55-7b）。
//
// 一条命令都不重启的即装即用：把插件文件夹丢进 $KRSS_DATA_DIR/plugins/<id>/（manifest + 可执行），
// 宿主在 Catalog 链上扫目录 → 读 manifest → 落库 → spawn 子进程 → 等 /ready → 拉 /meta →
// 把它的能力包成与内置同形的适配器注册进同一个 registry。
//
// 看护：进程意外退出按指数退避重启（1s→2s→4s…→30s 封顶）；连续崩 ≥5 次标 crashed 停看护，
// 清单里带 lastError（UI 显示「已崩溃」）。停用 = SIGTERM → 5s 宽限 → SIGKILL，并清 socket 文件。
//
// 安全面：只听本机 Unix socket（0600，krss 单用户进程拥有）；不开 TCP、不监听局域网；
// token 每次 spawn 新生成，插件拿不到 DB、拿不到别人的设置键。
package service

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"krss/backend/internal/plugin"
	"krss/backend/internal/repository"
	"krss/backend/pkg/logger"
)

const (
	pluginManifestFile = "plugin.json" // plugins/<id>/plugin.json
	pluginSocketFile   = "plugin.sock" // 宿主与插件之间的 Unix socket
	pluginLogFile      = "plugin.log"  // 插件自己 stdout/stderr 落在插件目录
	maxPluginCrashes   = 5             // 连续崩这么多次就不再拉起
	pluginReadyPoll    = 50 * time.Millisecond
	pluginKillWait     = 2 * time.Second
)

// 默认值（测试用 Option 调小，生产按计划书：10s 就绪、1s 起退避、30s 封顶、5s 停用宽限）。
const (
	defaultPluginReadyTimeout = 10 * time.Second
	defaultPluginBackoffBase  = time.Second
	defaultPluginBackoffMax   = 30 * time.Second
	defaultPluginStopGrace    = 5 * time.Second
)

// pluginManifest 外部插件 manifest（plugins/<id>/plugin.json）。
type pluginManifest struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Version      string   `json:"version"`
	Transport    string   `json:"transport"`
	Entrypoint   string   `json:"entrypoint"`
	Autostart    bool     `json:"autostart"`
	Capabilities []string `json:"capabilities"`
	// 56-31：界面贡献 / 视图 / 权限以 manifest 为准（宿主信任边界在磁盘文件上，
	// 不信插件进程自报的 /meta）；内置轨用代码声明，外部轨用这份声明。
	Permissions   []string              `json:"permissions"`
	Contributions []plugin.Contribution `json:"contributions"`
	Views         []plugin.View         `json:"views"`
}

// PluginHostState 一个外部插件的运行时状态（排障 / 测试 / 未来 UI 用）。
type PluginHostState struct {
	ID        string    `json:"id"`
	PID       int       `json:"pid"`
	Restarts  int       `json:"restarts"`
	Crashed   bool      `json:"crashed"`
	LastError string    `json:"lastError,omitempty"`
	StartedAt time.Time `json:"startedAt"`
}

// externalPluginProcess 一个正在（或被看护的）外部插件进程。
type externalPluginProcess struct {
	id         string
	dir        string
	manifest   pluginManifest
	socketPath string
	token      string
	client     *plugin.RemoteClient

	cmd      *exec.Cmd
	exited   chan error // cmd.Wait 的结果（每次 spawn 重建）
	logFile  *os.File
	pid      int
	stopping atomic.Bool // 主动停止：看护看到它就收手

	restarts  int
	ready     bool // 曾经真就绪过（注册的是真适配器，不是占位空壳）
	crashed   bool
	lastError string
	startedAt time.Time
}

// PluginHost 外部插件宿主。零值不可用；用 NewPluginHost 构造。
// 方法都对 nil 接收者安全（service 里 host 可为 nil ⇒ 老测试/纯内置部署不受影响）。
type PluginHost struct {
	registry *plugin.Registry
	plugins  repository.PluginRepository
	dir      string

	mu    sync.Mutex // 护 procs + registry 注册/摘除的先后顺序
	procs map[string]*externalPluginProcess

	readyTimeout time.Duration
	backoffBase  time.Duration
	// apiBase 宿主 HTTP 的基址（如 http://127.0.0.1:8082），注入给插件用来自查自己的 data。
	apiBase    string
	backoffMax time.Duration
	stopGrace  time.Duration
}

// PluginHostOption 宿主可调参数（默认值即计划书口径，测试调小以免等 30s）。
type PluginHostOption func(*PluginHost)

// WithPluginReadyTimeout 就绪探针总超时（默认 10s）。
func WithPluginReadyTimeout(d time.Duration) PluginHostOption {
	return func(h *PluginHost) {
		if d > 0 {
			h.readyTimeout = d
		}
	}
}

// WithPluginBackoff 崩溃重启的退避区间（默认 1s 起、30s 封顶）。
func WithPluginBackoff(base, max time.Duration) PluginHostOption {
	return func(h *PluginHost) {
		if base > 0 {
			h.backoffBase = base
		}
		if max > 0 {
			h.backoffMax = max
		}
	}
}

// WithPluginStopGrace 停用时的 SIGTERM→SIGKILL 宽限（默认 5s）。
// WithPluginAPIBase 告诉宿主「自己的 HTTP 基址」，spawn 时以 KRSS_PLUGIN_API 注入给插件。
// 插件进程靠它 + 自己的 token 读写自己那份 data（单库，56-32）。
func WithPluginAPIBase(base string) PluginHostOption {
	return func(h *PluginHost) { h.apiBase = strings.TrimRight(strings.TrimSpace(base), "/") }
}

func WithPluginStopGrace(d time.Duration) PluginHostOption {
	return func(h *PluginHost) {
		if d > 0 {
			h.stopGrace = d
		}
	}
}

// NewPluginHost 造宿主。dir = $KRSS_DATA_DIR/plugins（不存在会自动建）。
// 目录一律转绝对路径：entrypoint 是相对插件目录的，而子进程会 chdir 到插件目录，
// 相对路径在 exec 时会按**新**工作目录解析 ⇒ KRSS_DATA_DIR 写成相对路径就会 fork/exec ENOENT。
func NewPluginHost(registry *plugin.Registry, plugins repository.PluginRepository, dir string, opts ...PluginHostOption) *PluginHost {
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	h := &PluginHost{
		registry:     registry,
		plugins:      plugins,
		dir:          dir,
		procs:        make(map[string]*externalPluginProcess),
		readyTimeout: defaultPluginReadyTimeout,
		backoffBase:  defaultPluginBackoffBase,
		backoffMax:   defaultPluginBackoffMax,
		stopGrace:    defaultPluginStopGrace,
	}
	for _, opt := range opts {
		opt(h)
	}
	return h
}

// Dir 插件根目录（设置页展示 / 排障用）。
func (h *PluginHost) Dir() string {
	if h == nil {
		return ""
	}
	return h.dir
}

// Watch 每 interval 跑一次 Ensure（默认 5s）。即装即用的发现延迟 = 这么久：
// 不上 fsnotify（本地磁盘 + 单用户，5s 足够；要更快要用户点「重新扫描插件目录」）。
func (h *PluginHost) Watch(ctx context.Context, interval time.Duration) {
	if h == nil {
		return
	}
	if interval <= 0 {
		interval = 5 * time.Second
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := h.Ensure(ctx); err != nil {
					logger.Warn("external plugin scan failed",
						"module", "service", "action", "watch", "resource", "plugin", "result", "failed",
						"error", err)
				}
			}
		}
	}()
}

// Ensure 扫插件目录并让运行态收敛到「目录 + DB 启停」描述的样子：
// 新发现的插件落库为**停用**（等用户在设置页启用后才拉起）；目录没了的停掉摘除；DB 停用的不拉起。
// 幂等，Catalog 链上每次都跑（设置页「重新扫描插件目录」= 再跑一次）。
func (h *PluginHost) Ensure(ctx context.Context) error {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.syncLocked(ctx)
}

func (h *PluginHost) syncLocked(ctx context.Context) error {
	manifests, err := h.scanLocked()
	if err != nil {
		return err
	}
	// 卸载：目录没了 ⇒ 停掉并摘除（规则里的引用按「插件未安装」处理）。
	for id := range h.procs {
		if _, ok := manifests[id]; !ok {
			h.stopLocked(id)
		}
	}

	states, err := h.plugins.List(ctx)
	if err != nil {
		return err
	}
	enabled := make(map[string]bool, len(states))
	for _, st := range states {
		enabled[st.ID] = st.Enabled
	}
	// 首次发现才落库，且**一律停用**：新插件必须由用户在设置页明确启用后才执行。
	// manifest.autostart 只保留在结构里（兼容老 manifest），不再作为自动执行的依据——
	// 已存在的 DB 行是用户的选择，不许被覆盖。
	for id := range manifests {
		if _, ok := enabled[id]; ok {
			continue
		}
		if err := h.plugins.Upsert(ctx, id, false); err != nil {
			return err
		}
		enabled[id] = false
		logger.Info("发现新插件，等待用户启用",
			"module", "service", "action", "discover", "resource", "plugin", "result", "ok",
			"plugin_id", id)
	}
	// 拉起：只拉 DB 说启用的、且还没在跑/没判死的；DB 说停用的正在跑也要收走（收敛到库里的样子）。
	for id, manifest := range manifests {
		if !enabled[id] {
			if _, running := h.procs[id]; running {
				h.stopLocked(id)
			}
			// 停用 ≠ 消失：注册一个 manifest 空壳（无扩展点），保证清单里看得见、勾得回来。
			// 真身（/meta 拿到的名字/动作/字段）在启用时由 registerLocked 摘壳换上。
			// 壳没有动作 ⇒ 规则编辑器不会列出它的动作（停用的插件本就不该被引用）。
			if _, ok := h.registry.Meta(id); !ok {
				if err := h.registry.Register(newShellPlugin(manifest)); err != nil {
					logger.Warn("register disabled plugin shell failed",
						"module", "service", "action", "register", "resource", "plugin", "result", "failed",
						"plugin_id", id, "error", err)
				}
			}
			continue
		}
		if p, running := h.procs[id]; running {
			_ = p // 在跑或已判死（crashed）都交给看护/人工，别在这儿反复拉
			continue
		}
		if err := h.startLocked(ctx, manifest); err != nil {
			logger.Error("external plugin start failed",
				"module", "service", "action", "start", "resource", "plugin", "result", "failed",
				"plugin_id", id, "error", err)
		}
	}
	// registry 的启停位以库为准（发现的插件也要按库里的位，而不是 DefaultEnabled）。
	h.registry.LoadEnabled(enabled)
	return nil
}

// scanLocked 读一遍插件目录（读不动的目录跳过并记日志，不拖垮整个清单）。
func (h *PluginHost) scanLocked() (map[string]pluginManifest, error) {
	if err := os.MkdirAll(h.dir, 0o755); err != nil {
		return nil, fmt.Errorf("建插件目录 %s 失败: %w", h.dir, err)
	}
	entries, err := os.ReadDir(h.dir)
	if err != nil {
		return nil, fmt.Errorf("扫插件目录 %s 失败: %w", h.dir, err)
	}
	out := make(map[string]pluginManifest, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		manifest, err := h.readManifestLocked(entry.Name())
		if err != nil {
			logger.Warn("external plugin skipped",
				"module", "service", "action", "scan", "resource", "plugin", "result", "skipped",
				"plugin_id", entry.Name(), "error", err)
			continue
		}
		out[manifest.ID] = manifest
	}
	return out, nil
}

// readManifestLocked 读 plugins/<id>/plugin.json（id 必须与目录名一致：它是全局唯一键）。
func (h *PluginHost) readManifestLocked(dirName string) (pluginManifest, error) {
	path := filepath.Join(h.dir, dirName, pluginManifestFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		return pluginManifest{}, fmt.Errorf("读 %s 失败: %w", path, err)
	}
	var manifest pluginManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return pluginManifest{}, fmt.Errorf("解析 %s 失败: %w", path, err)
	}
	manifest.ID = strings.TrimSpace(manifest.ID)
	if manifest.ID == "" {
		manifest.ID = dirName
	}
	if manifest.ID != dirName {
		return pluginManifest{}, fmt.Errorf("%s 的 id=%q 与目录名 %q 不一致", path, manifest.ID, dirName)
	}
	if manifest.Transport == "" {
		manifest.Transport = plugin.TransportHTTP
	}
	if manifest.Transport != plugin.TransportHTTP {
		return pluginManifest{}, fmt.Errorf("插件 %s 的 transport=%q 不支持（v1 只有 http）", manifest.ID, manifest.Transport)
	}
	return manifest, nil
}

// Has 这个 id 是不是磁盘上的外部插件（或正被宿主看护）。
func (h *PluginHost) Has(id string) bool {
	if h == nil || strings.TrimSpace(id) == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(h.dir, id, pluginManifestFile)); err == nil {
		return true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.procs[id]
	return ok
}

// State 读一个外部插件的运行时状态；ok=false = 宿主不管这个 id。
func (h *PluginHost) State(id string) (PluginHostState, bool) {
	if h == nil {
		return PluginHostState{}, false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	p, ok := h.procs[id]
	if !ok {
		return PluginHostState{}, false
	}
	return PluginHostState{
		ID:        p.id,
		PID:       p.pid,
		Restarts:  p.restarts,
		Crashed:   p.crashed,
		LastError: p.lastError,
		StartedAt: p.startedAt,
	}, true
}

// Start 拉起（或重新拉起）一个外部插件。已就绪的幂等返回 nil；crashed 的会清状态重试。
func (h *PluginHost) Start(ctx context.Context, id string) error {
	if h == nil {
		return ErrPluginNotFound
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	manifest, err := h.readManifestLocked(id)
	if err != nil {
		return ErrPluginNotFound
	}
	if p, ok := h.procs[id]; ok {
		if !p.crashed && !pidGone(p.pid) {
			return nil // 已经在跑（或正在退避重启）
		}
		h.killLocked(p)
		delete(h.procs, id)
	}
	return h.startLocked(ctx, manifest)
}

// shellPlugin 停用的外部插件在清单里的占位：只有 manifest 元信息，没有任何扩展点。
// 存在意义 = 「停用 ≠ 消失」：用户在设置页看得见它、勾得回来；启用时 registerLocked
// 会摘掉这个壳、换上 /meta 问出来的真身。壳没有动作 ⇒ 规则编辑器不会列出它。
type shellPlugin struct {
	meta plugin.Meta
}

func newShellPlugin(manifest pluginManifest) plugin.Plugin {
	name := strings.TrimSpace(manifest.Name)
	if name == "" {
		name = manifest.ID
	}
	return shellPlugin{meta: plugin.Meta{
		ID:          manifest.ID,
		Name:        name,
		Description: "外部插件（已停用）——启用后才加载它的能力。",
		Version:     manifest.Version,
		Builtin:     false,
		Transport:   plugin.TransportHTTP,
	}}
}

func (p shellPlugin) Meta() plugin.Meta                          { return p.meta }
func (p shellPlugin) Actions() []plugin.Action                   { return nil }
func (p shellPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p shellPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p shellPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

// startLocked spawn + 等就绪 + 注册 + 叫上看护。失败时也留 state（lastError 给 UI 看）。
func (h *PluginHost) startLocked(ctx context.Context, manifest pluginManifest) error {
	if existing, ok := h.registry.Meta(manifest.ID); ok && existing.Transport != plugin.TransportHTTP {
		return fmt.Errorf("插件 id %q 与内置插件冲突，拒绝启动", manifest.ID)
	}
	p := &externalPluginProcess{
		id:         manifest.ID,
		dir:        filepath.Join(h.dir, manifest.ID),
		manifest:   manifest,
		socketPath: filepath.Join(h.dir, manifest.ID, pluginSocketFile),
		token:      newPluginToken(),
		startedAt:  time.Now(),
	}
	p.client = plugin.NewRemoteClient(p.socketPath, p.token)

	err := h.spawnLocked(p)
	if err == nil {
		err = h.registerLocked(p)
	}
	if err != nil {
		p.lastError = err.Error()
		h.procs[manifest.ID] = p
		h.registry.Unregister(manifest.ID)
		// 起不来也交给看护：按退避重试，连崩到上限才判死。
		go h.supervise(p, err)
		return err
	}
	p.lastError = ""
	p.ready = true
	h.procs[manifest.ID] = p
	logger.Info("external plugin started",
		"module", "service", "action", "start", "resource", "plugin", "result", "ok",
		"plugin_id", manifest.ID, "pid", p.pid, "transport", plugin.TransportHTTP, "socket", p.socketPath)
	go h.supervise(p, nil)
	return nil
}

// pluginLogMaxBytes plugin.log 的轮转阈值：超过它就把旧文件改名为 plugin.log.1。
// 包级 var 便于测试改小（生产固定 5MB）。
var pluginLogMaxBytes int64 = 5 << 20

// pluginChildEnv 返回外部插件子进程的**最小环境变量白名单**（绝不继承宿主其余环境）。
//
// 安全边界：宿主进程里可能有数据库密码、第三方 key、代理口令等敏感变量，
// 直接 os.Environ() 会把它们一并泄漏给插件。这里只放行运行插件所必需的基础变量，
// 再加四个由宿主注入的 KRSS_PLUGIN_*。代理变量大小写两种都带上（不同程序认不同写法）。
func pluginChildEnv(socketPath, token, id, apiBase string) []string {
	allow := []string{
		"PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
		"SSL_CERT_FILE", "SSL_CERT_DIR",
		"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
		"http_proxy", "https_proxy", "no_proxy", "all_proxy",
	}
	env := make([]string, 0, len(allow)+4)
	for _, key := range allow {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	env = append(env,
		"KRSS_PLUGIN_SOCKET="+socketPath,
		"KRSS_PLUGIN_TOKEN="+token,
		"KRSS_PLUGIN_ID="+id,
		"KRSS_PLUGIN_API="+apiBase,
	)
	return env
}

// openPluginLog 打开插件日志（追加写）。超过 pluginLogMaxBytes 时先轮转：
// 已有 plugin.log.1 先删掉（只保留一代），再把 plugin.log 改名为 .1，最后新建空文件。
func openPluginLog(dir string) (*os.File, error) {
	path := filepath.Join(dir, pluginLogFile)
	if info, err := os.Stat(path); err == nil && info.Size() > pluginLogMaxBytes {
		backup := path + ".1"
		_ = os.Remove(backup)
		if err := os.Rename(path, backup); err != nil {
			return nil, err
		}
	}
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

// spawnLocked 起进程 + 轮询 /ready（进程先退出算一次崩溃，不用等满超时）。
func (h *PluginHost) spawnLocked(p *externalPluginProcess) error {
	entry := strings.TrimSpace(p.manifest.Entrypoint)
	if entry == "" {
		entry = "./" + p.id
	}
	if !filepath.IsAbs(entry) {
		entry = filepath.Join(p.dir, strings.TrimPrefix(entry, "./"))
	}
	cmd := exec.Command(entry)
	cmd.Dir = p.dir
	cmd.Env = pluginChildEnv(p.socketPath, p.token, p.id, h.apiBase)
	// 插件自己的 stdout/stderr 落插件目录（宿主不吞，排障能看）。
	var logFile *os.File
	if f, err := openPluginLog(p.dir); err == nil {
		logFile = f
		cmd.Stdout = f
		cmd.Stderr = f
	}
	if err := cmd.Start(); err != nil {
		if logFile != nil {
			_ = logFile.Close()
		}
		return fmt.Errorf("启动 %s 失败: %w", entry, err)
	}
	exited := make(chan error, 1)
	p.cmd = cmd
	p.pid = cmd.Process.Pid
	p.logFile = logFile
	p.exited = exited
	p.startedAt = time.Now()
	go func() { exited <- cmd.Wait() }()

	deadline := time.Now().Add(h.readyTimeout)
	var lastErr error
	for {
		select {
		case werr := <-exited:
			exited <- werr // 放回去，看护还要读退出原因
			if werr == nil {
				werr = fmt.Errorf("进程已退出")
			}
			return fmt.Errorf("插件进程启动后立即退出: %w", werr)
		default:
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		lastErr = p.client.Ready(ctx)
		cancel()
		if lastErr == nil {
			return nil
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			return fmt.Errorf("%s 内没就绪: %w", h.readyTimeout, lastErr)
		}
		time.Sleep(pluginReadyPoll)
	}
}

// pluginAPIVersion 读外部插件适配器自报的协议版本。没实现 APIVersion() 的（旧适配器 / 非外部）
// 返回 0，按「不兼容」处理，提示用新 SDK 重编。
func pluginAPIVersion(p plugin.Plugin) int {
	if a, ok := p.(interface{ APIVersion() int }); ok {
		return a.APIVersion()
	}
	return 0
}

// registerLocked 拉 /meta 并注册（重启用/崩溃重启后要重新注册，meta 可能变了）。
func (h *PluginHost) registerLocked(p *externalPluginProcess) error {
	ctx, cancel := context.WithTimeout(context.Background(), h.readyTimeout)
	defer cancel()
	remote, err := p.client.Plugin(ctx)
	if err != nil {
		return fmt.Errorf("读 /meta 失败: %w", err)
	}
	// 协议版本校验：插件自报的 apiVersion 必须与宿主一致；缺省 0（旧 SDK）也按不兼容处理。
	if got := pluginAPIVersion(remote); got != plugin.ProtocolVersion {
		return fmt.Errorf("插件协议版本不兼容：需要 v%d，插件报 v%d（插件需用新 SDK 重新编译）", plugin.ProtocolVersion, got)
	}
	// 56-31：外部插件的界面贡献 / 视图 / 权限只认 manifest —— 插件进程自报的不算。
	remote = plugin.AttachManifest(remote, p.manifest.Contributions, p.manifest.Views, p.manifest.Permissions)
	h.registry.Unregister(p.id) // 幂等：换一份适配器（旧 client 可能已死）
	if err := h.registry.Register(remote); err != nil {
		return fmt.Errorf("注册外部插件失败: %w", err)
	}
	return nil
}

// supervise 看护一个插件进程：退出 → 指数退避重启；连崩满 maxPluginCrashes 判死停手。
// initialErr 非 nil 表示「第一次就没起来」（进程可能根本没在跑）。
func (h *PluginHost) supervise(p *externalPluginProcess, initialErr error) {
	err := initialErr
	for {
		if err == nil {
			err = <-p.exited // 等真退出（spawn 成功时才有）
		}
		if p.stopping.Load() {
			return
		}

		h.mu.Lock()
		p.restarts++
		attempt := p.restarts
		p.lastError = fmt.Sprintf("第 %d 次崩溃: %v", attempt, err)
		crashOut := attempt >= maxPluginCrashes
		if crashOut {
			p.crashed = true
			// 判死的插件也要在清单里露脸（否则用户只看到它「凭空消失」），带 lastError 显示「已崩溃」。
			// 放在同一把锁里：观测到 crashed 的同时清单已经能查到它。
			h.registerPlaceholderLocked(p)
		}
		h.mu.Unlock()

		logger.Warn("external plugin exited",
			"module", "service", "action", "supervise", "resource", "plugin", "result", "exited",
			"plugin_id", p.id, "restarts", attempt, "crashed", crashOut, "error", err)

		if crashOut {
			h.killLocked(p)
			return
		}
		if !h.sleepBackoff(p, attempt) {
			return
		}

		h.mu.Lock()
		h.killLocked(p) // 收拾上一轮残留（/meta 失败那种：进程可能还在）
		spawnErr := h.spawnLocked(p)
		if spawnErr == nil {
			spawnErr = h.registerLocked(p)
		}
		if spawnErr == nil {
			p.lastError = ""
			p.ready = true
		} else {
			p.lastError = spawnErr.Error()
		}
		h.mu.Unlock()
		err = spawnErr
	}
}

// sleepBackoff 指数退避（1s→2s→4s…封顶）；被停用打断返回 false。
func (h *PluginHost) sleepBackoff(p *externalPluginProcess, attempt int) bool {
	delay := h.backoffBase
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= h.backoffMax {
			break
		}
	}
	if delay > h.backoffMax {
		delay = h.backoffMax
	}
	deadline := time.Now().Add(delay)
	for time.Now().Before(deadline) {
		if p.stopping.Load() {
			return false
		}
		time.Sleep(pluginReadyPoll)
	}
	return !p.stopping.Load()
}

// StopPlugin 停用一个外部插件（SIGTERM → 宽限 → SIGKILL），清 socket、摘注册表。
func (h *PluginHost) StopPlugin(id string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stopLocked(id)
}

// Stop 停掉全部外部插件（main.go 关停流程调；测试 t.Cleanup 也调）。
func (h *PluginHost) Stop() {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for id := range h.procs {
		h.stopLocked(id)
	}
}

func (h *PluginHost) stopLocked(id string) {
	p, ok := h.procs[id]
	if !ok {
		return
	}
	p.stopping.Store(true)
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Signal(syscall.SIGTERM)
		deadline := time.Now().Add(h.stopGrace)
		for time.Now().Before(deadline) && !pidGone(p.pid) {
			time.Sleep(pluginReadyPoll)
		}
		if !pidGone(p.pid) {
			_ = p.cmd.Process.Kill()
			killDeadline := time.Now().Add(pluginKillWait)
			for time.Now().Before(killDeadline) && !pidGone(p.pid) {
				time.Sleep(pluginReadyPoll)
			}
		}
	}
	if p.logFile != nil {
		_ = p.logFile.Close()
	}
	if p.client != nil {
		p.client.Close()
	}
	_ = os.Remove(p.socketPath)
	delete(h.procs, id)
	h.registry.Unregister(id)

	logger.Info("external plugin stopped",
		"module", "service", "action", "stop", "resource", "plugin", "result", "ok",
		"plugin_id", id, "pid", p.pid)
}

// registerPlaceholderLocked 判死的插件在清单里留一个空壳（无扩展点），让 LastError 有地方挂。
func (h *PluginHost) registerPlaceholderLocked(p *externalPluginProcess) {
	if existing, ok := h.registry.Meta(p.id); ok && existing.Transport == plugin.TransportHTTP && p.ready {
		return // 它曾经真起来过：注册的是真适配器，留着（调用会报连接失败，比消失更诚实）
	}
	h.registry.Unregister(p.id)
	if err := h.registry.Register(placeholderPlugin{manifest: p.manifest}); err != nil {
		logger.Warn("external plugin placeholder skipped",
			"module", "service", "action", "register", "resource", "plugin", "result", "skipped",
			"plugin_id", p.id, "error", err)
	}
}

// placeholderPlugin 起不来 / 判死的插件在清单里的占位（一个扩展点都没有，只有 Meta + lastError）。
type placeholderPlugin struct {
	manifest pluginManifest
}

func (p placeholderPlugin) Meta() plugin.Meta {
	return plugin.Meta{
		ID:          p.manifest.ID,
		Name:        p.manifest.Name,
		Description: "外部插件（未能启动，详见 lastError）",
		Version:     p.manifest.Version,
		Builtin:     false,
		Transport:   plugin.TransportHTTP,
	}
}
func (placeholderPlugin) Actions() []plugin.Action                   { return nil }
func (placeholderPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (placeholderPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (placeholderPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

// killLocked 强杀一个残留进程（崩溃重启前 / 判死后收尾）。不摘注册表。
func (h *PluginHost) killLocked(p *externalPluginProcess) {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return
	}
	if pidGone(p.pid) {
		return
	}
	_ = p.cmd.Process.Kill()
	deadline := time.Now().Add(pluginKillWait)
	for time.Now().Before(deadline) && !pidGone(p.pid) {
		time.Sleep(pluginReadyPoll)
	}
}

// Decorate 把运行时故障填进清单（Catalog 末尾调；crashed/起不来的插件因此对 UI 可见）。
func (h *PluginHost) Decorate(items []plugin.CatalogItem) {
	if h == nil || len(items) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range items {
		p, ok := h.procs[items[i].ID]
		if !ok || p.lastError == "" {
			continue
		}
		if p.crashed {
			items[i].LastError = fmt.Sprintf("已崩溃（连续 %d 次）: %s", p.restarts, p.lastError)
			continue
		}
		items[i].LastError = p.lastError
	}
}

// clientFor 拿一个在跑插件的客户端（设置 / 动作测试路由用）。
func (h *PluginHost) clientFor(id string) (*plugin.RemoteClient, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	p, ok := h.procs[id]
	if !ok || p.crashed || pidGone(p.pid) {
		return nil, ErrPluginNotFound
	}
	return p.client, nil
}

// GetSettings 读外部插件设置（裸键；掩码由 service 层统一做）。
func (h *PluginHost) GetSettings(ctx context.Context, id string) (map[string]string, error) {
	client, err := h.clientFor(id)
	if err != nil {
		return nil, err
	}
	return client.GetSettings(ctx)
}

// PutSettings 写外部插件设置，返回写完的值。
func (h *PluginHost) PutSettings(ctx context.Context, id string, values map[string]string) (map[string]string, error) {
	client, err := h.clientFor(id)
	if err != nil {
		return nil, err
	}
	return client.PutSettings(ctx, values)
}

// TestAction 让外部插件的动作自己发一条测试。
func (h *PluginHost) TestAction(ctx context.Context, id, actionID string) error {
	client, err := h.clientFor(id)
	if err != nil {
		return err
	}
	return client.TestAction(ctx, actionID)
}

// UIAsset 取外部插件自带的界面资源（56-24）：宿主把 /api/plugins/:id/ui/* 转成插件的 GET /ui/<rest>。
// 外部插件不实现 plugin.UIAssets（那是内置插件 embed.FS 的路），资源一定在插件进程这边。
func (h *PluginHost) UIAsset(ctx context.Context, id, subpath string) (plugin.UIAssetFile, error) {
	client, err := h.clientFor(id)
	if err != nil {
		return plugin.UIAssetFile{}, err
	}
	return client.UIAsset(ctx, subpath)
}

// newPluginToken 每次 spawn 新生成的共享密钥（16 字节随机 → hex）。
func newPluginToken() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand 正常不会失败；真失败也不能退化成可猜的 token。
		panic("plugin: 生成 token 失败: " + err.Error())
	}
	return hex.EncodeToString(buf)
}

// pidGone 进程是否已经不在（ESRCH）。注意：只用来判断「有没有这个进程」，不发信号。
func pidGone(pid int) bool {
	if pid <= 0 {
		return true
	}
	err := syscall.Kill(pid, 0)
	return err == syscall.ESRCH
}

// PluginIDByToken 用「插件进程带来的 token」换它的插件 id（56-32 单库数据通道）。
//
// 语义：插件进程没有登录态，但需要读写**自己**的 data（标注、缓存……）。宿主 spawn 时
// 已经给它一枚随机 token，这里把它认回来；调用方必须再校验「id 与请求路径一致」，
// 所以一枚 token 只能碰自己那一行数据。
// 只有正在跑（未主动停止）的进程的 token 有效：停用/崩溃的插件拿旧 token 也进不来。
func (h *PluginHost) PluginIDByToken(token string) (string, bool) {
	if h == nil || len(token) < 16 {
		return "", false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, p := range h.procs {
		if p == nil || p.stopping.Load() || p.token == "" {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(p.token), []byte(token)) == 1 {
			return id, true
		}
	}
	return "", false
}
