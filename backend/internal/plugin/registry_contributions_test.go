package plugin_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
)

// contributionPlugin test-only 假插件：只贡献界面项，其它扩展点全空。
type contributionPlugin struct {
	id    string
	items []plugin.Contribution
}

func (p contributionPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: p.id, Name: p.id, Builtin: true}
}
func (p contributionPlugin) Actions() []plugin.Action                   { return nil }
func (p contributionPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p contributionPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p contributionPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }
func (p contributionPlugin) Contributions() []plugin.Contribution       { return p.items }

// pluginAAA 四条：1 条合法 + 1 条未知 surface + 1 条没 action + 1 条与合法项同 surface 同 id 的重复项。
func pluginAAA() contributionPlugin {
	return contributionPlugin{id: "aaa-demo", items: []plugin.Contribution{
		{ID: "a-open", Surface: plugin.SurfaceEntryContextMenu, Action: "open", Label: "打开"},
		{ID: "a-unknown", Surface: plugin.Surface("entry.whatever"), Action: "open", Label: "自造位置"},
		{ID: "a-noaction", Surface: plugin.SurfaceEntryListToolbar, Label: "没有动作"},
		{ID: "a-open", Surface: plugin.SurfaceEntryContextMenu, Action: "dup", Label: "重复 id"},
	}}
}

func pluginBBB() contributionPlugin {
	return contributionPlugin{id: "bbb-demo", items: []plugin.Contribution{
		{ID: "b-open", Surface: plugin.SurfaceEntryListToolbar, Action: "open", Label: "B 的按钮", Selection: plugin.SelectionMulti},
	}}
}

// TestRegistry_Contributions_Sanitize 未知 surface / 空 action / 同 surface 同 id 重复项全部丢掉，Selection 兜底 none。
func TestRegistry_Contributions_Sanitize(t *testing.T) {
	r := plugin.NewRegistry()
	require.NoError(t, r.Register(pluginAAA()))
	require.NoError(t, r.Register(pluginBBB()))

	surfaces := r.AllContributions()

	require.Len(t, surfaces[plugin.SurfaceEntryContextMenu], 1, "A 的四条只能剩一条")
	a := surfaces[plugin.SurfaceEntryContextMenu][0]
	require.Equal(t, "a-open", a.ID)
	require.Equal(t, "open", a.Action, "重复项里的 dup 不该顶掉先到的那条")
	require.Equal(t, plugin.SelectionNone, a.Selection, "没声明 selection 时补 none")
	require.NotEmpty(t, a.Plugin, "归属插件必须由宿主注入")

	b := surfaces[plugin.SurfaceEntryListToolbar]
	require.Len(t, b, 1, "B 的合法项要在册，A 的空 action 项不在")
	require.Equal(t, "b-open", b[0].ID)
	require.Equal(t, plugin.SelectionMulti, b[0].Selection, "插件自己声明的 selection 不许被覆盖")

	_, hasUnknown := surfaces[plugin.Surface("entry.whatever")]
	require.False(t, hasUnknown, "未知 surface 不许出现在清单里")

	total := 0
	for _, items := range surfaces {
		total += len(items)
	}
	require.Equal(t, 2, total)
}

// TestRegistry_Contributions_OnlyEnabled 停用即从清单消失，再启用回来。
func TestRegistry_Contributions_OnlyEnabled(t *testing.T) {
	r := plugin.NewRegistry()
	require.NoError(t, r.Register(pluginAAA()))
	require.NoError(t, r.Register(pluginBBB()))

	require.True(t, r.SetEnabled("bbb-demo", false))
	require.Empty(t, r.AllContributions()[plugin.SurfaceEntryListToolbar], "B 停用后它的按钮要消失")
	require.Len(t, r.AllContributions()[plugin.SurfaceEntryContextMenu], 1, "A 还在")

	require.True(t, r.SetEnabled("aaa-demo", false))
	require.Empty(t, r.AllContributions(), "都停用后清单是空的（不是崩）")

	require.True(t, r.SetEnabled("bbb-demo", true))
	require.Len(t, r.AllContributions()[plugin.SurfaceEntryListToolbar], 1, "重新启用后回来")
}

// TestRegistry_Contributions_StableOrder 同一 surface 上多插件按插件 id 排序（输出稳定，前端不会跳）。
func TestRegistry_Contributions_StableOrder(t *testing.T) {
	r := plugin.NewRegistry()
	// 故意反序注册，验证不是靠 map 迭代顺序凑出来的
	require.NoError(t, r.Register(pluginBBB()))
	require.NoError(t, r.Register(pluginAAA()))

	require.NoError(t, r.Register(contributionPlugin{id: "zzz-demo", items: []plugin.Contribution{
		{ID: "z-cmd", Surface: plugin.SurfaceAppCommand, Action: "run", Label: "Z"},
	}}))
	require.NoError(t, r.Register(contributionPlugin{id: "ccc-demo", items: []plugin.Contribution{
		{ID: "c-cmd", Surface: plugin.SurfaceAppCommand, Action: "run", Label: "C"},
	}}))

	items := r.AllContributions()[plugin.SurfaceAppCommand]
	require.Len(t, items, 2)
	require.Equal(t, "c-cmd", items[0].ID, "按插件 id（ccc < zzz）排序")
	require.Equal(t, "z-cmd", items[1].ID)
}

// TestRegistry_Contributions_SinglePlugin 单插件取用同一套清洗规则；没装/没贡献都返回空。
func TestRegistry_Contributions_SinglePlugin(t *testing.T) {
	r := plugin.NewRegistry()
	require.NoError(t, r.Register(pluginAAA()))

	items := r.PluginContributions("aaa-demo")
	require.Len(t, items, 1)
	require.Equal(t, "a-open", items[0].ID)

	require.Empty(t, r.PluginContributions("ghost"))
	// 没有 ContributionsProvider 的插件（这里用 registry_test.go 里的 fakePlugin）
	require.NoError(t, r.Register(fakePlugin{}))
	require.Empty(t, r.PluginContributions("demo"))
}
