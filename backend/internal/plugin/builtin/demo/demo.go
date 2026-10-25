// Package demo 插件机制样板：一个最小但四个扩展点齐活的内置插件。
//
// 它的存在是为了证明「注册 → 启停 → 规则引用 → dispatch → 阅读期处理 → 设置页渲染」
// 整条链路是通的（真机可见），并给后来的插件作者当参照。**默认停用**（Meta.DefaultEnabled=false），
// 真实站点优化照这个样式在 builtin/（或外部插件目录）加包即可，本体零改动。
package demo

import (
	"context"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/pkg/logger"
)

func init() { plugin.MustRegister(New()) }

// New 造插件实例（内置轨：main.go blank import 本包即完成注册）。
func New() plugin.Plugin { return Plugin{} }

// Plugin demo 插件：一个动作 + 一个阅读期处理器 + 一个永远不认的分类器。
// 没有需要持久化的设置 ⇒ SettingsSections 返回空。
type Plugin struct{}

func boolPtr(v bool) *bool { return &v }

func (Plugin) Meta() plugin.Meta {
	return plugin.Meta{
		ID:             "demo",
		Name:           "Demo 插件（样板）",
		Description:    "插件机制的最小完整样例：动作 / 阅读期处理 / 失败分类各一个。默认停用，启用后可在规则里引用它的动作。",
		Version:        "1.0.0",
		Builtin:        true,
		DefaultEnabled: boolPtr(false),
	}
}

func (Plugin) Actions() []plugin.Action                   { return []plugin.Action{logAction{}} }
func (Plugin) SettingsSections() []plugin.SettingsSection { return nil }
func (Plugin) EntryProcessors() []plugin.EntryProcessor {
	return []plugin.EntryProcessor{markerProcessor{}}
}
func (Plugin) FetchClassifiers() []plugin.FetchClassifier {
	return []plugin.FetchClassifier{neverClassifier{}}
}

// logAction 命中后写一条日志（证明 dispatch 链路通了；后端日志可见）。
type logAction struct{}

func (logAction) ID() string    { return "log" }
func (logAction) Label() string { return "写一条调试日志（demo）" }
func (logAction) Fields() []plugin.Field {
	return []plugin.Field{{Key: "note", Label: "附带一句话（可选）", Type: "text"}}
}

func (logAction) Execute(_ context.Context, req plugin.ActionRequest) error {
	logger.Info("demo plugin action fired",
		"module", "plugin", "action", "demo.log", "resource", "filter",
		"result", "ok", "filter_id", req.Filter.ID, "entry_id", req.Entry.ID, "note", req.Config["note"])
	return nil
}

// markerProcessor 给正文末尾加一行（证明阅读期处理链路通了；真机可见）。
type markerProcessor struct{}

func (markerProcessor) ID() string                               { return "demo-marker" }
func (markerProcessor) Matches(_ model.Feed, _ model.Entry) bool { return true }
func (markerProcessor) Process(entry model.Entry) (model.Entry, error) {
	marker := `<hr><p><em>[demo 插件处理过本条]</em></p>`
	if entry.Content == nil {
		entry.Content = &marker
		return entry, nil
	}
	merged := *entry.Content + marker
	entry.Content = &merged
	return entry, nil
}

// neverClassifier 永远不认（证明分类链的「不认就透传」分支）。
type neverClassifier struct{}

func (neverClassifier) ID() string { return "demo-never" }
func (neverClassifier) Classify(_ context.Context, _ model.Feed, _ int, _ []byte, _ error) string {
	return ""
}
