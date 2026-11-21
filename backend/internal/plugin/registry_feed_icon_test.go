package plugin_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
)

// iconProviderPlugin test-only 假插件：实现 FeedIconProvider，返回固定 URL。
type iconProviderPlugin struct {
	id  string
	url string
}

func (p iconProviderPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: p.id, Name: p.id, Builtin: true}
}
func (p iconProviderPlugin) Actions() []plugin.Action                   { return nil }
func (p iconProviderPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p iconProviderPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p iconProviderPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }
func (p iconProviderPlugin) ID() string                                 { return p.id }
func (p iconProviderPlugin) FeedIcon(_ context.Context, _ model.Feed) (string, error) {
	return p.url, nil
}

// nonIconPlugin test-only 假插件：正常插件但**不实现** FeedIconProvider（聚合要跳过它）。
type nonIconPlugin struct {
	id string
}

func (p nonIconPlugin) Meta() plugin.Meta                          { return plugin.Meta{ID: p.id, Name: p.id, Builtin: true} }
func (p nonIconPlugin) Actions() []plugin.Action                   { return nil }
func (p nonIconPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p nonIconPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p nonIconPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

// TestRegistry_FeedIconProviders_EnabledOnly FeedIconProviders() 只收「已启用的、真实现了 FeedIconProvider 的」插件，且带插件 id。
func TestRegistry_FeedIconProviders_EnabledOnly(t *testing.T) {
	r := plugin.NewRegistry()
	require.NoError(t, r.Register(iconProviderPlugin{id: "bbb-icon", url: "https://example.com/bbb.png"}))
	require.NoError(t, r.Register(iconProviderPlugin{id: "aaa-icon", url: "https://example.com/aaa.png"}))
	// 没实现 FeedIconProvider 的插件不该出现在清单里
	require.NoError(t, r.Register(nonIconPlugin{id: "ccc-plain"}))

	got := r.FeedIconProviders()
	require.Len(t, got, 2, "只收实现了 FeedIconProvider 的插件")
	require.Equal(t, "aaa-icon", got[0].PluginID, "按插件 id 排序，顺序稳定")
	require.Equal(t, "bbb-icon", got[1].PluginID)
	require.NotNil(t, got[0].Provider)

	// 停用的插件不进清单（启停位是用户的意思表示）
	require.True(t, r.SetEnabled("bbb-icon", false))
	got = r.FeedIconProviders()
	require.Len(t, got, 1)
	require.Equal(t, "aaa-icon", got[0].PluginID)
}
