package plugin_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/plugin"
)

// TestSurfaces 宿主暴露的插入位置名单：无重复、且每个都被 IsSupportedSurface 认可。
func TestSurfaces(t *testing.T) {
	seen := make(map[plugin.Surface]bool, len(plugin.Surfaces))
	for _, s := range plugin.Surfaces {
		require.False(t, seen[s], "surface 重复：%s", s)
		seen[s] = true
		require.True(t, plugin.IsSupportedSurface(s), "列在 Surfaces 里的必须被认可：%s", s)
	}
	require.NotEmpty(t, plugin.Surfaces)
}

// TestSurfaces_UnknownRejected 名单外的一律不认（插件不能自造插入位置）。
func TestSurfaces_UnknownRejected(t *testing.T) {
	require.False(t, plugin.IsSupportedSurface("entry.whatever"))
	require.False(t, plugin.IsSupportedSurface(""))
}

// TestSelection 选区是否为空：判断口径要严（任一字段有值就不算空）。
func TestSelection(t *testing.T) {
	require.True(t, plugin.Selection{}.IsEmpty(), "全空的选区算空")

	require.False(t, plugin.Selection{EntryIDs: []int64{1}}.IsEmpty())
	require.False(t, plugin.Selection{FeedIDs: []int64{2}}.IsEmpty())

	filterID := int64(3)
	require.False(t, plugin.Selection{FilterID: &filterID}.IsEmpty())

	viewID := int64(4)
	require.False(t, plugin.Selection{ViewID: &viewID}.IsEmpty())

	require.False(t, plugin.Selection{TextRange: &plugin.TextRange{Start: 0, End: 2, Text: "ab"}}.IsEmpty())
}
