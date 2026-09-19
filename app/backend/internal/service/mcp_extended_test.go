package service_test

// 16-8 / 16-10 / 16-11 / 16-12 / 16-3 新口径的后端测试。
// 对手方一律是 httptest 真服务器（不 mock 出网层，只 mock AI 那一次调用）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/internal/repository/testutil"
	"gist/backend/internal/service"
	"gist/backend/internal/service/mcp"
	"gist/backend/pkg/network"
)

// ---------------------------------------------------------------------------
// 16-12：失败 4 桶 + 未知兜底
// ---------------------------------------------------------------------------

func TestMCPClassify_Buckets(t *testing.T) {
	endpoint := "http://192.0.2.1:8931/mcp"

	failure := mcp.Classify(&mcp.HTTPError{StatusCode: 401, Body: `{"error":"invalid_token"}`}, endpoint)
	require.Equal(t, model.MCPFailureAuth, failure.Bucket)
	require.Equal(t, "unauthorized", failure.Code)
	require.NotEmpty(t, failure.Title)
	require.NotEmpty(t, failure.Suggestion)
	require.NotEmpty(t, failure.Raw)

	failure = mcp.Classify(&mcp.HTTPError{StatusCode: 404, Body: "not found"}, endpoint)
	require.Equal(t, model.MCPFailureProtocol, failure.Bucket)
	require.Equal(t, "not_found", failure.Code)

	failure = mcp.Classify(&mcp.HTTPError{StatusCode: 502, Body: "bad gateway"}, endpoint)
	require.Equal(t, model.MCPFailureUpstream, failure.Bucket)

	failure = mcp.Classify(errors.New(`dial tcp 192.0.2.1:8931: connect: connection refused`), endpoint)
	require.Equal(t, model.MCPFailureNetwork, failure.Bucket)
	require.Equal(t, "refused", failure.Code)

	failure = mcp.Classify(&net.DNSError{Err: "no such host", Name: "mcp.invalid"}, endpoint)
	require.Equal(t, model.MCPFailureNetwork, failure.Bucket)
	require.Equal(t, "dns", failure.Code)

	failure = mcp.Classify(errors.New(`x509: certificate signed by unknown authority`), endpoint)
	require.Equal(t, model.MCPFailureNetwork, failure.Bucket)
	require.Equal(t, "tls", failure.Code)

	// 兜底：分不进去的也有 unknown 桶，界面永远有话可说
	failure = mcp.Classify(errors.New("weird boom"), endpoint)
	require.Equal(t, model.MCPFailureUnknown, failure.Bucket)
	require.Equal(t, "unknown", failure.Code)
	require.NotEmpty(t, failure.Title)
}

func TestMCPClassify_FailureIsVisibleInTestResult(t *testing.T) {
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	// 127.0.0.1:1 必定拒绝 —— 断言结构化失败一路回到 TestResult
	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "down", URL: "http://127.0.0.1:1/mcp", Enabled: true})
	require.NoError(t, err)
	result, err := svc.TestServer(ctx, created.ID)
	require.Error(t, err)
	require.False(t, result.Connected)
	require.NotNil(t, result.Failure)
	require.Equal(t, model.MCPFailureNetwork, result.Failure.Bucket)
	require.Equal(t, "refused", result.Failure.Code)
	require.NotEmpty(t, result.Failure.Suggestion)

	// 列表行也能拿到同一套（lastFailure 进库）
	servers, err := svc.ListServers(ctx)
	require.NoError(t, err)
	require.Len(t, servers, 1)
	require.NotNil(t, servers[0].LastFailure)
	var stored model.MCPFailure
	require.NoError(t, json.Unmarshal([]byte(*servers[0].LastFailure), &stored))
	require.Equal(t, model.MCPFailureNetwork, stored.Bucket)
}

// ---------------------------------------------------------------------------
// 16-10：传输自动识别 + 记住上次成功的
// ---------------------------------------------------------------------------

func TestMCPTransport_AutoRemembersSuccess(t *testing.T) {
	fake := newFakeMCPServer(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "auto", URL: fake.server.URL, Enabled: true})
	require.NoError(t, err)
	require.Equal(t, model.MCPTransportAuto, created.Transport)

	result, err := svc.TestServer(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, result.Connected)
	require.Equal(t, model.MCPTransportStreamableHTTP, result.Transport)

	// 记住了：库里的 last_transport 就是这次成功的
	servers, err := svc.ListServers(ctx)
	require.NoError(t, err)
	require.Len(t, servers, 1)
	require.Equal(t, model.MCPTransportStreamableHTTP, servers[0].LastTransport)

	// 重新探测：清掉记忆再测一次，照样连上
	redetected, err := svc.RedetectTransport(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, redetected.Connected)
	require.Equal(t, model.MCPTransportStreamableHTTP, redetected.Transport)
}

// fakeSSEMCP 最小的旧版 HTTP+SSE 服务器：GET /sse 建流（先回 endpoint 事件），
// POST /message 收 JSON-RPC（回 202），响应从流里按 id 回去。
type fakeSSEMCP struct {
	server *httptest.Server
	// POST 收到的响应经这条 chan 喂给 GET 长连接（chan 本身并发安全，不用锁）
	stream chan []byte
}

func newFakeSSEMCP(t *testing.T) *fakeSSEMCP {
	t.Helper()
	fake := &fakeSSEMCP{stream: make(chan []byte, 16)}
	mux := http.NewServeMux()
	mux.HandleFunc("/sse", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			// 现实中的 SSE 端点只接受 GET：POST 打过来 404 —— 这正是 auto 换路的信号
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("not found"))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		require.True(t, ok)
		_, _ = fmt.Fprintf(w, "event: endpoint\ndata: /message?sessionId=s1\n\n")
		flusher.Flush()
		for {
			select {
			case <-r.Context().Done():
				return
			case msg := <-fake.stream:
				_, _ = fmt.Fprintf(w, "data: %s\n\n", msg)
				flusher.Flush()
			}
		}
	})
	mux.HandleFunc("/message", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     *int            `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		var result any
		switch req.Method {
		case "initialize":
			result = map[string]any{
				"protocolVersion": "2025-06-18",
				"serverInfo":      map[string]any{"name": "fake-sse", "version": "0.1"},
				"capabilities":    map[string]any{},
			}
		case "tools/list":
			result = map[string]any{"tools": []map[string]any{{"name": "ping", "inputSchema": map[string]any{"type": "object"}}}}
		case "resources/list":
			result = map[string]any{"resources": []any{}}
		default:
			result = map[string]any{}
		}
		if req.ID == nil {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": *req.ID, "result": result})
		if req.Method == "notifications/initialized" {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		fake.stream <- raw
		w.WriteHeader(http.StatusAccepted)
	})
	fake.server = httptest.NewServer(mux)
	t.Cleanup(fake.server.Close)
	return fake
}

func TestMCPTransport_SSELegacy(t *testing.T) {
	fake := newFakeSSEMCP(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{
		Name: "sse-old", URL: fake.server.URL + "/sse", Transport: "sse", Enabled: true,
	})
	require.NoError(t, err)

	result, err := svc.TestServer(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, result.Connected)
	require.Equal(t, "fake-sse", result.ServerName)
	require.Equal(t, 1, result.ToolCount)
	require.Equal(t, model.MCPTransportSSE, result.Transport)
}

// auto 遇到 SSE 端点：HTTP 先失败（404），自动换 SSE 重试一次并记住
func TestMCPTransport_AutoFallsBackToSSE(t *testing.T) {
	fake := newFakeSSEMCP(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	// /message 只接受 POST：auto 先按 HTTP POST 到 /sse 会拿到 404 → 换 SSE
	created, err := svc.CreateServer(ctx, service.MCPServerInput{
		Name: "auto-sse", URL: fake.server.URL + "/sse", Enabled: true,
	})
	require.NoError(t, err)
	require.Equal(t, model.MCPTransportAuto, created.Transport)

	result, err := svc.TestServer(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, result.Connected)
	require.Equal(t, model.MCPTransportSSE, result.Transport)

	servers, err := svc.ListServers(ctx)
	require.NoError(t, err)
	require.Len(t, servers, 1)
	require.Equal(t, model.MCPTransportSSE, servers[0].LastTransport)
}

// ---------------------------------------------------------------------------
// 16-11：OAuth 全流程（发现 → DCR → PKCE → 回调 → 自动刷新）
// ---------------------------------------------------------------------------

type fakeOAuthAS struct {
	server     *httptest.Server
	mcpBaseURL string
}

func newFakeOAuthAS(t *testing.T) *fakeOAuthAS {
	t.Helper()
	fake := &fakeOAuthAS{}
	mux := http.NewServeMux()

	// MCP 本体：只认 tok-1 / tok-2，其他一律 401（带 invalid_token 原文）
	mcpHandler := func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer tok-1" && auth != "Bearer tok-2" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		var req struct {
			ID     *int   `json:"id"`
			Method string `json:"method"`
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
			write(map[string]any{"protocolVersion": "2025-06-18", "serverInfo": map[string]any{"name": "oauth-mcp", "version": "1"}, "capabilities": map[string]any{}})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			write(map[string]any{"tools": []map[string]any{{"name": "ping", "inputSchema": map[string]any{"type": "object"}}}})
		case "resources/list":
			write(map[string]any{"resources": []any{}})
		default:
			write(map[string]any{})
		}
	}
	mux.HandleFunc("/mcp", mcpHandler)
	mux.HandleFunc("/mcp/.well-known/oauth-protected-resource", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"resource":               fake.mcpBaseURL,
			"authorization_servers": []string{fake.server.URL + "/as"},
		})
	})
	mux.HandleFunc("/as/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                 fake.server.URL + "/as",
			"authorization_endpoint": fake.server.URL + "/as/authorize",
			"token_endpoint":         fake.server.URL + "/as/token",
			"registration_endpoint":  fake.server.URL + "/as/register",
		})
	})
	mux.HandleFunc("/as/register", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			RedirectURIs []string `json:"redirect_uris"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		require.NotEmpty(t, body.RedirectURIs)
		_ = json.NewEncoder(w).Encode(map[string]any{"client_id": "cid-1", "client_secret": "csec-1"})
	})
	mux.HandleFunc("/as/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("grant_type") == "refresh_token" {
			require.Equal(t, "ref-1", r.Form.Get("refresh_token"))
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "tok-2", "refresh_token": "ref-2",
				"expires_in": 3600, "token_type": "Bearer",
			})
			return
		}
		switch r.Form.Get("code") {
		case "good-code":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "tok-1", "refresh_token": "ref-1",
				"expires_in": 3600, "token_type": "Bearer", "scope": "mcp",
			})
		case "expired-code":
			// 30 秒寿命：按「提前 60 秒算过期」的口径，存下来就已过期 → 下次取数触发自动刷新
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "tok-old", "refresh_token": "ref-1",
				"expires_in": 30, "token_type": "Bearer",
			})
		default:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
		}
	})
	fake.server = httptest.NewServer(mux)
	t.Cleanup(fake.server.Close)
	fake.mcpBaseURL = fake.server.URL + "/mcp"
	return fake
}

func TestMCPOAuth_FullFlow(t *testing.T) {
	fake := newFakeOAuthAS(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{
		Name: "oauth", URL: fake.mcpBaseURL, AuthType: "oauth", Enabled: true,
	})
	require.NoError(t, err)

	// ① 发现：找到授权服务器，且支持 DCR
	discovery, err := svc.OAuthDiscovery(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, fake.server.URL+"/as", discovery.AuthServer)
	require.True(t, discovery.HasDCR)
	require.False(t, discovery.NeedsManual)

	// ② 开始：回授权地址（含 PKCE challenge），client 凭证进库
	start, err := svc.OAuthStart(ctx, created.ID, "http://localhost:8082/api/mcp/oauth/callback", "mcp", "", "")
	require.NoError(t, err)
	require.NotEmpty(t, start.State)
	parsed, err := url.Parse(start.AuthURL)
	require.NoError(t, err)
	query := parsed.Query()
	require.Equal(t, "code", query.Get("response_type"))
	require.Equal(t, "cid-1", query.Get("client_id"))
	require.Equal(t, "S256", query.Get("code_challenge_method"))
	require.NotEmpty(t, query.Get("code_challenge"))
	require.Equal(t, fake.mcpBaseURL, query.Get("resource"))

	// ③ 回调换 token：出接口掩码，库里是真值
	masked, err := svc.OAuthCallback(ctx, start.State, "good-code")
	require.NoError(t, err)
	require.True(t, masked.OAuthAuthorized())
	require.Equal(t, service.MCPMaskedValue, masked.OAuthAccessToken)
	require.Equal(t, service.MCPMaskedValue, masked.OAuthRefreshToken)
	raw, err := svc.GetServer(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, raw.OAuthAuthorized())
	require.Equal(t, "tok-1", raw.OAuthAccessToken)
	require.Equal(t, "ref-1", raw.OAuthRefreshToken)

	// ④ 带着 token 取数：连上
	result, err := svc.TestServer(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, result.Connected)
	require.Equal(t, "oauth-mcp", result.ServerName)

	// ⑤ state 单次有效：重放同一个 state 被拒
	_, err = svc.OAuthCallback(ctx, start.State, "good-code")
	require.Error(t, err)
}

func TestMCPOAuth_AutoRefresh(t *testing.T) {
	fake := newFakeOAuthAS(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{
		Name: "oauth-exp", URL: fake.mcpBaseURL, AuthType: "oauth", Enabled: true,
	})
	require.NoError(t, err)

	start, err := svc.OAuthStart(ctx, created.ID, "http://localhost:8082/api/mcp/oauth/callback", "", "", "")
	require.NoError(t, err)
	_, err = svc.OAuthCallback(ctx, start.State, "expired-code")
	require.NoError(t, err)

	// 存的是过期 token：下次 TestServer 自动用 refresh_token 换新的再连
	raw, err := svc.GetServer(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, raw.OAuthTokenExpired())

	result, err := svc.TestServer(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, result.Connected)

	raw, err = svc.GetServer(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, "tok-2", raw.OAuthAccessToken)
	require.Equal(t, "ref-2", raw.OAuthRefreshToken)

	// 撤销：token 与 secret 清掉，client_id 留着
	require.NoError(t, svc.OAuthRevoke(ctx, created.ID))
	raw, err = svc.GetServer(ctx, created.ID)
	require.NoError(t, err)
	require.False(t, raw.OAuthAuthorized())
	require.Empty(t, raw.OAuthAccessToken)
}

func TestMCPOAuth_NotAuthorizedIsAuthBucket(t *testing.T) {
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{
		Name: "oauth-noauth", URL: "http://127.0.0.1:1/mcp", AuthType: "oauth", Enabled: true,
	})
	require.NoError(t, err)
	result, err := svc.TestServer(ctx, created.ID)
	require.Error(t, err)
	require.NotNil(t, result.Failure)
	require.Equal(t, model.MCPFailureAuth, result.Failure.Bucket)
}

// ---------------------------------------------------------------------------
// 16-8：追历史分页（单次调用内 cursor 循环 + 双上限）
// ---------------------------------------------------------------------------

type fakePagedMCP struct {
	server *httptest.Server
	mu     sync.Mutex
	calls  []string
}

func newFakePagedMCP(t *testing.T) *fakePagedMCP {
	t.Helper()
	fake := &fakePagedMCP{}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
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
			write(map[string]any{"protocolVersion": "2025-06-18", "serverInfo": map[string]any{"name": "paged", "version": "1"}, "capabilities": map[string]any{}})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			write(map[string]any{"tools": []map[string]any{{
				"name":        "paged_list",
				"description": "分页工具",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
					"query":  map[string]any{"type": "string"},
					"cursor": map[string]any{"type": "string"},
				}},
			}}})
		case "tools/call":
			var params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			}
			_ = json.Unmarshal(req.Params, &params)
			cursor, _ := params.Arguments["cursor"].(string)
			fake.mu.Lock()
			fake.calls = append(fake.calls, cursor)
			fake.mu.Unlock()
			item := func(id, title string) map[string]any {
				return map[string]any{"id": id, "title": title, "url": "https://paged.example/" + id, "content": "正文 " + id, "updated_at": "2026-09-18T10:00:00Z"}
			}
			if cursor == "" {
				write(map[string]any{"content": []map[string]any{{"type": "text", "text": toJSON(t, map[string]any{
					"items": []map[string]any{item("a", "甲"), item("b", "乙")}, "nextCursor": "p2",
				})}}})
				return
			}
			if cursor == "p2" {
				write(map[string]any{"content": []map[string]any{{"type": "text", "text": toJSON(t, map[string]any{
					"items": []map[string]any{item("c", "丙")},
				})}}})
				return
			}
			write(map[string]any{"content": []map[string]any{{"type": "text", "text": `{"items":[]}`}}})
		case "resources/list":
			write(map[string]any{"resources": []any{}})
		default:
			write(map[string]any{})
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func toJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	return string(raw)
}

func pagedFeedConfig(serverID int64, mode string, maxPages, maxItems int) model.Feed {
	config := map[string]any{
		"serverId":   fmt.Sprintf("%d", serverID),
		"kind":       "tool",
		"toolName":   "paged_list",
		"arguments":  map[string]any{},
		"limit":      10,
		"mapping":    map[string]any{},
		"pagination": map[string]any{"mode": mode, "maxPages": maxPages, "maxItems": maxItems},
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		panic(err)
	}
	text := string(encoded)
	return model.Feed{SourceType: model.FeedSourceMCP, MCPConfig: &text}
}

func TestMCPPagination_HistoryLoop(t *testing.T) {
	fake := newFakePagedMCP(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "paged", URL: fake.server.URL, Enabled: true})
	require.NoError(t, err)

	// history：两页游标走完，3 条全收
	fetched, err := svc.FetchFeedItems(ctx, pagedFeedConfig(created.ID, "history", 3, 200))
	require.NoError(t, err)
	require.Len(t, fetched.Items, 3)
	require.Equal(t, []string{"", "p2"}, fake.calls)

	// 条数上限：最多 2 条（第二页白跑一趟但结果截断）
	fake.calls = nil
	fetched, err = svc.FetchFeedItems(ctx, pagedFeedConfig(created.ID, "history", 3, 2))
	require.NoError(t, err)
	require.Len(t, fetched.Items, 2)

	// single：只取第一页
	fake.calls = nil
	fetched, err = svc.FetchFeedItems(ctx, pagedFeedConfig(created.ID, "single", 3, 200))
	require.NoError(t, err)
	require.Len(t, fetched.Items, 2)
	require.Equal(t, []string{""}, fake.calls)
}

func TestMCPInspect_ReturnsCursorForLoadMore(t *testing.T) {
	fake := newFakePagedMCP(t)
	svc, _, _ := newMCPService(t)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "paged", URL: fake.server.URL, Enabled: true})
	require.NoError(t, err)

	inspected, err := svc.Inspect(ctx, created.ID, service.MCPInspectRequest{Kind: "tool", ToolName: "paged_list", Limit: 5})
	require.NoError(t, err)
	require.NotEmpty(t, inspected.Preview)
	require.Equal(t, "p2", inspected.NextCursor)
	require.Equal(t, "cursor", inspected.CursorParam)
}

// ---------------------------------------------------------------------------
// 16-3：第 4 档 AI 兜底（一次调用、只返回不落库）
// ---------------------------------------------------------------------------

type stubAIService struct {
	complete func(ctx context.Context, system, content string) (string, error)
	model    string
}

func (s *stubAIService) GetCachedSummary(ctx context.Context, entryID int64, isReadability bool) (*model.AISummary, error) {
	return nil, nil
}
func (s *stubAIService) Summarize(ctx context.Context, entryID int64, content, title string, isReadability bool) (<-chan string, <-chan error, error) {
	return nil, nil, nil
}
func (s *stubAIService) SaveSummary(ctx context.Context, entryID int64, isReadability bool, summary string) error {
	return nil
}
func (s *stubAIService) GetSummaryLanguage(ctx context.Context) string { return "" }
func (s *stubAIService) GetCachedTranslation(ctx context.Context, entryID int64, isReadability bool) (*model.AITranslation, error) {
	return nil, nil
}
func (s *stubAIService) TranslateBlocks(ctx context.Context, entryID int64, content, title string, isReadability bool) ([]service.TranslateBlockInfo, <-chan service.TranslateBlockResult, <-chan error, error) {
	return nil, nil, nil, nil
}
func (s *stubAIService) SaveTranslation(ctx context.Context, entryID int64, isReadability bool, content string) error {
	return nil
}
func (s *stubAIService) TranslateBatch(ctx context.Context, articles []service.BatchArticleInput) (<-chan service.BatchTranslateResult, <-chan error, error) {
	return nil, nil, nil
}
func (s *stubAIService) ClearAllCache(ctx context.Context) (int64, int64, int64, error) {
	return 0, 0, 0, nil
}
func (s *stubAIService) Complete(ctx context.Context, systemPrompt, content string) (string, error) {
	return s.complete(ctx, systemPrompt, content)
}
func (s *stubAIService) ModelName(ctx context.Context) string { return s.model }

// fakeTextMCP 纯文本档（第 ④ 档）：text 不是 JSON，只能 Markdown 切分
func fakeTextMCP(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var req struct {
			ID     *int   `json:"id"`
			Method string `json:"method"`
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
			write(map[string]any{"protocolVersion": "2025-06-18", "serverInfo": map[string]any{"name": "texty", "version": "1"}, "capabilities": map[string]any{}})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			write(map[string]any{"tools": []map[string]any{{"name": "daily", "inputSchema": map[string]any{"type": "object"}}}})
		case "tools/call":
			write(map[string]any{"content": []map[string]any{{"type": "text", "text": "# 早报\n\n- 头条：A 发生了\n- 次条：B 发生了\n\n# 晚报\n\n- 头条：C 发生了"}}})
		case "resources/list":
			write(map[string]any{"resources": []any{}})
		default:
			write(map[string]any{})
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func newMCPServiceWithAI(t *testing.T, ai service.AIService) (service.MCPService, repository.MCPServerRepository) {
	t.Helper()
	conn := testutil.NewTestDB(t)
	servers := repository.NewMCPServerRepository(conn)
	clientFactory := network.NewClientFactoryForTest(&http.Client{})
	return service.NewMCPService(servers, nil, clientFactory, ai), servers
}

func TestMCPSuggest_AICalledOnce(t *testing.T) {
	server := fakeTextMCP(t)
	calls := 0
	stub := &stubAIService{model: "fake-model", complete: func(ctx context.Context, system, content string) (string, error) {
		calls++
		require.Contains(t, system, "listPath")
		require.Contains(t, content, "早报")
		return `{"listPath":"","title":"sections.1","url":"","content":"sections","publishedAt":"","id":""}`, nil
	}}
	svc, _ := newMCPServiceWithAI(t, stub)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "texty", URL: server.URL, Enabled: true})
	require.NoError(t, err)

	result, err := svc.SuggestMapping(ctx, created.ID, service.MCPSuggestRequest{Kind: "tool", ToolName: "daily", Limit: 5})
	require.NoError(t, err)
	require.Equal(t, 1, calls, "AI 必须只调一次")
	require.Equal(t, "sections.1", result.Mapping.Title)
	require.Equal(t, "fake-model", result.Model)
	require.Greater(t, result.EstimatedTokens, 0)
}

func TestMCPSuggest_NoAIConfigured(t *testing.T) {
	svc, _, _ := newMCPService(t)
	ctx := context.Background()
	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "x", URL: "http://127.0.0.1:1/mcp", Enabled: true})
	require.NoError(t, err)
	_, err = svc.SuggestMapping(ctx, created.ID, service.MCPSuggestRequest{Kind: "tool", ToolName: "daily"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "AI 未配置")
}

func TestMCPSuggest_NotTextTierRejected(t *testing.T) {
	fake := newFakeMCPServer(t)
	calls := 0
	stub := &stubAIService{complete: func(ctx context.Context, system, content string) (string, error) {
		calls++
		return `{}`, nil
	}}
	svc, _ := newMCPServiceWithAI(t, stub)
	ctx := context.Background()

	created, err := svc.CreateServer(ctx, service.MCPServerInput{Name: "fake", URL: fake.server.URL, Enabled: true})
	require.NoError(t, err)
	// list_notes 是第 ② 档（有 outputSchema）：不需要 AI，直接拒绝且 AI 零调用
	_, err = svc.SuggestMapping(ctx, created.ID, service.MCPSuggestRequest{Kind: "tool", ToolName: "list_notes"})
	require.Error(t, err)
	require.Equal(t, 0, calls)
}
