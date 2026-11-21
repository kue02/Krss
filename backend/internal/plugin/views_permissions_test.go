package plugin_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
)

// viewStub 一个只会注册视图的插件。
type viewStub struct {
	meta  plugin.Meta
	views []plugin.View
}

func (v viewStub) Meta() plugin.Meta                          { return v.meta }
func (v viewStub) Actions() []plugin.Action                   { return nil }
func (v viewStub) SettingsSections() []plugin.SettingsSection { return nil }
func (v viewStub) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (v viewStub) FetchClassifiers() []plugin.FetchClassifier { return nil }
func (v viewStub) Views() []plugin.View                       { return v.views }

// TestAllViews_InjectsPermissions 视图清单要带上插件声明的权限（56-32）。
//
// 少了这一步，沙箱里的 bridge 拿不到 data / entries:read，插件视图会直接报
// 「permission denied: data」—— 现象是「视图打开了但一片空白」，很难往回追。
func TestAllViews_InjectsPermissions(t *testing.T) {
	registry := plugin.NewRegistry()
	require.NoError(t, registry.Register(viewStub{
		meta: plugin.Meta{
			ID:          "annotate",
			Name:        "标注",
			Permissions: []string{"ui:custom", "data", "entries:read"},
		},
		views: []plugin.View{{
			ID:    "annotations",
			Label: "标注",
			Kind:  plugin.ViewKindCustom,
			Entry: "index.html",
		}},
	}))
	registry.SetEnabled("annotate", true)

	views := registry.AllViews()
	require.Len(t, views, 1)
	require.Equal(t, "annotate", views[0].Plugin, "归属插件由宿主注入")
	require.ElementsMatch(t, []string{"ui:custom", "data", "entries:read"}, views[0].Permissions,
		"权限必须原样带给前端，否则沙箱 bridge 全拒")
}
