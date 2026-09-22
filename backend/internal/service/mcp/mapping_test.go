package mcp_test

import (
	"encoding/json"
	"testing"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/service/mcp"

	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// 16-3 四档映射的自动推断（黑盒：只走公开 API）
// ---------------------------------------------------------------------------

func TestInferFromToolResult_StructuredJSON(t *testing.T) {
	// 第 ③ 档：有结构化 JSON、没声明 schema —— 按常见字段名自动预填
	payload := `{"data":{"items":[
		{"id":"note-1","title":"第一条","url":"https://example.com/1","content":"正文一","updated_at":"2026-09-18T10:00:00Z","author":{"name":"kue"}},
		{"id":"note-2","title":"第二条","url":"https://example.com/2","content":"正文二","updated_at":"2026-09-17T10:00:00Z","author":{"name":"kue"}}
	]}}`
	result := mcp.CallToolResult{Content: []mcp.Content{{Type: "text", Text: payload}}}

	inf, err := mcp.InferFromToolResult(result, nil)
	require.NoError(t, err)
	require.Equal(t, model.MCPTierStructured, inf.Tier)
	require.Equal(t, "data.items", inf.Mapping.ListPath)
	require.Equal(t, "title", inf.Mapping.Title)
	require.Equal(t, "url", inf.Mapping.URL)
	require.Equal(t, "content", inf.Mapping.Content)
	require.Equal(t, "updated_at", inf.Mapping.PublishedAt)
	require.Equal(t, "author.name", inf.Mapping.Author)
	require.Equal(t, "id", inf.Mapping.ID)
}

func TestInferFromToolResult_OutputSchema(t *testing.T) {
	// 第 ② 档：工具声明了 outputSchema —— 读 schema 直接生成，连样本都不用
	schema := json.RawMessage(`{"type":"object","properties":{"results":{"type":"array","items":{"type":"object","properties":{
		"headline":{"type":"string"},"permalink":{"type":"string"},"body":{"type":"string"},"published_at":{"type":"string"},"slug":{"type":"string"}
	}}}}}`)
	inf, err := mcp.InferFromToolResult(mcp.CallToolResult{}, schema)
	require.NoError(t, err)
	require.Equal(t, model.MCPTierSchema, inf.Tier)
	require.Equal(t, "results", inf.Mapping.ListPath)
	require.Equal(t, "headline", inf.Mapping.Title)
	require.Equal(t, "permalink", inf.Mapping.URL)
	require.Equal(t, "body", inf.Mapping.Content)
	require.Equal(t, "published_at", inf.Mapping.PublishedAt)
	require.Equal(t, "slug", inf.Mapping.ID)
}

func TestInferFromToolResult_StructuredContent(t *testing.T) {
	// 规范里的 structuredContent（与 outputSchema 配对），我们也能直接吃
	result := mcp.CallToolResult{
		StructuredContent: json.RawMessage(`{"notes":[{"title":"A","link":"https://a","description":"da"},{"title":"B","link":"https://b","description":"db"}]}`),
	}
	inf, err := mcp.InferFromToolResult(result, nil)
	require.NoError(t, err)
	require.Equal(t, model.MCPTierStructured, inf.Tier)
	require.Equal(t, "notes", inf.Mapping.ListPath)
	require.Equal(t, "description", inf.Mapping.Content)
}

func TestInferFromToolResult_ResourceLink(t *testing.T) {
	// 第 ① 档：resource / resource_link（带 uri）—— 几乎零映射
	result := mcp.CallToolResult{Content: []mcp.Content{
		{Type: "resource_link", URI: "krss://feed/1", Name: "订阅一"},
		{Type: "resource_link", URI: "krss://feed/2", Name: "订阅二"},
	}}
	inf, err := mcp.InferFromToolResult(result, nil)
	require.NoError(t, err)
	require.Equal(t, model.MCPTierResource, inf.Tier)
	require.Equal(t, "name", inf.Mapping.Title)
	require.Equal(t, "uri", inf.Mapping.URL)

	items, err := mcp.BuildItems([]any{
		map[string]any{"name": "订阅一", "uri": "krss://feed/1"},
		map[string]any{"name": "订阅二", "uri": "krss://feed/2"},
	}, inf.Tier, inf.Mapping)
	require.NoError(t, err)
	require.Len(t, items, 2)
	require.Equal(t, "krss://feed/1", items[0].URL)
}

func TestInferFromToolResult_PlainTextMarkdown(t *testing.T) {
	// 第 ④ 档：纯文本（不是 JSON）→ 按 Markdown 标题切分
	text := "## 今天的第一条\n\n正文一。\n\n## 今天的第二条\n\n正文二。"
	inf, err := mcp.InferFromToolResult(mcp.CallToolResult{Content: []mcp.Content{{Type: "text", Text: text}}}, nil)
	require.NoError(t, err)
	require.Equal(t, model.MCPTierText, inf.Tier)

	items, err := mcp.BuildItems(text, inf.Tier, inf.Mapping)
	require.NoError(t, err)
	require.Len(t, items, 2)
	require.Equal(t, "今天的第一条", items[0].Title)
	require.Contains(t, items[0].Content, "正文一")
}

func TestInferFromToolResult_Errors(t *testing.T) {
	// 只返回图片：明确报错，不许静默出空条目
	_, err := mcp.InferFromToolResult(mcp.CallToolResult{Content: []mcp.Content{{Type: "image", Data: "AAAA"}}}, nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "image")

	// 单段纯文本：不报错，退化成「一条」（首行当标题）——预览里能看见，不是静默出空
	inf, err := mcp.InferFromToolResult(mcp.CallToolResult{Content: []mcp.Content{{Type: "text", Text: "就一句话，没有结构"}}}, nil)
	require.NoError(t, err)
	items, err := mcp.BuildItems("就一句话，没有结构", inf.Tier, inf.Mapping)
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, "就一句话，没有结构", items[0].Title)

	// 空文本：切不出来，要有明确原因（需要人工指字段）
	_, err = mcp.InferFromToolResult(mcp.CallToolResult{Content: []mcp.Content{{Type: "text", Text: "   \n  "}}}, nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "content 为空")
}

// ---------------------------------------------------------------------------
// 16-4 去重键：映射键字段 → 链接 → 标题+时间（照抄 computeEntryHash 的退化顺序）
// ---------------------------------------------------------------------------

func TestBuildItems_KeyLevels(t *testing.T) {
	payload := []any{
		map[string]any{"id": "k-1", "title": "有键", "url": "https://example.com/1"},
		map[string]any{"title": "只有链接", "url": "https://example.com/2"},
		map[string]any{"title": "都没有"},
	}

	// 映射指定了 id 字段
	items, err := mcp.BuildItems(payload, model.MCPTierStructured, model.MCPFieldMapping{Title: "title", URL: "url", ID: "id"})
	require.NoError(t, err)
	require.Len(t, items, 3)
	require.Equal(t, "k-1", items[0].Key)
	require.Equal(t, model.MCPKeyLevelField, items[0].KeyLevel)
	require.Equal(t, "https://example.com/2", items[1].Key)
	require.Equal(t, model.MCPKeyLevelLink, items[1].KeyLevel)
	require.Equal(t, "都没有|", items[2].Key)
	require.Equal(t, model.MCPKeyLevelFallback, items[2].KeyLevel)
}

func TestBuildItems_MappingMismatchFails(t *testing.T) {
	// 映射路径对不上：必须报错（写进该源 last_error），不是「0 条」了事
	payload := []any{map[string]any{"title": "A"}}
	_, err := mcp.BuildItems(payload, model.MCPTierStructured, model.MCPFieldMapping{ListPath: "data.items", Title: "title"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "data.items")
}

// ---------------------------------------------------------------------------
// 取值 / 时间解析
// ---------------------------------------------------------------------------

func TestLookup_Paths(t *testing.T) {
	root := map[string]any{
		"data": map[string]any{"items": []any{map[string]any{"title": "第一条"}}},
		"Tags": []any{"a", "b"},
	}

	value, ok := mcp.Lookup(root, "data.items[0].title")
	require.True(t, ok)
	require.Equal(t, "第一条", value)

	// 大小写不敏感（MCP 返回的字段名不保证与映射里大小写一致）
	value, ok = mcp.Lookup(root, "tags.1")
	require.True(t, ok)
	require.Equal(t, "b", value)

	_, ok = mcp.Lookup(root, "data.missing")
	require.False(t, ok)
}

func TestParseTime(t *testing.T) {
	expected := time.Date(2026, 9, 18, 10, 0, 0, 0, time.UTC)

	cases := []struct {
		name  string
		input any
	}{
		{"rfc3339", "2026-09-18T10:00:00Z"},
		{"秒级时间戳", float64(1789725600)},
		{"毫秒时间戳", float64(1789725600000)},
		{"日期字符串", "2026-09-18"},
		{"下划线对象", map[string]any{"$date": "2026-09-18T10:00:00Z"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parsed, ok := mcp.ParseTime(tc.input)
			require.True(t, ok)
			require.WithinDuration(t, expected, parsed, 48*time.Hour)
		})
	}

	_, ok := mcp.ParseTime("看不懂的文本")
	require.False(t, ok)
}
