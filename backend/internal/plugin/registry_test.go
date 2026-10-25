package plugin_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
)

type fakeAction struct {
	fired chan<- plugin.ActionRequest
}

func (a fakeAction) ID() string             { return "log" }
func (a fakeAction) Label() string          { return "写一条日志" }
func (a fakeAction) Fields() []plugin.Field { return nil }
func (a fakeAction) Execute(_ context.Context, req plugin.ActionRequest) error {
	a.fired <- req
	return nil
}

type fakePlugin struct {
	action fakeAction
}

func (p fakePlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: "demo", Name: "Demo", Builtin: true}
}
func (p fakePlugin) Actions() []plugin.Action                   { return []plugin.Action{p.action} }
func (p fakePlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p fakePlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p fakePlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

func TestRegistry_RegisterAndLookup(t *testing.T) {
	fired := make(chan plugin.ActionRequest, 1)
	r := plugin.NewRegistry()
	require.NoError(t, r.Register(fakePlugin{action: fakeAction{fired: fired}}))

	require.Equal(t, []plugin.Meta{{ID: "demo", Name: "Demo", Builtin: true}}, r.Plugins())
	action, ok := r.LookupAction("demo", "log")
	require.True(t, ok)
	require.Equal(t, "log", action.ID())

	_, ok = r.LookupAction("demo", "nope")
	require.False(t, ok)
	_, ok = r.LookupAction("ghost", "log")
	require.False(t, ok)
}

func TestRegistry_DuplicateRegisterRejected(t *testing.T) {
	r := plugin.NewRegistry()
	require.NoError(t, r.Register(fakePlugin{}))
	require.Error(t, r.Register(fakePlugin{}), "重复注册必须报错")
}

func TestRegistry_LoadEnabledAndSetEnabled(t *testing.T) {
	r := plugin.NewRegistry()
	require.NoError(t, r.Register(fakePlugin{}))
	require.True(t, r.Enabled("demo"), "默认启用")

	r.LoadEnabled(map[string]bool{"demo": false, "ghost": true})
	require.False(t, r.Enabled("demo"), "DB 记录覆盖默认值")
	require.True(t, r.Enabled("ghost") == false, "表里多出的 id 被忽略")

	require.False(t, r.SetEnabled("ghost", true), "不存在的插件返回 false")
	require.True(t, r.SetEnabled("demo", true))
	require.True(t, r.Enabled("demo"))
	require.Equal(t, map[string]bool{"demo": true}, r.EnabledStates())
}

func TestRegistry_CatalogCarriesActions(t *testing.T) {
	r := plugin.NewRegistry()
	require.NoError(t, r.Register(fakePlugin{}))
	items := r.Catalog()
	require.Len(t, items, 1)
	require.Equal(t, "demo", items[0].ID)
	require.Len(t, items[0].Actions, 1)
	require.Equal(t, "demo.log", items[0].Actions[0].PluginID+"."+items[0].Actions[0].ActionID)
	require.True(t, items[0].Actions[0].Enabled)
}
