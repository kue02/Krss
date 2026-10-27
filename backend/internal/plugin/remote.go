// 外部插件客户端 + 适配器（55-7b）。
//
// 外部插件是**独立进程**，krss 宿主建 Unix socket（0600），插件 dial 它说 HTTP + JSON；
// 这里的适配器把远端能力包成与内置**同形**的 plugin.Action / EntryProcessor / FetchClassifier，
// 于是规则引擎、阅读期钩子、设置页面对 registry 说话时**分不清对面是内置还是外部**。
//
// 协议表（服务端实现见 internal/plugin/sdk）：
//
//	GET  /ready                         就绪探针
//	GET  /meta                          Meta + 各扩展点清单
//	GET  /settings · PUT /settings      插件设置
//	POST /actions/:actionId/execute     动作执行（ActionRequest → {} / {"error"}）
//	POST /actions/:actionId/test        动作自测（{} → {} / {"error"}）
//	POST /entry-processors/:id          阅读期处理（{feed, entry} → {entry}）
//	POST /fetch-classifiers/:id         失败归类（{feed, statusCode, bodyHead, error} → {message}）
//	GET  /ui/<rest>                     插件自带界面资源（56-24；宿主把 /api/plugins/:id/ui/* 转过来）
//
// 安全面：只听 Unix socket（不监听 TCP、不出局域网），每个请求带 X-Krss-Plugin-Token（每次 spawn 新生成）。
package plugin

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"krss/backend/internal/model"
)

// ErrActionNotTestable 插件没给这个动作实现 ActionTester（远端 /test 返回 400 时用它；
// service 层把它翻成 ErrPluginActionNotTestable，与内置轨同一句文案）。
var ErrActionNotTestable = errors.New("plugin: 动作不支持测试")

// remoteRequestTimeout 单次 RPC 的超时（本地 socket，正常都在毫秒级；超时说明插件卡死了）。
const remoteRequestTimeout = 15 * time.Second

// RemoteClient 外部插件的 Unix socket 客户端（一个插件进程一个）。
type RemoteClient struct {
	socketPath string
	token      string
	http       *http.Client
}

// NewRemoteClient 造一个指向 plugin.sock 的客户端（token 由宿主 spawn 时生成并注入插件）。
func NewRemoteClient(socketPath, token string) *RemoteClient {
	dialer := &net.Dialer{Timeout: 2 * time.Second}
	transport := &http.Transport{
		// URL 的 host 只是占位，真正连的是插件目录下的 socket 文件。
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socketPath)
		},
		MaxIdleConns:    4,
		IdleConnTimeout: 30 * time.Second,
	}
	return &RemoteClient{
		socketPath: socketPath,
		token:      token,
		http:       &http.Client{Transport: transport, Timeout: remoteRequestTimeout},
	}
}

// SocketPath 插件 socket 路径（日志与排障用）。
func (c *RemoteClient) SocketPath() string { return c.socketPath }

// Close 关掉空闲连接（插件停用 / 进程退出后调，别把 fd 留着）。
func (c *RemoteClient) Close() {
	if c == nil || c.http == nil {
		return
	}
	if tr, ok := c.http.Transport.(*http.Transport); ok {
		tr.CloseIdleConnections()
	}
}

// do 发一次 RPC：body 编码成 JSON，2xx 时把响应解进 out；非 2xx 提取 {"error"} 变成 error。
func (c *RemoteClient) do(ctx context.Context, method, path string, body, out interface{}) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("plugin: 编码请求 %s: %w", path, err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://plugin"+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("X-Krss-Plugin-Token", c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		// 连不上 / 超时：插件没工作，是我们这边联系不上它（502）
		return fmt.Errorf("%w: 调用 %s: %v", ErrTransport, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("%w: 读 %s 响应: %v", ErrTransport, path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &failure)
		message := strings.TrimSpace(failure.Error)
		if message == "" {
			message = strings.TrimSpace(string(raw))
		}
		if message == "" {
			message = resp.Status
		}
		if resp.StatusCode == http.StatusBadRequest && strings.Contains(message, "not testable") {
			return ErrActionNotTestable
		}
		// 插件**答话了**，只是内容是错误 ⇒ 交给上层翻 4xx，别当网关故障
		return fmt.Errorf("%w: %s", ErrPluginError, message)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%w: 解析 %s 响应: %v", ErrTransport, path, err)
	}
	return nil
}

// Ready 就绪探针（宿主 spawn 后轮询它；10s 起不来算崩溃）。
func (c *RemoteClient) Ready(ctx context.Context) error {
	return c.do(ctx, http.MethodGet, "/ready", nil, nil)
}

// metaResponse 与 sdk 的 /meta 响应对齐（字段名以 sdk/serve.go 为准）。
type metaResponse struct {
	ID               string             `json:"id"`
	Name             string             `json:"name"`
	Description      string             `json:"description"`
	Version          string             `json:"version"`
	Builtin          bool               `json:"builtin"`
	Actions          []remoteActionMeta `json:"actions"`
	Sections         []SettingsSection  `json:"sections"`
	EntryProcessors  []idOnly           `json:"entryProcessors"`
	FetchClassifiers []idOnly           `json:"fetchClassifiers"`
}

type remoteActionMeta struct {
	ActionID string  `json:"actionId"`
	Label    string  `json:"label"`
	Fields   []Field `json:"fields"`
}

type idOnly struct {
	ID string `json:"id"`
}

// Plugin 拉 /meta 并包成 plugin.Plugin（宿主拿到它就 registry.Register）。
func (c *RemoteClient) Plugin(ctx context.Context) (Plugin, error) {
	var meta metaResponse
	if err := c.do(ctx, http.MethodGet, "/meta", nil, &meta); err != nil {
		return nil, err
	}
	if strings.TrimSpace(meta.ID) == "" {
		return nil, errors.New("plugin: 外部插件 /meta 没有 id")
	}
	return &remotePlugin{client: c, meta: meta}, nil
}

// UIAsset 取一块插件自带的界面资源（56-24）。
// 与 do 的区别：响应是**原始字节**（HTML/JS/CSS/图片），不是 JSON，所以自己发一次 GET。
// 404 单独给 ErrUIAssetNotFound（宿主回 404，让浏览器/前端看到「资源没了」而不是「插件坏了」）。
// 超时由调用方控制（service 层 5s）；这里仍受 client 的 15s 总超时兜底。
func (c *RemoteClient) UIAsset(ctx context.Context, subpath string) (UIAssetFile, error) {
	path := "/ui/" + subpath
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://plugin"+path, nil)
	if err != nil {
		return UIAssetFile{}, err
	}
	req.Header.Set("X-Krss-Plugin-Token", c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return UIAssetFile{}, fmt.Errorf("plugin: 取界面资源 %s 失败: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return UIAssetFile{}, ErrUIAssetNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return UIAssetFile{}, fmt.Errorf("plugin: %s 返回 %d", path, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return UIAssetFile{}, fmt.Errorf("plugin: 读 %s 响应失败: %w", path, err)
	}
	return UIAssetFile{Body: body, ContentType: resp.Header.Get("Content-Type")}, nil
}

// GetSettings 读插件设置（裸键，不带 plugin.<id>. 前缀；掩码在 service 层统一做）。
func (c *RemoteClient) GetSettings(ctx context.Context) (map[string]string, error) {
	var out struct {
		Values map[string]string `json:"values"`
	}
	if err := c.do(ctx, http.MethodGet, "/settings", nil, &out); err != nil {
		return nil, err
	}
	if out.Values == nil {
		out.Values = map[string]string{}
	}
	return out.Values, nil
}

// PutSettings 整体替换插件设置，返回替换后的值。
func (c *RemoteClient) PutSettings(ctx context.Context, values map[string]string) (map[string]string, error) {
	if values == nil {
		values = map[string]string{}
	}
	var out struct {
		Values map[string]string `json:"values"`
	}
	body := map[string]map[string]string{"values": values}
	if err := c.do(ctx, http.MethodPut, "/settings", body, &out); err != nil {
		return nil, err
	}
	if out.Values == nil {
		out.Values = map[string]string{}
	}
	return out.Values, nil
}

// TestAction 让插件动作自己发一条测试（Bark「发送测试推送」的同形能力）。
func (c *RemoteClient) TestAction(ctx context.Context, actionID string) error {
	var out struct {
		Error string `json:"error"`
	}
	path := "/actions/" + actionID + "/test"
	if err := c.do(ctx, http.MethodPost, path, map[string]string{}, &out); err != nil {
		return err
	}
	if out.Error != "" {
		return errors.New(out.Error)
	}
	return nil
}

// executeAction 把一次命中 POST 给插件；插件回 {"error":…} 视作失败（与内置 action 返 error 同义）。
func (c *RemoteClient) executeAction(ctx context.Context, actionID string, req ActionRequest) error {
	var out struct {
		Error string `json:"error"`
	}
	path := "/actions/" + actionID + "/execute"
	if err := c.do(ctx, http.MethodPost, path, req, &out); err != nil {
		return err
	}
	if out.Error != "" {
		return errors.New(out.Error)
	}
	return nil
}

// processEntry 把条目交给插件处理，返回处理后的条目。
func (c *RemoteClient) processEntry(ctx context.Context, id string, feed model.Feed, entry model.Entry) (model.Entry, error) {
	var out struct {
		Entry model.Entry `json:"entry"`
		Error string      `json:"error"`
	}
	body := map[string]interface{}{"feed": feed, "entry": entry}
	if err := c.do(ctx, http.MethodPost, "/entry-processors/"+id, body, &out); err != nil {
		return entry, err
	}
	if out.Error != "" {
		return entry, errors.New(out.Error)
	}
	return out.Entry, nil
}

// classify 让插件归类一次抓取失败；空串 = 不认（调用方按原样透传）。
func (c *RemoteClient) classify(ctx context.Context, id string, feed model.Feed, statusCode int, bodyHead []byte, fetchErr error) string {
	var out struct {
		Message string `json:"message"`
	}
	body := map[string]interface{}{
		"feed":       feed,
		"statusCode": statusCode,
		"bodyHead":   base64.StdEncoding.EncodeToString(bodyHead),
	}
	if fetchErr != nil {
		body["error"] = fetchErr.Error()
	}
	if err := c.do(ctx, http.MethodPost, "/fetch-classifiers/"+id, body, &out); err != nil {
		return ""
	}
	return out.Message
}

// remotePlugin 把外部插件包成 plugin.Plugin（registry 与引擎零感知）。
type remotePlugin struct {
	client *RemoteClient
	meta   metaResponse
	// 以下三项来自**宿主的 manifest**（plugin.json），不是插件自报的 /meta：
	// 界面贡献、视图、权限都属于「宿主信任边界」，以磁盘上的文件为准。
	manifestContributions []Contribution
	manifestViews         []View
	manifestPermissions   []string
}

// WithManifest 把 manifest 里声明的界面贡献 / 视图 / 权限挂到适配器上。
// 没有这一步，外部插件写了 plugin.json 也不会出现在右键菜单、视图切换器里，
// 权限裁剪也会把它的 entries:full 当成没申请（56-31）。
func (p *remotePlugin) WithManifest(contributions []Contribution, views []View, permissions []string) *remotePlugin {
	p.manifestContributions = contributions
	p.manifestViews = views
	p.manifestPermissions = permissions
	return p
}

func (p *remotePlugin) Contributions() []Contribution { return p.manifestContributions }

func (p *remotePlugin) Views() []View { return p.manifestViews }

func (p *remotePlugin) Meta() Meta {
	return Meta{
		ID:          p.meta.ID,
		Name:        p.meta.Name,
		Description: p.meta.Description,
		Version:     p.meta.Version,
		Builtin:     false,
		Transport:   TransportHTTP,
		Permissions: p.manifestPermissions,
	}
}

func (p *remotePlugin) Actions() []Action {
	out := make([]Action, 0, len(p.meta.Actions))
	for _, meta := range p.meta.Actions {
		out = append(out, &remoteAction{meta: meta, client: p.client})
	}
	return out
}

func (p *remotePlugin) SettingsSections() []SettingsSection { return p.meta.Sections }

func (p *remotePlugin) EntryProcessors() []EntryProcessor {
	out := make([]EntryProcessor, 0, len(p.meta.EntryProcessors))
	for _, item := range p.meta.EntryProcessors {
		out = append(out, &remoteEntryProcessor{id: item.ID, client: p.client})
	}
	return out
}

func (p *remotePlugin) FetchClassifiers() []FetchClassifier {
	out := make([]FetchClassifier, 0, len(p.meta.FetchClassifiers))
	for _, item := range p.meta.FetchClassifiers {
		out = append(out, &remoteFetchClassifier{id: item.ID, client: p.client})
	}
	return out
}

// remoteAction 把外部插件的动作包成 plugin.Action（含可选 Test）。
type remoteAction struct {
	meta   remoteActionMeta
	client *RemoteClient
}

func (a *remoteAction) ID() string      { return a.meta.ActionID }
func (a *remoteAction) Label() string   { return a.meta.Label }
func (a *remoteAction) Fields() []Field { return a.meta.Fields }

func (a *remoteAction) Execute(ctx context.Context, req ActionRequest) error {
	return a.client.executeAction(ctx, a.meta.ActionID, req)
}

// Test 实现 ActionTester：插件那边没实现 ActionTester 时返回 ErrActionNotTestable。
func (a *remoteAction) Test(ctx context.Context) error {
	return a.client.TestAction(ctx, a.meta.ActionID)
}

// remoteEntryProcessor 把外部插件的阅读期处理器包成 plugin.EntryProcessor。
// 协议里没有「匹配条件」（v1 由插件自己在 Process 里判断），所以 Matches 恒为 true。
type remoteEntryProcessor struct {
	id     string
	client *RemoteClient
}

func (p *remoteEntryProcessor) ID() string { return p.id }
func (p *remoteEntryProcessor) Matches(_ model.Feed, _ model.Entry) bool {
	return true
}

func (p *remoteEntryProcessor) Process(entry model.Entry) (model.Entry, error) {
	return p.client.processEntry(context.Background(), p.id, model.Feed{}, entry)
}

// remoteFetchClassifier 把外部插件的失败归类器包成 plugin.FetchClassifier。
type remoteFetchClassifier struct {
	id     string
	client *RemoteClient
}

func (c *remoteFetchClassifier) ID() string { return c.id }

func (c *remoteFetchClassifier) Classify(ctx context.Context, feed model.Feed, statusCode int, bodyHead []byte, fetchErr error) string {
	return c.client.classify(ctx, c.id, feed, statusCode, bodyHead, fetchErr)
}

// AttachManifest 给外部插件适配器挂上 manifest 声明（界面贡献 / 视图 / 权限）。
// 宿主拿到的 Plugin 是接口，WithManifest 在包内，所以用这个函数做类型断言；
// 非外部插件（内置、壳、占位）原样返回，不影响。
func AttachManifest(p Plugin, contributions []Contribution, views []View, permissions []string) Plugin {
	if remote, ok := p.(*remotePlugin); ok {
		return remote.WithManifest(contributions, views, permissions)
	}
	return p
}

// invokeAction 把界面直调转给插件进程（56-31）。
// 与 executeAction 的区别：要回 InvokeResult（toast 文案 / 刷新键 / 导出文件），而不只是「成功/失败」。
func (c *RemoteClient) invokeAction(ctx context.Context, actionID string, req InvokeRequest) (InvokeResult, error) {
	var out struct {
		InvokeResult
		Error string `json:"error"`
	}
	path := "/actions/" + actionID + "/invoke"
	if err := c.do(ctx, http.MethodPost, path, req, &out); err != nil {
		return InvokeResult{}, err
	}
	if out.Error != "" {
		return InvokeResult{}, errors.New(out.Error)
	}
	return out.InvokeResult, nil
}

// Invoke 让外部插件的动作支持界面直调（与内置同形）。
// 不做类型断言兜底：插件没实现 Invoker 时由插件侧回 400「action not invokable」。
func (a *remoteAction) Invoke(ctx context.Context, req InvokeRequest) (InvokeResult, error) {
	return a.client.invokeAction(ctx, a.meta.ActionID, req)
}

// Decorate 让外部插件的正文装饰能力与内置同形（56-31）。
// 插件没实现 RenderDecorator 时 SDK 回空数组 ⇒ 这里得到空切片，宿主不会画任何东西。
func (p *remotePlugin) Decorate(ctx context.Context, req DecorateRequest) ([]Decoration, error) {
	return p.client.decorate(ctx, req)
}

func (c *RemoteClient) decorate(ctx context.Context, req DecorateRequest) ([]Decoration, error) {
	var out struct {
		Decorations []Decoration `json:"decorations"`
		Error       string       `json:"error"`
	}
	if err := c.do(ctx, http.MethodPost, "/decorate", req, &out); err != nil {
		return nil, err
	}
	if out.Error != "" {
		return nil, errors.New(out.Error)
	}
	return out.Decorations, nil
}
