// Package sdk 把实现了 plugin.Plugin 的包托管成外部进程插件（55-7c）。
//
// 与内置轨同一份契约代码：插件作者写 Go 接口，编进 krss（内置轨）或编成 pluginsrv（外部轨），二选一。
// 通信走 Unix socket + JSON（协议表见 docs/dev/插件模块.md；宿主侧是 internal/plugin/remote.go）：
//
//	GET  /ready                     就绪探针
//	GET  /meta                      Meta + 各扩展点清单
//	GET  /settings · PUT /settings  插件设置（存插件目录下的 settings.json）
//	POST /actions/:actionId/execute 动作执行（ActionRequest → {} / {"error"}）
//	POST /actions/:actionId/test    动作自测（{} → {} / {"error"}）
//	POST /entry-processors/:id      阅读期处理（{feed, entry} → {entry}）
//	POST /fetch-classifiers/:id     失败归类（{feed, statusCode, bodyHead, error} → {message}）
//	GET  /ui/<rest>                 插件自带界面资源（56-26：实现 plugin.UIAssets 即可；
//	                                bridge.js 由 SDK 自己发，插件不必带）
//
// 安全：只听 krss 建好的 Unix socket（0600），token 从 KRSS_PLUGIN_SOCKET/TOKEN 环境变量拿，
// 每个请求都要带 X-Krss-Plugin-Token。不开 TCP、不监听局域网。
package sdk

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
)

// Serve 起 Unix socket 服务并阻塞到 ctx 取消 / 进程收到信号。
// p 是插件实现；socket 路径与 token 由宿主通过环境变量注入。
func Serve(ctx context.Context, p plugin.Plugin) error {
	socketPath := strings.TrimSpace(os.Getenv("KRSS_PLUGIN_SOCKET"))
	if socketPath == "" {
		return errors.New("sdk: KRSS_PLUGIN_SOCKET 未设置（应由 krss 宿主注入）")
	}
	token := strings.TrimSpace(os.Getenv("KRSS_PLUGIN_TOKEN"))
	if token == "" {
		return errors.New("sdk: KRSS_PLUGIN_TOKEN 未设置（应由 krss 宿主注入）")
	}

	srv := &server{plugin: p, token: token, store: newFileSettings(socketPath)}
	mux := srv.routes()

	// 直接 listen 宿主给的 socket 文件路径；权限 0600（krss 单用户进程拥有）。
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("sdk: listen %s: %w", socketPath, err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		return fmt.Errorf("sdk: chmod %s: %w", socketPath, err)
	}

	httpSrv := &http.Server{Handler: auth(token, mux)}
	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.Serve(listener) }()

	select {
	case <-ctx.Done():
		_ = httpSrv.Close()
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// auth 每个请求都校验 token（本地 socket 也不是裸奔）。
func auth(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Krss-Plugin-Token") != token {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "bad token"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

type server struct {
	plugin plugin.Plugin
	token  string
	store  *fileSettings
}

// routes 全部路由。单独拆出来是为了让 /ui/ 这类不经过 socket 的路径也能在 httptest 里整条测
// （Serve 负责 listen/chmod/signal，没法定点打某一个 handler）。
func (s *server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/ready", s.ok)
	mux.HandleFunc("/meta", s.meta)
	mux.HandleFunc("/settings", s.settings)
	mux.HandleFunc("/actions/", s.action)
	mux.HandleFunc("/entry-processors/", s.entryProcessor)
	mux.HandleFunc("/fetch-classifiers/", s.fetchClassifier)
	mux.HandleFunc("/decorate", s.decorate)
	mux.HandleFunc("/ui/", s.uiAsset)
	return mux
}

func (s *server) ok(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }

type metaResponse struct {
	ID               string                   `json:"id"`
	Name             string                   `json:"name"`
	Description      string                   `json:"description"`
	Version          string                   `json:"version"`
	Builtin          bool                     `json:"builtin"`
	APIVersion       int                      `json:"apiVersion"`
	Actions          []actionMetaJSON         `json:"actions"`
	Sections         []plugin.SettingsSection `json:"sections"`
	EntryProcessors  []idOnly                 `json:"entryProcessors"`
	FetchClassifiers []idOnly                 `json:"fetchClassifiers"`
}

type actionMetaJSON struct {
	ActionID string         `json:"actionId"`
	Label    string         `json:"label"`
	Fields   []plugin.Field `json:"fields"`
}

type idOnly struct {
	ID string `json:"id"`
}

func (s *server) meta(w http.ResponseWriter, _ *http.Request) {
	meta := s.plugin.Meta()
	// 外部实例的身份以 manifest（宿主）为准：宿主通过 KRSS_PLUGIN_ID 注入，覆盖包内 Meta.ID。
	// （同一个 demo 包编成内置轨时 id=demo、编成外部轨放进 demo-ext/ 时 id=demo-ext）
	if override := strings.TrimSpace(os.Getenv("KRSS_PLUGIN_ID")); override != "" {
		meta.ID = override
		meta.Builtin = false
	}
	out := metaResponse{
		ID:          meta.ID,
		Name:        meta.Name,
		Description: meta.Description,
		Version:     meta.Version,
		Builtin:     meta.Builtin,
		APIVersion:  plugin.ProtocolVersion,
		Sections:    s.plugin.SettingsSections(),
	}
	for _, action := range s.plugin.Actions() {
		out.Actions = append(out.Actions, actionMetaJSON{ActionID: action.ID(), Label: action.Label(), Fields: action.Fields()})
	}
	for _, p := range s.plugin.EntryProcessors() {
		out.EntryProcessors = append(out.EntryProcessors, idOnly{ID: p.ID()})
	}
	for _, c := range s.plugin.FetchClassifiers() {
		out.FetchClassifiers = append(out.FetchClassifiers, idOnly{ID: c.ID()})
	}
	writeJSON(w, out)
}

func (s *server) settings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]interface{}{"values": s.store.All()})
	case http.MethodPut:
		var body struct {
			Values map[string]string `json:"values"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if err := s.store.Replace(body.Values); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, map[string]interface{}{"values": s.store.All()})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *server) action(w http.ResponseWriter, r *http.Request) {
	// /actions/:actionId/execute 或 /actions/:actionId/test
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 3 || parts[0] != "actions" {
		writeError(w, http.StatusNotFound, errors.New("not found"))
		return
	}
	actionID, mode := parts[1], parts[2]

	var target plugin.Action
	for _, action := range s.plugin.Actions() {
		if action.ID() == actionID {
			target = action
			break
		}
	}
	if target == nil {
		writeError(w, http.StatusNotFound, fmt.Errorf("action %q not found", actionID))
		return
	}

	switch mode {
	case "execute":
		var req plugin.ActionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if err := target.Execute(r.Context(), req); err != nil {
			writeJSON(w, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]string{})
	case "invoke":
		// 56-31：界面直调（右键菜单/工具栏/正文浮动条）。动作没实现 plugin.Invoker 就 400。
		invoker, ok := target.(plugin.Invoker)
		if !ok {
			writeError(w, http.StatusBadRequest, errors.New("action not invokable"))
			return
		}
		var req plugin.InvokeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		result, err := invoker.Invoke(r.Context(), req)
		if err != nil {
			writeJSON(w, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, result)
	case "test":
		tester, ok := target.(plugin.ActionTester)
		if !ok {
			writeError(w, http.StatusBadRequest, errors.New("action not testable"))
			return
		}
		if err := tester.Test(r.Context()); err != nil {
			writeJSON(w, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]string{})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (s *server) entryProcessor(w http.ResponseWriter, r *http.Request) {
	id := lastPathSegment(r.URL.Path)
	var target plugin.EntryProcessor
	for _, p := range s.plugin.EntryProcessors() {
		if p.ID() == id {
			target = p
			break
		}
	}
	if target == nil {
		writeError(w, http.StatusNotFound, fmt.Errorf("entry processor %q not found", id))
		return
	}
	var body struct {
		Feed  model.Feed  `json:"feed"`
		Entry model.Entry `json:"entry"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	out, err := target.Process(r.Context(), body.Entry)
	if err != nil {
		writeJSON(w, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, map[string]interface{}{"entry": out})
}

func (s *server) fetchClassifier(w http.ResponseWriter, r *http.Request) {
	id := lastPathSegment(r.URL.Path)
	var target plugin.FetchClassifier
	for _, c := range s.plugin.FetchClassifiers() {
		if c.ID() == id {
			target = c
			break
		}
	}
	if target == nil {
		writeError(w, http.StatusNotFound, fmt.Errorf("fetch classifier %q not found", id))
		return
	}
	var body struct {
		Feed       model.Feed `json:"feed"`
		StatusCode int        `json:"statusCode"`
		BodyHead   string     `json:"bodyHead"` // base64
		Error      string     `json:"error"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	raw, _ := base64.StdEncoding.DecodeString(body.BodyHead)
	var fetchErr error
	if body.Error != "" {
		fetchErr = errors.New(body.Error)
	}
	message := target.Classify(r.Context(), body.Feed, body.StatusCode, raw, fetchErr)
	writeJSON(w, map[string]string{"message": message})
}

func lastPathSegment(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	return parts[len(parts)-1]
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

// fileSettings 插件设置存插件目录下的 settings.json（外部插件不碰 krss 的 DB）。
type fileSettings struct {
	mu   sync.Mutex
	path string
}

func newFileSettings(socketPath string) *fileSettings {
	// socket 与 settings.json 同放插件目录（宿主把 socket 建在 plugins/<id>/ 下）
	return &fileSettings{path: filepath.Join(filepath.Dir(socketPath), "settings.json")}
}

func (f *fileSettings) All() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]string{}
	raw, err := os.ReadFile(f.path)
	if err != nil {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}

func (f *fileSettings) Replace(values map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if values == nil {
		values = map[string]string{}
	}
	raw, err := json.MarshalIndent(values, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(f.path, raw, 0o600)
}

// decorate 正文装饰（56-31）：把「哪一段、什么样式」交回宿主画。
// 插件没实现 RenderDecorator 时回空数组而不是报错 —— 宿主对每个启用插件都会问一遍，
// 报错会变成每条目每次阅读都刷一条 warning。
func (s *server) decorate(w http.ResponseWriter, r *http.Request) {
	decorator, ok := s.plugin.(plugin.RenderDecorator)
	if !ok {
		writeJSON(w, map[string]any{"decorations": []plugin.Decoration{}})
		return
	}
	var req plugin.DecorateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	items, err := decorator.Decorate(r.Context(), req)
	if err != nil {
		writeJSON(w, map[string]string{"error": err.Error()})
		return
	}
	if items == nil {
		items = []plugin.Decoration{}
	}
	writeJSON(w, map[string]any{"decorations": items})
}
