package plugin_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
)

// defaultOffPlugin 声明 DefaultEnabled=false 的假插件。
type defaultOffPlugin struct{}

func (defaultOffPlugin) Meta() plugin.Meta {
	off := false
	return plugin.Meta{ID: "default-off", Name: "Default Off", Builtin: true, DefaultEnabled: &off}
}
func (defaultOffPlugin) Actions() []plugin.Action                   { return nil }
func (defaultOffPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (defaultOffPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (defaultOffPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

// TestRegistry_DefaultEnabledFalse：Meta.DefaultEnabled=false 的插件注册后默认停用；
// 没声明的（nil）仍旧默认启用；DB 记录（LoadEnabled）优先于两者。
func TestRegistry_DefaultEnabledFalse(t *testing.T) {
	r := plugin.NewRegistry()
	require.NoError(t, r.Register(defaultOffPlugin{}))
	require.NoError(t, r.Register(fakePlugin{}), "没声明 DefaultEnabled 的仍旧默认开")

	require.False(t, r.Enabled("default-off"), "DefaultEnabled=false ⇒ 装而不启")
	require.True(t, r.Enabled("demo"))

	r.LoadEnabled(map[string]bool{"default-off": true, "demo": false})
	require.True(t, r.Enabled("default-off"), "DB 记录优先：用户显式启用过")
	require.False(t, r.Enabled("demo"), "DB 记录优先：用户显式停用过")
}
