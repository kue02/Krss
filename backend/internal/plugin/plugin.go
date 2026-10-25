// Package plugin 插件模块：本体（核心 = 阅读体验与管理）与「特化优化」之间的契约层。
//
// 形态（v1，已拍板）：进程内注册表 + 内置插件。每个内置插件在自己的包里 init() 自注册，
// main.go 用一条 blank import 登记；启停是 plugins 表一行。不提供 .so / 子进程运行时加载
// （项目无 CGO，且自用单实例看不到收益）——「怎么加一个插件」见 docs/dev/插件模块.md。
package plugin

import (
	"context"
	"fmt"
	"strings"

	"krss/backend/internal/model"
)

// Meta 插件元信息（manifest 的 Go 形态）。
type Meta struct {
	ID          string `json:"id"`          // "bark" —— 全局唯一，规则引用它
	Name        string `json:"name"`        // "Bark 推送"
	Description string `json:"description"` // 一句话说明这个插件干什么
	Version     string `json:"version"`
	Builtin     bool   `json:"builtin"` // true = 随二进制分发（不可卸载，只能停用）
}

// Field 插件声明的一个配置字段（设置段与规则动作共用；前端按 Type 动态渲染）。
type Field struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Type        string   `json:"type"` // "text" | "secret" | "select" | "bool"
	Required    bool     `json:"required"`
	Placeholder string   `json:"placeholder,omitempty"`
	Help        string   `json:"help,omitempty"`
	Options     []Option `json:"options,omitempty"`
}

type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// SettingsSection 插件往设置弹窗贡献的一段（标题 + 字段）。
type SettingsSection struct {
	ID     string  `json:"id"`
	Title  string  `json:"title"`
	Fields []Field `json:"fields"`
}

// Plugin 一个插件。四个扩展点都可以返回空 —— 声明什么能力就拿什么启用理由。
type Plugin interface {
	Meta() Meta
	// Actions 自动化（过滤规则）的动作扩展点；引擎按 (Meta.ID, Action.ID) dispatch。
	Actions() []Action
	// SettingsSections 设置弹窗「插件」页里渲染的段。
	SettingsSections() []SettingsSection
	// EntryProcessors 阅读期处理（对某类订阅源的特别优化；挂在条目详情读取路径）。
	EntryProcessors() []EntryProcessor
	// FetchClassifiers 抓取失败归类（返回空串 = 不认这次失败，交给下一家）。
	FetchClassifiers() []FetchClassifier
}

// ActionRequest 一次命中递给动作执行器的上下文（与 webhook 投递同源）。
type ActionRequest struct {
	Filter model.Filter
	Feed   model.Feed
	Entry  model.Entry
	// Config 规则里存的该动作配置（各插件在自己 Fields() 里声明形状）。
	Config map[string]string
}

// Action 自动化规则的动作扩展点（Bark 推送是第一个真实实现）。
type Action interface {
	ID() string
	Label() string
	Fields() []Field
	Execute(ctx context.Context, req ActionRequest) error
}

// ActionTester 可选接口：动作能自己发一条测试（Bark 的「发送测试推送」搬过来）。
type ActionTester interface {
	Test(ctx context.Context) error
}

// EntryProcessor 阅读体验扩展点：对某类订阅源的特别优化落在这一层。
// Matches 决定要不要跑；Process 返回处理后的条目。出错由调用方兜底（返回原条目）。
type EntryProcessor interface {
	ID() string
	Matches(feed model.Feed, entry model.Entry) bool
	Process(entry model.Entry) (model.Entry, error)
}

// FetchClassifier 抓取失败归类扩展点（RSSHub 错误页是第一个真实实现）。
type FetchClassifier interface {
	ID() string
	// Classify 把一次失败归成用户可读的原因；空串 = 不认，调用方按原样透传。
	Classify(ctx context.Context, feed model.Feed, statusCode int, bodyHead []byte, fetchErr error) string
}

// SettingsStore 插件设置存储的最小面（repository.SettingsRepository 天然满足它）。
type SettingsStore interface {
	Get(ctx context.Context, key string) (*model.Setting, error)
	Set(ctx context.Context, key, value string) error
	Delete(ctx context.Context, key string) error
}

// Settings 插件侧设置助手：键统一加 plugin.<插件 id>. 前缀，插件不许碰别人的键。
type Settings struct {
	PluginID string
	Store    SettingsStore
}

func (s Settings) fullKey(key string) string {
	return "plugin." + s.PluginID + "." + key
}

// Get 读一个插件设置；没配过返回空串（不区分「没配」与「配了空」）。
func (s Settings) Get(ctx context.Context, key string) string {
	if s.Store == nil || strings.TrimSpace(key) == "" {
		return ""
	}
	setting, err := s.Store.Get(ctx, s.fullKey(key))
	if err != nil || setting == nil {
		return ""
	}
	return strings.TrimSpace(setting.Value)
}

func (s Settings) Set(ctx context.Context, key, value string) error {
	if s.Store == nil {
		return fmt.Errorf("plugin %s: settings store 未安装", s.PluginID)
	}
	return s.Store.Set(ctx, s.fullKey(key), value)
}

// SecretKeys 返回该插件设置里属凭证的完整键（导出设置时要排除；守门测试用它）。
// 约定：字段 Type=secret 的完整键 = plugin.<id>.<field key>。
func SecretKeys(meta Meta, fields []Field) []string {
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if f.Type == "secret" {
			out = append(out, "plugin."+meta.ID+"."+f.Key)
		}
	}
	return out
}

// Default 包级默认注册表（内置插件 init() 时往里注册；main.go 拿它接线）。
var Default = NewRegistry()

// MustRegister 向 Default 注册，失败即 panic（启动期硬失败）。
func MustRegister(p Plugin) { if err := Default.Register(p); err != nil { panic(err) } }
