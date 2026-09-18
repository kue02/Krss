package service_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/internal/repository/testutil"
	"gist/backend/internal/service"

	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// 17 批（出向）：Krss 作为 MCP 服务器 —— 令牌、鉴权、协议方法、写操作开关
// ---------------------------------------------------------------------------

func newOutboundFixture(t *testing.T) (service.MCPOutboundService, *sqlFixture) {
	t.Helper()
	conn := testutil.NewTestDB(t)

	settingsRepo := repository.NewSettingsRepository(conn)
	feedRepo := repository.NewFeedRepository(conn)
	folderRepo := repository.NewFolderRepository(conn)
	entryRepo := repository.NewEntryRepository(conn)

	feedID := testutil.SeedFeed(t, conn, model.Feed{Title: "少数派", URL: "https://sspai.example/feed"})
	entryID := testutil.SeedEntry(t, conn, model.Entry{
		FeedID:      feedID,
		Title:       stringPtr("今天的三件小事"),
		URL:         stringPtr("https://sspai.example/1"),
		Content:     stringPtr("<p>第一条正文，关于 Postgres 的索引。</p>"),
		PublishedAt: timePtr(time.Date(2026, 9, 18, 8, 0, 0, 0, time.UTC)),
	})

	entryService := service.NewEntryService(entryRepo, feedRepo, folderRepo, nil)
	outbound := service.NewMCPOutboundService(settingsRepo, entryService, feedRepo, folderRepo)
	return outbound, &sqlFixture{feedID: feedID, entryID: entryID}
}

type sqlFixture struct {
	feedID  int64
	entryID int64
}

func TestOutbound_StatusDefaultsReadOnly(t *testing.T) {
	outbound, _ := newOutboundFixture(t)
	status, err := outbound.Status(context.Background())
	require.NoError(t, err)
	require.True(t, status.Enabled)
	require.False(t, status.WriteEnabled, "B1：第一版只读，写操作默认关")
	require.False(t, status.TokenSet, "没生成过 token 就不该有 token")
	require.Equal(t, "/mcp", status.Endpoint)

	// 默认只读：只有 4 个只读工具，没有 mark_read / star_entry
	names := toolNames(outbound.Tools(context.Background()))
	require.ElementsMatch(t, []string{"list_feeds", "list_entries", "search_entries", "get_entry"}, names)
}

func TestOutbound_TokenLifecycle(t *testing.T) {
	outbound, _ := newOutboundFixture(t)
	ctx := context.Background()

	status, token, err := outbound.GenerateToken(ctx)
	require.NoError(t, err)
	require.True(t, status.TokenSet)
	require.True(t, strings.HasPrefix(token, service.MCPTokenPrefix))
	require.True(t, strings.HasPrefix(status.TokenPrefix, service.MCPTokenPrefix))

	// 明文只在这一刻出现：状态里没有任何地方回显完整 token
	require.NotContains(t, status.TokenPrefix, token[len(service.MCPTokenPrefix):])

	require.True(t, outbound.Authorize(ctx, token))
	require.False(t, outbound.Authorize(ctx, token+"x"))
	require.False(t, outbound.Authorize(ctx, ""))

	require.NoError(t, outbound.RevokeToken(ctx))
	require.False(t, outbound.Authorize(ctx, token))
}

func TestOutbound_DisabledBlocksAuth(t *testing.T) {
	outbound, _ := newOutboundFixture(t)
	ctx := context.Background()
	_, token, err := outbound.GenerateToken(ctx)
	require.NoError(t, err)
	require.True(t, outbound.Authorize(ctx, token))

	_, err = outbound.UpdateOptions(ctx, false, false)
	require.NoError(t, err)
	require.False(t, outbound.Authorize(ctx, token), "关掉出向之后任何 token 都不该放行")
}

func TestOutbound_DispatchReadOnlyTools(t *testing.T) {
	outbound, fixture := newOutboundFixture(t)
	ctx := context.Background()

	// initialize
	response, respond := outbound.Dispatch(ctx, service.MCPRPCRequest{Method: "initialize", Params: json.RawMessage(`{"protocolVersion":"2025-06-18"}`)})
	require.True(t, respond)
	require.Nil(t, response.Error)
	result, ok := response.Result.(map[string]any)
	require.True(t, ok)
	require.Equal(t, "krss", result["serverInfo"].(map[string]any)["name"])

	// 通知不回响应
	_, respond = outbound.Dispatch(ctx, service.MCPRPCRequest{Method: "notifications/initialized"})
	require.False(t, respond)

	// tools/list 每个工具都要有 inputSchema，只读工具必须标 readOnlyHint
	response, _ = outbound.Dispatch(ctx, service.MCPRPCRequest{Method: "tools/list"})
	listResult, ok := response.Result.(map[string]any)
	require.True(t, ok)
	tools, ok := listResult["tools"].([]service.MCPToolDescriptor)
	require.True(t, ok)
	for _, tool := range tools {
		require.NotEmpty(t, tool.InputSchema, tool.Name+" 缺 inputSchema")
		require.NotNil(t, tool.Annotations)
		require.Equal(t, true, tool.Annotations["readOnlyHint"])
	}

	// list_feeds
	callResult, err := outbound.CallTool(ctx, "list_feeds", nil)
	require.NoError(t, err)
	require.NotEmpty(t, callResult.StructuredContent)
	require.Contains(t, string(callResult.StructuredContent), "少数派")
	// 规范建议：结构化内容同时序列化进一个 TextContent（兼容旧客户端）
	require.Contains(t, callResult.Content[len(callResult.Content)-1].Text, "\"feeds\"")

	// list_entries（默认只看未读）
	callResult, err = outbound.CallTool(ctx, "list_entries", map[string]any{"limit": float64(5)})
	require.NoError(t, err)
	require.Contains(t, string(callResult.StructuredContent), "今天的三件小事")

	// get_entry：正文（HTML 原样给，交给 agent 自己处理）
	callResult, err = outbound.CallTool(ctx, "get_entry", map[string]any{"id": idString(fixture.entryID)})
	require.NoError(t, err)
	require.Contains(t, string(callResult.StructuredContent), "Postgres")

	// search_entries 空关键词要明确报错
	_, err = outbound.CallTool(ctx, "search_entries", map[string]any{"query": "  "})
	require.Error(t, err)

	// 未知工具
	_, err = outbound.CallTool(ctx, "nope", nil)
	require.Error(t, err)
}

func TestOutbound_Resources(t *testing.T) {
	outbound, fixture := newOutboundFixture(t)
	ctx := context.Background()

	resources, err := outbound.Resources(ctx)
	require.NoError(t, err)
	uris := make([]string, 0, len(resources))
	for _, resource := range resources {
		uris = append(uris, resource.URI)
	}
	require.Contains(t, uris, "krss://unread")
	require.Contains(t, uris, "krss://feed/"+idString(fixture.feedID))

	mimeType, text, err := outbound.ReadResource(ctx, "krss://feed/"+idString(fixture.feedID))
	require.NoError(t, err)
	require.Equal(t, "text/markdown", mimeType)
	require.Contains(t, text, "今天的三件小事")

	_, _, err = outbound.ReadResource(ctx, "krss://entry/"+idString(fixture.entryID))
	require.NoError(t, err)

	_, _, err = outbound.ReadResource(ctx, "krss://nonsense")
	require.Error(t, err)

	// resources/read 走协议层要有 contents[]
	response, _ := outbound.Dispatch(ctx, service.MCPRPCRequest{
		Method: "resources/read",
		Params: json.RawMessage(`{"uri":"krss://unread"}`),
	})
	require.Nil(t, response.Error)
	contents := response.Result.(map[string]any)["contents"].([]map[string]any)
	require.Len(t, contents, 1)
	require.Equal(t, "krss://unread", contents[0]["uri"])
}

func TestOutbound_WriteToolsGated(t *testing.T) {
	outbound, fixture := newOutboundFixture(t)
	ctx := context.Background()

	// 默认关：写工具既不出现在清单里，直接调用也要被拒
	_, err := outbound.CallTool(ctx, "mark_read", map[string]any{"id": idString(fixture.entryID)})
	require.Error(t, err)
	require.Contains(t, err.Error(), "写操作未开启")

	_, err = outbound.UpdateOptions(ctx, true, true)
	require.NoError(t, err)
	names := toolNames(outbound.Tools(ctx))
	require.Contains(t, names, "mark_read")
	require.Contains(t, names, "star_entry")

	// 写工具必须按规范标出「不是只读」
	for _, tool := range outbound.Tools(ctx) {
		if tool.Name == "mark_read" {
			require.Equal(t, false, tool.Annotations["readOnlyHint"])
			require.Equal(t, true, tool.Annotations["idempotentHint"])
		}
	}

	_, err = outbound.CallTool(ctx, "mark_read", map[string]any{"id": idString(fixture.entryID), "read": true})
	require.NoError(t, err)
}

func TestOutbound_UnknownMethod(t *testing.T) {
	outbound, _ := newOutboundFixture(t)
	response, respond := outbound.Dispatch(context.Background(), service.MCPRPCRequest{Method: "prompts/list"})
	require.True(t, respond)
	require.NotNil(t, response.Error)
	require.Equal(t, service.MCPErrMethodNotFound, response.Error.Code)
}

func toolNames(tools []service.MCPToolDescriptor) []string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Name)
	}
	return names
}

func idString(id int64) string {
	return strconv.FormatInt(id, 10)
}
