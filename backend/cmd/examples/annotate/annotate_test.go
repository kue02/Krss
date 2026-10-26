package main

import (
	"context"
	"encoding/json"
	"io/fs"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
)

// newTestPlugin 每个用例一份独立的内存 store（不碰磁盘、互不串味）。
func newTestPlugin() annotate { return annotate{st: newStore("")} }

// invokeAction 按 action id 找动作并界面直调（宿主走的就是 plugin.Invoker 这条路）。
func invokeAction(t *testing.T, a annotate, action string, req plugin.InvokeRequest) (plugin.InvokeResult, error) {
	t.Helper()
	for _, item := range a.Actions() {
		if item.ID() != action {
			continue
		}
		invoker, ok := item.(plugin.Invoker)
		require.Truef(t, ok, "动作 %s 必须实现 plugin.Invoker（界面直调）", action)
		return invoker.Invoke(context.Background(), req)
	}
	t.Fatalf("插件没有声明动作 %s", action)
	return plugin.InvokeResult{}, nil
}

func strPtr(v string) *string { return &v }

// TestContributions_ThreeSurfaces 三条贡献都挂在自己声明的动作上，且选择口径一致。
// 注：宿主 Invoke 会先核对「这个 surface 有没有声明这个 action」，所以 action 名对不上就点不动。
func TestContributions_ThreeSurfaces(t *testing.T) {
	a := newTestPlugin()

	declared := map[string]plugin.Action{}
	for _, action := range a.Actions() {
		declared[action.ID()] = action
	}

	items := a.Contributions()
	require.Len(t, items, 3)

	want := map[string]plugin.Surface{
		"highlight": plugin.SurfaceEntryReaderBody,
		"note":      plugin.SurfaceEntryReaderBody,
		"export":    plugin.SurfaceEntryReaderToolbar,
	}
	for _, item := range items {
		require.Contains(t, declared, item.Action, "贡献 %s 指向了不存在的动作", item.ID)
		require.Equal(t, want[item.Action], item.Surface, "贡献 %s 的挂点", item.ID)
		require.Equal(t, plugin.SelectionSingle, item.Selection)
		require.NotEmpty(t, item.Label)
	}
	// 高亮要刷新装饰链（否则界面上的高亮要等下一次进条目才出现）
	require.Equal(t, []string{"decorations"}, items[0].Refresh)

	// 笔记的文本字段由宿主按 contribution.Fields 动态渲染（Required 缺失就不会拦空提交）
	noteFields := items[1].Fields
	require.Len(t, noteFields, 1)
	require.Equal(t, "text", noteFields[0].Key)
	require.True(t, noteFields[0].Required)

	views := a.Views()
	require.Len(t, views, 1)
	require.Equal(t, plugin.ViewKindCustom, views[0].Kind)
	require.Equal(t, "index.html", views[0].Entry)
	require.True(t, plugin.DeclaresPermission(a.Meta(), plugin.PermissionUICustom), "自定义视图必须声明 ui:custom")
}

// TestHighlight_WritesStoreAndDecorateReadsBack 高亮写进自己的 annotations 集合，
// Decorate 立刻能按同一区间/颜色读回来；别的条目读不到。
func TestHighlight_WritesStoreAndDecorateReadsBack(t *testing.T) {
	a := newTestPlugin()

	result, err := invokeAction(t, a, "highlight", plugin.InvokeRequest{
		Surface: plugin.SurfaceEntryReaderBody,
		Selection: plugin.Selection{
			EntryIDs:  []int64{42},
			TextRange: &plugin.TextRange{Start: 2, End: 6, Text: "很可爱"},
		},
	})
	require.NoError(t, err)
	require.Equal(t, "已高亮", result.Message)
	require.Equal(t, "success", result.Level)
	require.Equal(t, []string{"decorations"}, result.Refresh)

	stored := a.store().List(collectionAnnotations)
	require.Len(t, stored, 1, "键 = 条目 id")
	var list []annotation
	require.NoError(t, json.Unmarshal([]byte(stored["42"]), &list))
	require.Equal(t, []annotation{{Start: 2, End: 6, Color: "yellow", Note: ""}}, list)

	got, err := a.Decorate(context.Background(), plugin.DecorateRequest{
		Entry: model.Entry{ID: 42},
		Text:  "这只猫很可爱",
	})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, 2, got[0].Start)
	require.Equal(t, 6, got[0].End)
	require.Equal(t, "highlight", got[0].Style)
	require.Equal(t, "yellow", got[0].Color)
	require.Equal(t, "annotate", got[0].Plugin, "装饰归属由插件自己填，宿主只做校验")

	other, err := a.Decorate(context.Background(), plugin.DecorateRequest{
		Entry: model.Entry{ID: 43},
		Text:  "另一条",
	})
	require.NoError(t, err)
	require.Empty(t, other, "别的条目不该看到这条高亮")
}

// TestHighlight_RequiresTextRange 没选中文字就报错，且**不**落库
// （否则界面上会多出一条看不见的空装饰）。
func TestHighlight_RequiresTextRange(t *testing.T) {
	a := newTestPlugin()

	_, err := invokeAction(t, a, "highlight", plugin.InvokeRequest{
		Surface:   plugin.SurfaceEntryReaderBody,
		Selection: plugin.Selection{EntryIDs: []int64{42}},
	})
	require.ErrorContains(t, err, "先选中文字")
	require.Empty(t, a.store().List(collectionAnnotations))

	// 空区间（start == end）也算没选中
	_, err = invokeAction(t, a, "highlight", plugin.InvokeRequest{
		Selection: plugin.Selection{
			EntryIDs:  []int64{42},
			TextRange: &plugin.TextRange{Start: 3, End: 3},
		},
	})
	require.ErrorContains(t, err, "先选中文字")
	require.Empty(t, a.store().List(collectionAnnotations))
}

// TestNote_StoresText 笔记带 req.Config["text"]，颜色 blue；文字为空要报错且不写。
func TestNote_StoresText(t *testing.T) {
	a := newTestPlugin()

	result, err := invokeAction(t, a, "note", plugin.InvokeRequest{
		Surface: plugin.SurfaceEntryReaderBody,
		Selection: plugin.Selection{
			EntryIDs:  []int64{9},
			TextRange: &plugin.TextRange{Start: 0, End: 2, Text: "猫很"},
		},
		Config: map[string]string{"text": "这里要回看"},
	})
	require.NoError(t, err)
	require.Equal(t, "已记笔记", result.Message)

	var list []annotation
	require.NoError(t, json.Unmarshal([]byte(a.store().List(collectionAnnotations)["9"]), &list))
	require.Len(t, list, 1)
	require.Equal(t, "blue", list[0].Color)
	require.Equal(t, "这里要回看", list[0].Note)
	require.Equal(t, 0, list[0].Start)
	require.Equal(t, 2, list[0].End)

	_, err = invokeAction(t, a, "note", plugin.InvokeRequest{
		Selection: plugin.Selection{
			EntryIDs:  []int64{9},
			TextRange: &plugin.TextRange{Start: 0, End: 2},
		},
		Config: map[string]string{"text": "   "},
	})
	require.ErrorContains(t, err, "先写笔记")
	require.Len(t, a.store().List(collectionAnnotations), 1, "失败不该再写一条")
}

// TestUIAssets_EmbedsIndex 自定义视图的入口真的被打进二进制了（embed 目录写错时
// 编译能过、运行时才 404 —— 这条断言把它挡在测试里）。
func TestUIAssets_EmbedsIndex(t *testing.T) {
	assets := annotate{}.UIAssets()
	require.NotNil(t, assets)
	page, err := fs.ReadFile(assets, "index.html")
	require.NoError(t, err)
	require.Contains(t, string(page), `src="./bridge.js"`, "页面靠 SDK 发的 bridge.js 起来")
	require.Contains(t, string(page), "krss.data", "标注列表走 bridge 的数据能力")
}

// TestExport_Markdown 导出：frontmatter + 标题 + 正文纯文本 + 按 start 排序的标注行，
// 内容放在 InvokeResult.Files 里（文件名 krss/<date> <slug>.md）。
func TestExport_Markdown(t *testing.T) {
	a := newTestPlugin()

	// 故意先记后面那条，导出要按 start 排序
	_, err := invokeAction(t, a, "note", plugin.InvokeRequest{
		Selection: plugin.Selection{
			EntryIDs:  []int64{7},
			TextRange: &plugin.TextRange{Start: 12, End: 14, Text: "今天"},
		},
		Config: map[string]string{"text": "结尾这里"},
	})
	require.NoError(t, err)
	_, err = invokeAction(t, a, "highlight", plugin.InvokeRequest{
		Selection: plugin.Selection{
			EntryIDs:  []int64{7},
			TextRange: &plugin.TextRange{Start: 0, End: 5, Text: "Hello"},
		},
	})
	require.NoError(t, err)

	entry := model.Entry{
		ID:      7,
		Title:   strPtr("一只猫 / 今天"),
		URL:     strPtr("https://example.com/post"),
		Content: strPtr(`<p>Hello <b>world</b> 今天</p>`),
	}
	result, err := invokeAction(t, a, "export", plugin.InvokeRequest{
		Surface:   plugin.SurfaceEntryReaderToolbar,
		Selection: plugin.Selection{EntryIDs: []int64{7}},
		Entries:   []model.Entry{entry},
	})
	require.NoError(t, err)
	require.Equal(t, "已导出", result.Message)
	require.Len(t, result.Files, 1)

	file := result.Files[0]
	require.Equal(t, "text/markdown", file.MIME)
	require.True(t, strings.HasPrefix(file.Filename, "krss/"), file.Filename)
	require.True(t, strings.HasSuffix(file.Filename, ".md"), file.Filename)
	require.NotContains(t, file.Filename, "/.md", "slug 里的斜杠要清掉，别把文件写到子目录")
	require.Contains(t, file.Filename, "一只猫")

	require.Regexp(t, regexp.MustCompile(`(?m)^source: https://example\.com/post$`), file.Content)
	require.Contains(t, file.Content, "tags: [krss, annotate]")
	require.Regexp(t, regexp.MustCompile(`(?m)^date: \d{4}-\d{2}-\d{2}$`), file.Content)
	require.Contains(t, file.Content, "# 一只猫 / 今天")
	require.Contains(t, file.Content, "Hello world 今天")
	require.Contains(t, file.Content, "## 标注")
	require.Contains(t, file.Content, "- 〔黄色〕第 1–5 字：Hello")
	require.Contains(t, file.Content, "- 〔蓝色〕第 13–14 字：今天")

	yellow := strings.Index(file.Content, "〔黄色〕")
	blue := strings.Index(file.Content, "〔蓝色〕")
	require.Less(t, yellow, blue, "标注按 start 排序")
}
