package plugin

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Registry 插件注册表。并发安全：启动时 Register，运行时读（dispatch 路径）。
type Registry struct {
	mu      sync.RWMutex
	plugins map[string]Plugin
	actions map[string]Action // key = pluginID + "." + actionID
	enabled map[string]bool
}

// ActionMeta 一个动作的清单项（规则编辑器 / 设置页都用它渲染）。
type ActionMeta struct {
	PluginID   string  `json:"pluginId"`
	PluginName string  `json:"pluginName"`
	ActionID   string  `json:"actionId"`
	Label      string  `json:"label"`
	Fields     []Field `json:"fields"`
	Enabled    bool    `json:"enabled"`
}

// CatalogItem 一个插件的完整清单。
type CatalogItem struct {
	Meta
	Enabled  bool              `json:"enabled"`
	Actions  []ActionMeta      `json:"actions"`
	Sections []SettingsSection `json:"sections"`
	// LastError 外部插件最近一次故障原因（宿主填；非空 ⇒ UI 显示「崩溃 / 启动失败」）。
	LastError string `json:"lastError,omitempty"`
}

func NewRegistry() *Registry {
	return &Registry{
		plugins: make(map[string]Plugin),
		actions: make(map[string]Action),
		enabled: make(map[string]bool),
	}
}

func actionKey(pluginID, actionID string) string { return pluginID + "." + actionID }

// Register 注册一个插件（内置插件由各包 init() 调）。默认启用；
// DB 里有记录时由 LoadEnabled 覆盖。重复 id / 空 id / 重复动作都报错。
func (r *Registry) Register(p Plugin) error {
	if p == nil {
		return fmt.Errorf("plugin: Register(nil)")
	}
	meta := p.Meta()
	if meta.ID == "" {
		return fmt.Errorf("plugin: Meta().ID 不能为空")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.plugins[meta.ID]; dup {
		return fmt.Errorf("plugin: 重复注册 %q", meta.ID)
	}
	r.plugins[meta.ID] = p
	// 首次启停位：Meta.DefaultEnabled 说了算；nil = 默认启用（稳定能力的口径）。
	// DB 里有记录时由 LoadEnabled 覆盖（service.ensureBuiltin 负责落库）。
	on := true
	if meta.DefaultEnabled != nil {
		on = *meta.DefaultEnabled
	}
	r.enabled[meta.ID] = on
	for _, action := range p.Actions() {
		if action.ID() == "" {
			return fmt.Errorf("plugin %s: Action.ID() 不能为空", meta.ID)
		}
		key := actionKey(meta.ID, action.ID())
		if _, dup := r.actions[key]; dup {
			return fmt.Errorf("plugin: 重复动作 %q", key)
		}
		r.actions[key] = action
	}
	return nil
}

// LoadEnabled 用 DB 启停记录覆盖默认值（启动时调一次）。
// 表里没有的插件保持默认启用；表里多出来的 id（插件代码已不在）忽略。
func (r *Registry) LoadEnabled(states map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id := range r.plugins {
		if on, ok := states[id]; ok {
			r.enabled[id] = id != "" && on
		}
	}
}

// EnabledStates 导出当前启停（service 落库 / 比对用）。
func (r *Registry) EnabledStates() map[string]bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]bool, len(r.enabled))
	for id, on := range r.enabled {
		out[id] = on
	}
	return out
}

// SetEnabled 改内存启停（PATCH 接口调它；DB 由 service 负责落）。返回 false = 插件不存在。
func (r *Registry) SetEnabled(id string, on bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.plugins[id]; !ok {
		return false
	}
	r.enabled[id] = on
	return true
}

func (r *Registry) Enabled(id string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.enabled[id]
}

// Unregister 摘除一个插件（外部插件停用 / 卸载 / 重装时用）。返回 false = 本来就不在。
// 动作、启停位一并删干净，免得残留的 dispatch 键指向死进程。
func (r *Registry) Unregister(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.plugins[id]; !ok {
		return false
	}
	delete(r.plugins, id)
	delete(r.enabled, id)
	for key := range r.actions {
		if pluginID, _, found := strings.Cut(key, "."); found && pluginID == id {
			delete(r.actions, key)
		}
	}
	return true
}

// Meta 查一个插件的元信息（transport 已兜底）；外部插件宿主用它区分两条轨。
func (r *Registry) Meta(id string) (Meta, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.plugins[id]
	if !ok {
		return Meta{}, false
	}
	return withTransport(p.Meta()), true
}

// withTransport 输出侧兜底：老内置插件没写 Transport ⇒ "builtin"。
func withTransport(meta Meta) Meta {
	if meta.Transport == "" {
		meta.Transport = TransportBuiltin
	}
	return meta
}

// LookupAction 查动作本体，**不管启停**（引擎要区分「没装」与「停用」两种错误文案）。
func (r *Registry) LookupAction(pluginID, actionID string) (Action, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	action, ok := r.actions[actionKey(pluginID, actionID)]
	return action, ok
}

// Plugins 全部插件元信息（按 ID 排序，保证输出稳定）。
func (r *Registry) Plugins() []Meta {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Meta, 0, len(r.plugins))
	for _, p := range r.plugins {
		out = append(out, withTransport(p.Meta()))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Catalog 完整清单（设置页 / 规则编辑器一份数据）。
func (r *Registry) Catalog() []CatalogItem {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]CatalogItem, 0, len(r.plugins))
	for _, p := range r.plugins {
		meta := withTransport(p.Meta())
		item := CatalogItem{
			Meta:     meta,
			Enabled:  r.enabled[meta.ID],
			Sections: p.SettingsSections(),
		}
		for _, action := range p.Actions() {
			item.Actions = append(item.Actions, ActionMeta{
				PluginID:   meta.ID,
				PluginName: meta.Name,
				ActionID:   action.ID(),
				Label:      action.Label(),
				Fields:     action.Fields(),
				Enabled:    r.enabled[meta.ID],
			})
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// EntryProcessors 全部**已启用**插件的阅读期处理器（按插件 ID 排序，顺序稳定）。
func (r *Registry) EntryProcessors() []EntryProcessor {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []EntryProcessor
	for _, p := range r.plugins {
		if !r.enabled[p.Meta().ID] {
			continue
		}
		out = append(out, p.EntryProcessors()...)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID() < out[j].ID() })
	return out
}

// FetchClassifiers 全部**已启用**插件的抓取失败归类器。
func (r *Registry) FetchClassifiers() []FetchClassifier {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []FetchClassifier
	for _, p := range r.plugins {
		if !r.enabled[p.Meta().ID] {
			continue
		}
		out = append(out, p.FetchClassifiers()...)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID() < out[j].ID() })
	return out
}
