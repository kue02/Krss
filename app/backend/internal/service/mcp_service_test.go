package service_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/internal/repository/testutil"
	"gist/backend/internal/service"
	"gist/backend/pkg/network"
	"gist/backend/pkg/snowflake"

	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// 16 批：MCP 连接管理 + 取数（用一个真的 httptest MCP 服务器当对手方）
// ---------------------------------------------------------------------------

func init() {
	_ = snowflake.Init(1)
}

// fakeMCPServer 一个最小的 streamable-http MCP 服务器：
// 覆盖 initialize / tools/list / tools/call / resources/list / resources/read。
type fakeMCPServer struct {
	server        *httptest.Server
	requireToken  string
	failToolsCall bool
	callCount     int
	seenSession   bool
}

func newFakeMCPServer(t *testing.T) *fakeMCPServer {
	t.Helper()
	fake := &fakeMCPServer{}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fake.requireToken != "" && r.Header.Get("Authorization") != "Bearer "+fake.requireToken {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","error":{"code":-32000,"message":"unauthorized"},"id":1}`))
			return
		}
		if r.Header.Get("Mcp-Session-Id") != "" {
			fake.seenSession = true
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", "fake-session-1")

		var req struct {
			ID     *int            `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		write := func(result any) {
			if req.ID == nil {
				w.WriteHeader(http.StatusAccepted)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": *req.ID, "result": result})
		}

		switch req.Method {
		case "initialize":
			write(map[string]any{
				"protocolVersion": "2025-06-18",
				"serverInfo":      map[string]any{"name": "fake-mcp", "version": "0.1"},
				"capabilities":    map[string]any{"tools": map[string]any{}},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			write(map[string]any{"tools": []map[string]any{
				{
					"name":         "list_notes",
					"description":  "列出笔记",
					"inputSchema":  map[string]any{"type": "object"},
					"outputSchema": json.RawMessage(`{"type":"object","properties":{"notes":{"type":"array","items":{"type":"object","properties":{"headline":{"type":"string"},"permalink":{"type":"string"},"body":{"type":"string"},"published_at":{"type":"string"},"slug":{"type":"string"}}}}}}`),
				},
				{
					"name":        "link_bundle",
					"description": "返回 resource_link 数组（第 ① 档）",
					"inputSchema": map[string]any{"type": "object"},
				},
				{
					"name":        "list_notes_no_schema",
					"description": "没有 outputSchema 的版本",
					"inputSchema": map[string]any{"type": "object"},
				},
			}})
		case "tools/call":
			fake.callCount++
			if fake.failToolsCall {
				write(map[string]any{"content": []map[string]any{{"type": "text", "text": "boom"}}, "isError": true})
				return
			}
			var params struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(req.Params, &params)
			if params.Name == "link_bundle" {
				write(map[string]any{"content": []map[string]any{
					{"type": "resource_link", "uri": "https://example.com/link/1", "name": "链接一"},
					{"type": "resource_link", "uri": "https://example.com/link/2", "name": "链接二"},
				}})
				return
			}
			if params.Name == "list_notes_no_schema" {
				// 第 ③ 档：结构化 JSON 文本、没 schema
				write(map[string]any{"content": []map[string]any{{"type": "text", "text": `{"data":{"items":[
					{"id":"n1","title":"第一条笔记","url":"https://notes.example/1","content":"正文一","updated_at":"2026-09-18T10:00:00Z"},
					{"id":"n2","title":"第二条笔记","url":"https://notes.example/2","content":"正文二","updated_at":"2026-09-17T10:00:00Z"}
				]}}`}}})
				return
			}
			// 第 ② 档：结构按 outputSchema 来（列表 + 字段名与 schema 一致）
			write(map[string]any{"content": []map[string]any{{"type": "text", "text": `{"notes":[
				{"headline":"架构笔记","permalink":"https://notes.example/a","body":"正文 A","published_at":"2026-09-18T09:00:00Z","slug":"a"},
				{"headline":"索引笔记","permalink":"https://notes.example/b","body":"正文 B","published_at":"2026-09-17T09:00:00Z","slug":"b"}
			]}`}}})
		case "resources/list":
			write(map[string]any{"resources": []map[string]any{
				{"uri": "notes://today", "name": "今天的笔记", "mimeType": "text/markdown"},
			}})
		case "resources/read":
			write(map[string]any{"contents": []map[string]any{
				{"uri": "notes://today", "mimeType": "text/markdown", "text": "## 早报\n\n今天的第一条。\n\n## 晚报\n\n今天的第二条。"},
			}})
		default:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found: %s"}}`, req.Method)
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func newMCPService(t *testing.T) (service.MCPService, repository.MCPServerRepository, repository.FeedRepository) {
	t.Helper()
	// 用共享缓存的库：":memory:" 在多连接下每条连接都是一个空库（会写出「写了读不到」的假失败）
	conn := testutil.NewTestDB(t)

	servers := repository.NewMCPServerRepository(conn)
	feeds := repository.NewFeedRepository(conn)
	clientFactory := network.NewClientFactoryForTest(&http.Client{})
	return service.NewMCPService(servers, nil, clientFactory), servers, feeds
}

func TestMCPService_CreateValidation(t *testing.T) {
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	// 第一版只支持无认证 + Header：sse 要明确被拒
	_, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "x", URL: "http://127.0.0.1:1/mcp", Transport: "sse"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "streamable-http")

	// 单连接刷新间隔下限 15 分钟（A3 已拍板）
	interval := 5
	_, err = svc.CreateServer(ctx, service.MCPServerInput{Name: "x", URL: "http://127.0.0.1:1/mcp", RefreshIntervalMinutes: &interval})
	require.Error(t, err)
	require.Contains(t, err.Error(), "15")

	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "本机 MCP", URL: "http://127.0.0.1:1/mcp", Enabled: true, UseGlobalFetch: true, Purposes: []string{model.MCPPurposeAI, model.MCPPurposeFeed}})
	require.NoError(t, err)
	require.Equal(t, model.MCPTransportStreamableHTTP, created.Transport)
	require.True(t, created.UseGlobalFetch)
}

func TestMCPService_TestServerListsTools(t *testing.T) {
	fake := newFakeMCPServer(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "fake", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true})
	require.NoError(t, err)

	result, err := svc.TestServer(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, result.Connected)
	require.Equal(t, "fake-mcp", result.ServerName)
	require.Equal(t, 3, result.ToolCount)
	require.Equal(t, 1, result.ResourceCount)

	tools, err := svc.ListTools(ctx, created.ID)
	require.NoError(t, err)
	require.Len(t, tools.Tools, 3)
	require.Len(t, tools.Resources, 1)
	require.NotEmpty(t, tools.Tools[0].OutputSchema)

	// 状态回写：列表里 should 是已连接、计数正确（掩码视图）
	servers, err := svc.ListServers(ctx)
	require.NoError(t, err)
	require.Len(t, servers, 1)
	require.True(t, servers[0].IsConnected)
	require.Equal(t, 3, servers[0].ToolCount)
	require.Nil(t, servers[0].LastError)
}

func TestMCPService_TestServerFailureIsVisible(t *testing.T) {
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	// 指向一个必然连不上的地址：错误要写进 last_error（失败必须可见）
	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "坏连接", URL: "http://127.0.0.1:1/mcp", Enabled: true, UseGlobalFetch: true})
	require.NoError(t, err)

	_, err = svc.TestServer(ctx, created.ID)
	require.Error(t, err)

	servers, err := svc.ListServers(ctx)
	require.NoError(t, err)
	require.False(t, servers[0].IsConnected)
	require.NotNil(t, servers[0].LastError)
	require.NotEmpty(t, *servers[0].LastError)
}

func TestMCPService_HeaderAuthAndMasking(t *testing.T) {
	fake := newFakeMCPServer(t)
	fake.requireToken = "secret-token-123"
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{
		Name: "带 Header 认证", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true,
		AuthType: model.MCPAuthHeader, Headers: map[string]string{"Authorization": "Bearer secret-token-123"},
	})
	require.NoError(t, err)
	require.Equal(t, service.MCPMaskedValue, created.Headers["Authorization"])

	result, err := svc.TestServer(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, result.Connected)

	// 编辑时回传掩码 = 不改动该项（否则一次编辑就把凭据清空了）
	updated, err := svc.UpdateServer(ctx, created.ID, service.MCPServerInput{
		Name: "改名后", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true,
		AuthType: model.MCPAuthHeader, Headers: map[string]string{"Authorization": service.MCPMaskedValue},
	})
	require.NoError(t, err)
	require.Equal(t, "改名后", updated.Name)

	// 库里仍是真凭据 → 还能连上
	result, err = svc.TestServer(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, result.Connected)
}

func TestMCPService_InspectInfersSchemaAndPreviews(t *testing.T) {
	fake := newFakeMCPServer(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()
	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "fake", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true})
	require.NoError(t, err)

	// 第 ② 档（有 outputSchema）
	result, err := svc.Inspect(ctx, created.ID, service.MCPInspectRequest{Kind: "tool", ToolName: "list_notes"})
	require.NoError(t, err)
	require.Equal(t, model.MCPTierSchema, result.Tier)
	require.Equal(t, "notes", result.Mapping.ListPath)
	require.Equal(t, "headline", result.Mapping.Title)

	// 第 ③ 档（结构化 JSON，无 schema）：按字段名预填 + 出预览
	result, err = svc.Inspect(ctx, created.ID, service.MCPInspectRequest{Kind: "tool", ToolName: "list_notes_no_schema", Limit: 5})
	require.NoError(t, err)
	require.Equal(t, model.MCPTierStructured, result.Tier)
	require.Equal(t, "data.items", result.Mapping.ListPath)
	require.Equal(t, "id", result.Mapping.ID)
	require.Len(t, result.Preview, 2)
	require.Equal(t, "第一条笔记", result.Preview[0].Title)
	require.Equal(t, "n1", result.Preview[0].Key)
	require.Equal(t, model.MCPKeyLevelField, result.Preview[0].KeyLevel)
}

func TestMCPService_InspectResource(t *testing.T) {
	fake := newFakeMCPServer(t)
	svc, _, _ := newMCPService(t)
	created, err := svc.CreateServer(context.Background(), service.MCPServerInput{Name: "fake", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true})
	require.NoError(t, err)

	result, err := svc.Inspect(context.Background(), created.ID, service.MCPInspectRequest{Kind: "resource", ResourceURI: "notes://today"})
	require.NoError(t, err)
	require.Equal(t, model.MCPTierText, result.Tier)
	require.Len(t, result.Preview, 2)
	require.Equal(t, "早报", result.Preview[0].Title)
}

func TestMCPService_InspectFailureKeepsReason(t *testing.T) {
	fake := newFakeMCPServer(t)
	fake.failToolsCall = true
	svc, _, _ := newMCPService(t)
	created, err := svc.CreateServer(context.Background(), service.MCPServerInput{Name: "fake", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true})
	require.NoError(t, err)

	_, err = svc.Inspect(context.Background(), created.ID, service.MCPInspectRequest{Kind: "tool", ToolName: "list_notes"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "isError")
}

func TestMCPService_InspectResourceLinkTier(t *testing.T) {
	// 第 ① 档：工具直接返回 resource_link（没有文本）——以前这条路径会掉进「没有可用内容」，是回归点
	fake := newFakeMCPServer(t)
	svc, _, _ := newMCPService(t)
	created, err := svc.CreateServer(context.Background(), service.MCPServerInput{Name: "fake", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true})
	require.NoError(t, err)

	result, err := svc.Inspect(context.Background(), created.ID, service.MCPInspectRequest{Kind: "tool", ToolName: "link_bundle", Limit: 5})
	require.NoError(t, err)
	require.Empty(t, result.Error)
	require.Equal(t, model.MCPTierResource, result.Tier)
	require.Equal(t, "name", result.Mapping.Title)
	require.Equal(t, "uri", result.Mapping.URL)
	require.Len(t, result.Preview, 2)
	require.Equal(t, "链接一", result.Preview[0].Title)
	require.Equal(t, "https://example.com/link/1", result.Preview[0].URL)
	require.Equal(t, model.MCPKeyLevelLink, result.Preview[0].KeyLevel)
}

func TestMCPService_FetchFeedItems(t *testing.T) {
	fake := newFakeMCPServer(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()
	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "fake", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true})
	require.NoError(t, err)

	config := model.MCPFeedConfig{
		ServerID: model.SnowflakeID(created.ID),
		Kind:     "tool",
		ToolName: "list_notes_no_schema",
		Limit:    20,
		Mapping:  model.MCPFieldMapping{ListPath: "data.items", Title: "title", URL: "url", Content: "content", PublishedAt: "updated_at", ID: "id"},
		Tier:     model.MCPTierStructured,
	}
	raw, err := service.BuildMCPFeedConfig(config)
	require.NoError(t, err)

	feed := model.Feed{ID: 42, Title: "MCP 源", URL: "mcp://x", SourceType: model.FeedSourceMCP, MCPConfig: &raw}
	result, err := svc.FetchFeedItems(ctx, feed)
	require.NoError(t, err)
	require.Len(t, result.Items, 2)

	// GUID = 去重键 ⇒ 与 RSS 的 computeEntryHash 退化顺序一致
	require.Equal(t, "n1", result.Items[0].GUID)
	require.Equal(t, "第一条笔记", result.Items[0].Title)
	require.Equal(t, "https://notes.example/1", result.Items[0].Link)
	require.NotNil(t, result.Items[0].PublishedParsed)
	require.Equal(t, model.MCPKeyLevelField, result.KeyLevel)
}

func TestMCPService_FetchWithoutURLGetsInternalLink(t *testing.T) {
	fake := newFakeMCPServer(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()
	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "fake", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true})
	require.NoError(t, err)

	// 映射里没给链接字段：给一个稳定的内部地址（否则 saveEntries 会把条目当空 URL 跳过）
	config := model.MCPFeedConfig{
		ServerID: model.SnowflakeID(created.ID), Kind: "tool", ToolName: "list_notes_no_schema", Limit: 20,
		Mapping: model.MCPFieldMapping{ListPath: "data.items", Title: "title", Content: "content", ID: "id"},
		Tier:    model.MCPTierStructured,
	}
	raw, err := service.BuildMCPFeedConfig(config)
	require.NoError(t, err)
	feed := model.Feed{ID: 1, SourceType: model.FeedSourceMCP, MCPConfig: &raw}

	result, err := svc.FetchFeedItems(ctx, feed)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(result.Items[0].Link, "mcp://server/"), result.Items[0].Link)

	// 同一条重复取回：地址稳定 ⇒ 不会重复入库
	result2, err := svc.FetchFeedItems(ctx, feed)
	require.NoError(t, err)
	require.Equal(t, result.Items[0].Link, result2.Items[0].Link)
}

func TestMCPService_DeleteBlockedWhileInUse(t *testing.T) {
	fake := newFakeMCPServer(t)
	svc, servers, feeds := newMCPService(t)
	ctx := context.Background()

	// 还没订阅用它：删得掉
	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "fake", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true})
	require.NoError(t, err)
	require.NoError(t, svc.DeleteServer(ctx, created.ID))

	// 重建一条，并真的挂一条订阅上去（mcp_config 里的 serverId 是字符串形式）
	created, err = svc.CreateServer(ctx, service.MCPServerInput{Name: "fake2", URL: fake.server.URL, Enabled: true, UseGlobalFetch: true})
	require.NoError(t, err)

	rawConfig, err := service.BuildMCPFeedConfig(model.MCPFeedConfig{ServerID: model.SnowflakeID(created.ID), Kind: "tool", ToolName: "list_notes"})
	require.NoError(t, err)
	_, err = feeds.Create(ctx, model.Feed{Title: "MCP 订阅", URL: "mcp://x/y", Type: "article", SourceType: model.FeedSourceMCP, MCPConfig: &rawConfig})
	require.NoError(t, err)

	used, err := servers.CountFeedsUsing(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, 1, used)

	err = svc.DeleteServer(ctx, created.ID)
	require.Error(t, err)
	require.ErrorIs(t, err, service.ErrMCPInUse)
	require.Contains(t, err.Error(), "还有 1 条订阅在用")

	// 老写法（数字 serverId）也要认得出来
	legacy := `{"serverId":1234567890123456789,"kind":"tool","toolName":"t"}`
	_, err = feeds.Create(ctx, model.Feed{Title: "老写法", URL: "mcp://x/legacy", Type: "article", SourceType: model.FeedSourceMCP, MCPConfig: &legacy})
	require.NoError(t, err)
	legacyUsed, err := servers.CountFeedsUsing(ctx, 1234567890123456789)
	require.NoError(t, err)
	require.Equal(t, 1, legacyUsed)
}

func TestBuildMCPFeedConfig_ServerIDIsString(t *testing.T) {
	// 项目铁律：Snowflake ID 必须以字符串出 JSON —— 前端 JS 处理不了 > 2^53 的数字
	raw, err := service.BuildMCPFeedConfig(model.MCPFeedConfig{ServerID: model.SnowflakeID(2100907443532861440), Kind: "tool", ToolName: "t"})
	require.NoError(t, err)
	require.Contains(t, raw, `"serverId":"2100907443532861440"`)

	// 老数据（数字形式）也要能解析回来
	var config model.MCPFeedConfig
	require.NoError(t, json.Unmarshal([]byte(`{"serverId":2100907443532861440,"kind":"tool","toolName":"t"}`), &config))
	require.Equal(t, int64(2100907443532861440), config.ServerID.Int64())
}

func TestParseMCPFeedConfig(t *testing.T) {
	_, err := service.ParseMCPFeedConfig(nil)
	require.Error(t, err)

	raw := `{"serverId":7,"kind":"tool","toolName":"t","mapping":{"title":"title"}}`
	config, err := service.ParseMCPFeedConfig(&raw)
	require.NoError(t, err)
	require.Equal(t, model.SnowflakeID(7), config.ServerID)

	bad := `{`
	_, err = service.ParseMCPFeedConfig(&bad)
	require.Error(t, err)
}

func TestMCPFeedURL_StableAndUniquePerArgs(t *testing.T) {
	base := model.MCPFeedConfig{ServerID: model.SnowflakeID(5), Kind: "tool", ToolName: "search"}
	require.Equal(t, "mcp://5/tool/search", service.MCPFeedURL(base))

	withArgs := base
	withArgs.Arguments = map[string]any{"q": "go"}
	urlA := service.MCPFeedURL(withArgs)
	require.NotEqual(t, service.MCPFeedURL(base), urlA)
	require.Equal(t, urlA, service.MCPFeedURL(withArgs), "同参数必须得到同一个地址（去重靠它）")
}
