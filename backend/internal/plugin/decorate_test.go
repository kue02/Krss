package plugin_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
)

// decoratorPlugin test-only 假插件：声明一段正文装饰（56-21），其它扩展点全空。
type decoratorPlugin struct {
	id string
}

func (p decoratorPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: p.id, Name: p.id, Builtin: true}
}
func (p decoratorPlugin) Actions() []plugin.Action                   { return nil }
func (p decoratorPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p decoratorPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p decoratorPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }
func (p decoratorPlugin) Decorate(_ context.Context, req plugin.DecorateRequest) ([]plugin.Decoration, error) {
	return []plugin.Decoration{{ID: p.id + "-mark", Start: 0, End: len(req.Text), Style: "highlight"}}, nil
}

// plainPlugin test-only 假插件：正常插件但**不实现** RenderDecorator（装饰聚合要跳过它）。
type plainPlugin struct {
	id string
}

func (p plainPlugin) Meta() plugin.Meta                          { return plugin.Meta{ID: p.id, Name: p.id, Builtin: true} }
func (p plainPlugin) Actions() []plugin.Action                   { return nil }
func (p plainPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p plainPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p plainPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

// TestRegistry_Decorations_EnabledOnly Decorators() 只收「已启用的、真实现了装饰接口的」插件，且带插件 id。
func TestRegistry_Decorations_EnabledOnly(t *testing.T) {
	r := plugin.NewRegistry()
	require.NoError(t, r.Register(decoratorPlugin{id: "aaa-deco"}))
	require.NoError(t, r.Register(decoratorPlugin{id: "bbb-deco"}))
	// 没实现 RenderDecorator 的插件不该出现在装饰清单里
	require.NoError(t, r.Register(plainPlugin{id: "ccc-plain"}))

	got := r.Decorators()
	require.Len(t, got, 2, "只收实现了 RenderDecorator 的插件")
	require.Equal(t, "aaa-deco", got[0].PluginID, "按插件 id 排序，顺序稳定")
	require.Equal(t, "bbb-deco", got[1].PluginID)
	require.NotNil(t, got[0].Decorator)

	// 停用的插件不进装饰链（启停位是用户的意思表示）
	require.True(t, r.SetEnabled("bbb-deco", false))
	got = r.Decorators()
	require.Len(t, got, 1)
	require.Equal(t, "aaa-deco", got[0].PluginID)
}
