package service

// MCP 追历史分页（16-8）：单次调用内 cursor 循环 + 页数/条数双上限（默认 3 页 / 200 条）。
//
// 游标两头都自动找（找不到就退回只取一页，不报错）：
//   - 发哪个参数：配置 CursorParam > inputSchema 里按 cursor/nextCursor/pageToken/page_token/offset/page/after 找
//   - 下一页从哪读：配置 CursorPath > 返回 JSON 里按 nextCursor/cursor/next_cursor/pageToken/page_token/nextPageToken/next/after 找
//   - page/offset 这类数字参数：返回没给游标但给了 hasMore=true 时自动 +1 / +=本页条数
// 防灌爆：next 游标重复出现立刻停；条数到上限截断。

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"krss/backend/internal/model"
	"krss/backend/internal/service/mcp"
)

// cursorParamCandidates 发游标的参数名（按常见度排序）。
var cursorParamCandidates = []string{"cursor", "nextCursor", "pageToken", "page_token", "after", "offset", "page"}

// cursorPathCandidates 返回里读下一页游标的路径。
var cursorPathCandidates = []string{"nextCursor", "cursor", "next_cursor", "pageToken", "page_token", "nextPageToken", "next", "after"}

// detectCursorParam 按 inputSchema 猜游标参数（找不到 = 这个工具不支持翻页）。
func detectCursorParam(inputSchema json.RawMessage, configured string) string {
	if strings.TrimSpace(configured) != "" {
		return strings.TrimSpace(configured)
	}
	if len(inputSchema) == 0 {
		return ""
	}
	var schema struct {
		Properties map[string]any `json:"properties"`
	}
	if err := json.Unmarshal(inputSchema, &schema); err != nil || len(schema.Properties) == 0 {
		return ""
	}
	lowered := map[string]string{}
	for name := range schema.Properties {
		lowered[strings.ToLower(name)] = name
	}
	for _, candidate := range cursorParamCandidates {
		if actual, ok := lowered[strings.ToLower(candidate)]; ok {
			return actual
		}
	}
	return ""
}

// extractNextCursor 从一次工具返回里读下一页游标（空 = 没有下一页）。
func extractNextCursor(result mcp.CallToolResult, configuredPath string) string {
	var payload any
	if len(result.StructuredContent) > 0 {
		if err := json.Unmarshal(result.StructuredContent, &payload); err != nil {
			return ""
		}
	} else {
		text := ""
		for _, content := range result.Content {
			if content.Type == "text" && strings.TrimSpace(content.Text) != "" {
				text = content.Text
				break
			}
		}
		if err := json.Unmarshal([]byte(text), &payload); err != nil {
			return ""
		}
	}
	if _, ok := payload.(map[string]any); !ok {
		return ""
	}
	if strings.TrimSpace(configuredPath) != "" {
		if value, found := mcp.Lookup(payload, strings.TrimSpace(configuredPath)); found {
			return cursorToString(value)
		}
		return ""
	}
	for _, path := range cursorPathCandidates {
		if value, found := mcp.Lookup(payload, path); found {
			if str := cursorToString(value); str != "" {
				return str
			}
		}
	}
	// 有 hasMore=true 但没给游标 → 回特殊标记，调用方按数字参数自增
	if value, found := mcp.Lookup(payload, "hasMore"); found {
		if flag, ok := value.(bool); ok && flag {
			return "+1"
		}
	}
	if value, found := mcp.Lookup(payload, "has_more"); found {
		if flag, ok := value.(bool); ok && flag {
			return "+1"
		}
	}
	return ""
}

func cursorToString(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		if v == float64(int64(v)) {
			return fmt.Sprintf("%d", int64(v))
		}
		return ""
	case bool:
		return ""
	case nil:
		return ""
	default:
		return ""
	}
}

// pagedToolCall 追历史循环：返回每一页的原始结果与用到的游标参数名。
// 第一页的游标是 ""（调用方决定要不要继续 —— inspect 只取第一页并回传 nextCursor）。
// 首页失败直接回错（调用方写进 last_error）；后面页失败不断前面已拿到的（返回已拿到的页，err=nil）。
func (s *mcpService) pagedToolCall(ctx context.Context, client *mcp.Client, toolName string, baseArgs map[string]any, limit int, pagination *model.MCPPagination, inputSchema json.RawMessage) (pages []mcp.CallToolResult, cursorParam string, nextCursor string, err error) {
	mode, maxPages, maxItems := pagination.Effective()
	cursorParam = detectCursorParam(inputSchema, configuredCursorParam(pagination))
	if mode != model.MCPPaginationHistory || cursorParam == "" {
		// 不支持 / 不要求翻页：只取一页（但把 next 游标顺手读出来给「拉更多」用）
		args := copyArgs(baseArgs, limit)
		result, err := client.CallTool(ctx, toolName, args)
		if err != nil {
			return nil, cursorParam, "", err
		}
		return []mcp.CallToolResult{result}, cursorParam, extractNextCursor(result, configuredCursorPath(pagination)), nil
	}

	seen := map[string]bool{}
	cursor := ""
	pageNumber := 0
	offsetNumber := 0
	for page := 0; page < maxPages; page++ {
		args := copyArgs(baseArgs, limit)
		if cursor != "" {
			args[cursorParam] = cursorValue(cursorParam, cursor, pageNumber, offsetNumber)
		}
		result, err := client.CallTool(ctx, toolName, args)
		if err != nil {
			if len(pages) == 0 {
				return nil, cursorParam, "", err
			}
			break // 后面页失败不推翻前面已拿到的（调用方按已拿到的条目结算）
		}
		pages = append(pages, result)
		next := extractNextCursor(result, configuredCursorPath(pagination))
		if next == "" || seen[next] {
			next = ""
		} else {
			seen[next] = true
		}
		nextCursor = next
		pageNumber++
		offsetNumber += pageItemCount(result)
		if next == "" {
			break
		}
		if estimatedItems(pages) >= maxItems {
			break
		}
		cursor = next
	}
	return pages, cursorParam, nextCursor, nil
}

// cursorValue 数字参数自增（page +1 / offset +=已拿条数）；不透明游标原样透传。
func cursorValue(param, cursor string, pageNumber, offsetNumber int) any {
	lowered := strings.ToLower(param)
	if cursor == "+1" {
		if lowered == "offset" {
			return offsetNumber
		}
		return pageNumber + 1
	}
	return cursor
}

// pageItemCount 粗估这一页多少条（只为 offset 自增用，不精确也行）。
func pageItemCount(result mcp.CallToolResult) int {
	if len(result.StructuredContent) > 0 {
		var payload any
		if err := json.Unmarshal(result.StructuredContent, &payload); err == nil {
			if list, _, ok := findAnyList(payload); ok {
				return len(list)
			}
		}
	}
	return len(result.Content)
}

// estimatedItems 粗估已拿页的条目总数（双上限的条数闸用）。
func estimatedItems(pages []mcp.CallToolResult) int {
	total := 0
	for _, page := range pages {
		total += pageItemCount(page)
	}
	return total
}

// findAnyList 从载荷里找第一个数组（只为计数，不关心路径）。
func findAnyList(node any) ([]any, string, bool) {
	switch typed := node.(type) {
	case []any:
		return typed, "", true
	case map[string]any:
		for key, value := range typed {
			if list, ok := value.([]any); ok {
				return list, key, true
			}
		}
		for key, value := range typed {
			if list, path, ok := findAnyList(value); ok {
				return list, key + "." + path, true
			}
		}
	}
	return nil, "", false
}

func copyArgs(base map[string]any, limit int) map[string]any {
	args := map[string]any{}
	for key, value := range base {
		args[key] = value
	}
	if limit > 0 {
		if _, ok := args["limit"]; !ok {
			args["limit"] = limit
		}
	}
	return args
}

func configuredCursorParam(pagination *model.MCPPagination) string {
	if pagination == nil {
		return ""
	}
	return pagination.CursorParam
}

func configuredCursorPath(pagination *model.MCPPagination) string {
	if pagination == nil {
		return ""
	}
	return pagination.CursorPath
}
