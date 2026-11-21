package plugin_test

import (
	"encoding/json"
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

// TestSelection_UnmarshalAcceptsStringIDs 宿主发字符串 id（int64 安全），
// 手写 curl 发数字也得认；19 位 id 必须原样还原。
func TestSelection_UnmarshalAcceptsStringIDs(t *testing.T) {
	var got plugin.Selection
	require.NoError(t, json.Unmarshal([]byte(`{"entryIds":["2114685590489272320"],"feedIds":[1],"filterId":"2100484683115532288","viewId":2}`), &got))
	require.Equal(t, []int64{2114685590489272320}, got.EntryIDs)
	require.Equal(t, []int64{1}, got.FeedIDs)
	require.NotNil(t, got.FilterID)
	require.Equal(t, int64(2100484683115532288), *got.FilterID)
	require.NotNil(t, got.ViewID)
	require.Equal(t, int64(2), *got.ViewID)
}

// TestSelection_UnmarshalRejectsGarbage 非数字 id 要报错，不能静默变 0。
func TestSelection_UnmarshalRejectsGarbage(t *testing.T) {
	var got plugin.Selection
	require.Error(t, json.Unmarshal([]byte(`{"entryIds":["abc"]}`), &got))
}

// TestInvokeResult_FilesJSON 导出文件走 InvokeResult.Files（56-30）：
// 键名固定、空结果不多出 files（老前端/老插件互不影响）。
func TestInvokeResult_FilesJSON(t *testing.T) {
	raw, err := json.Marshal(plugin.InvokeResult{
		Message: "已导出",
		Files: []plugin.ExportFile{{
			Filename: "krss/2026-10-27 一只猫.md",
			Content:  "# 一只猫\n",
			MIME:     "text/markdown",
		}},
	})
	require.NoError(t, err)
	require.JSONEq(t, `{"message":"已导出","files":[{"filename":"krss/2026-10-27 一只猫.md","content":"# 一只猫\n","mime":"text/markdown"}]}`, string(raw))

	empty, err := json.Marshal(plugin.InvokeResult{Message: "ok"})
	require.NoError(t, err)
	require.JSONEq(t, `{"message":"ok"}`, string(empty))
}
