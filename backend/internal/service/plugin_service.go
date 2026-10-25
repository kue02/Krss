//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"strings"

	"krss/backend/internal/plugin"
	"krss/backend/internal/repository"
)

// PluginMaskedValue 出接口的掩码（凭据不进前端、不进日志；照 MCP 的 ••••••••）。
const PluginMaskedValue = "••••••••"

// IsMaskedPluginValue 前端回传的是不是「没改过的掩码值」——是就保持原值。
func IsMaskedPluginValue(value string) bool { return value == PluginMaskedValue }

// PluginSettingsResult 一个插件的设置值（secret 字段掩码）。
type PluginSettingsResult struct {
	Values map[string]string `json:"values"`
}

type PluginService interface {
	// Catalog 全部插件清单（含能力）。顺带做两件事：
	//   ① ensureBuiltin —— 表里没有的内置插件补进行（bark/rsshub 默认开 ⇒ 行为零变化；demo 默认关）
	//   ② ensureExternal —— 扫 $KRSS_DATA_DIR/plugins/，新发现的外部插件读 manifest、落库、拉起（55-7b）
	// 所以「清单接口」本身就是安装/卸载的发现通道：设置页每次打开都会过一次。
	Catalog(ctx context.Context) ([]plugin.CatalogItem, error)
	// SetEnabled 改启停：内存注册表即时生效 + 落库。
	SetEnabled(ctx context.Context, id string, enabled bool) ([]plugin.CatalogItem, error)
	// GetSettings 读插件设置（secret 掩码）。
	GetSettings(ctx context.Context, id string) (PluginSettingsResult, error)
	// PutSettings 写插件设置；值为掩码 = 不改这一项。
	PutSettings(ctx context.Context, id string, values map[string]string) (PluginSettingsResult, error)
	// TestAction 让动作自己发一条测试（Bark「发送测试推送」）。
	TestAction(ctx context.Context, id, actionID string) error
}

type pluginService struct {
	registry *plugin.Registry
	plugins  repository.PluginRepository
	settings repository.SettingsRepository
}

func NewPluginService(registry *plugin.Registry, plugins repository.PluginRepository, settings repository.SettingsRepository) PluginService {
	return &pluginService{registry: registry, plugins: plugins, settings: settings}
}

// ensureBuiltin 把表里没有的内置插件补进行（默认启用 ⇒ 老实例升级后行为零变化）。
// 首次落库的启用位按 Meta.DefaultEnabled：nil = 开；demo 这类样板设 false ⇒ 装而不启。
func (s *pluginService) ensureBuiltin(ctx context.Context) error {
	existing := make(map[string]bool)
	states, err := s.plugins.List(ctx)
	if err != nil {
		return err
	}
	for _, st := range states {
		existing[st.ID] = st.Enabled
	}
	for _, meta := range s.registry.Plugins() {
		if _, ok := existing[meta.ID]; ok {
			continue
		}
		enabled := true
		if meta.DefaultEnabled != nil {
			enabled = *meta.DefaultEnabled
		}
		if err := s.plugins.Upsert(ctx, meta.ID, enabled); err != nil {
			return err
		}
	}
	// 用库里的记录覆盖注册表默认值
	loaded := make(map[string]bool, len(states))
	for _, st := range states {
		loaded[st.ID] = st.Enabled
	}
	s.registry.LoadEnabled(loaded)
	return nil
}

func (s *pluginService) Catalog(ctx context.Context) ([]plugin.CatalogItem, error) {
	if err := s.ensureBuiltin(ctx); err != nil {
		return nil, err
	}
	return s.registry.Catalog(), nil
}

func (s *pluginService) SetEnabled(ctx context.Context, id string, enabled bool) ([]plugin.CatalogItem, error) {
	if err := s.ensureBuiltin(ctx); err != nil {
		return nil, err
	}
	if !s.registry.SetEnabled(id, enabled) {
		return nil, ErrPluginNotFound
	}
	if err := s.plugins.Upsert(ctx, id, enabled); err != nil {
		return nil, err
	}
	return s.registry.Catalog(), nil
}

// settingsPrefix 插件设置键前缀（与 plugin.Settings 同一约定）。
func settingsPrefix(id string) string { return "plugin." + id + "." }

// secretFieldKeys 该插件全部 secret 字段的完整键（掩码判断用）。
func (s *pluginService) secretFieldKeys(id string) map[string]bool {
	out := map[string]bool{}
	for _, item := range s.registry.Catalog() {
		if item.ID != id {
			continue
		}
		for _, section := range item.Sections {
			for _, key := range plugin.SecretKeys(item.Meta, section.Fields) {
				out[key] = true
			}
		}
		for _, action := range item.Actions {
			for _, key := range plugin.SecretKeys(item.Meta, action.Fields) {
				out[key] = true
			}
		}
	}
	return out
}

func (s *pluginService) GetSettings(ctx context.Context, id string) (PluginSettingsResult, error) {
	if err := s.ensureBuiltin(ctx); err != nil {
		return PluginSettingsResult{}, err
	}
	setting, err := s.settings.GetByPrefix(ctx, settingsPrefix(id))
	if err != nil {
		return PluginSettingsResult{}, err
	}
	secrets := s.secretFieldKeys(id)
	values := make(map[string]string, len(setting))
	for _, setting := range setting {
		key := strings.TrimPrefix(setting.Key, settingsPrefix(id))
		if secrets[setting.Key] && setting.Value != "" {
			values[key] = PluginMaskedValue
			continue
		}
		values[key] = setting.Value
	}
	return PluginSettingsResult{Values: values}, nil
}

func (s *pluginService) PutSettings(ctx context.Context, id string, values map[string]string) (PluginSettingsResult, error) {
	if err := s.ensureBuiltin(ctx); err != nil {
		return PluginSettingsResult{}, err
	}
	secrets := s.secretFieldKeys(id)
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			continue
		}
		full := settingsPrefix(id) + key
		// 掩码回传 = 用户没改这一项：保持原值（没有就什么都不写）
		if secrets[full] && IsMaskedPluginValue(value) {
			continue
		}
		if err := s.settings.Set(ctx, full, value); err != nil {
			return PluginSettingsResult{}, err
		}
	}
	return s.GetSettings(ctx, id)
}

func (s *pluginService) TestAction(ctx context.Context, id, actionID string) error {
	if err := s.ensureBuiltin(ctx); err != nil {
		return err
	}
	action, ok := s.registry.LookupAction(id, actionID)
	if !ok {
		return ErrPluginNotFound
	}
	if !s.registry.Enabled(id) {
		return ErrPluginDisabled
	}
	tester, ok := action.(plugin.ActionTester)
	if !ok {
		return ErrPluginActionNotTestable
	}
	return tester.Test(ctx)
}
