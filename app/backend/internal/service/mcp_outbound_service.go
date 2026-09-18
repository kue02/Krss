//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/internal/service/mcp"
	"gist/backend/pkg/logger"
)

// ---------------------------------------------------------------------------
// 17 批（出向）：Krss 自己作为 MCP 服务器，让 Claude Code / Codex / Hermes 这类 agent
// 直接读这个阅读器（「帮我总结今天未读的」「搜我库里关于 X 的条目」）。
//
// 已拍板：B1 第一版只读 · B2 tools + resources 都要 · B3 长期 token（库里只存哈希）·
//        B4 入口放 设置 → 数据控制 · B5 用本机 Hermes 接上当验收。
// 与入向共用同一套 MCP 底座（internal/service/mcp）。
// ---------------------------------------------------------------------------

// 出向配置的 KV 键（放 settings 表，与其它设置一致）。
const (
	keyMCPOutboundEnabled      = "mcp.outbound_enabled"
	keyMCPOutboundWriteEnabled = "mcp.outbound_write_enabled"
	keyMCPOutboundTokenHash    = "mcp.outbound_token_hash"
	keyMCPOutboundTokenPrefix  = "mcp.outbound_token_prefix"
	keyMCPOutboundTokenCreated = "mcp.outbound_token_created_at"
)

// MCPTokenPrefix 长期 token 的字面前缀（便于识别与检索）。
const MCPTokenPrefix = "krss_mcp_"

// MCPOutboundStatus 出向状态（接口返回给「设置 → 数据控制」）。
type MCPOutboundStatus struct {
	Enabled bool `json:"enabled"`
	// WriteEnabled 写操作总开关（默认关；第一版只读）。
	WriteEnabled bool `json:"writeEnabled"`
	// TokenSet 是否已生成过 token；TokenPrefix 是前 8 位（明文只在生成那一次返回）。
	TokenSet      bool   `json:"tokenSet"`
	TokenPrefix   string `json:"tokenPrefix,omitempty"`
	TokenCreated  string `json:"tokenCreatedAt,omitempty"`
	Endpoint      string `json:"endpoint"`
	ProtocolVer   string `json:"protocolVersion"`
	ToolCount     int    `json:"toolCount"`
	ResourceCount int    `json:"resourceCount"`
}

// MCPRPCRequest / MCPRPCResponse：JSON-RPC 2.0 信封（与入向客户端同一套形状）。
type MCPRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type MCPRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *MCPRPCError    `json:"error,omitempty"`
}

type MCPRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// MCP 规范里的错误码。
const (
	MCPErrParse          = -32700
	MCPErrInvalidRequest = -32600
	MCPErrMethodNotFound = -32601
	MCPErrInvalidParams  = -32602
	MCPErrInternal       = -32603
)

// MCPToolDescriptor 我们对外暴露的工具定义。
type MCPToolDescriptor struct {
	Name         string          `json:"name"`
	Title        string          `json:"title,omitempty"`
	Description  string          `json:"description"`
	InputSchema  json.RawMessage `json:"inputSchema"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
	Annotations  map[string]any  `json:"annotations,omitempty"`
}

// MCPResourceDescriptor 对外暴露的资源。
type MCPResourceDescriptor struct {
	URI         string `json:"uri"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType"`
}

// MCPOutboundService 出向服务：状态/令牌 + 协议方法。
type MCPOutboundService interface {
	Status(ctx context.Context) (MCPOutboundStatus, error)
	// GenerateToken 生成长期 token：明文只在这一刻返回，库里只存哈希（B3）。
	GenerateToken(ctx context.Context) (MCPOutboundStatus, string, error)
	RevokeToken(ctx context.Context) error
	UpdateOptions(ctx context.Context, enabled, writeEnabled bool) (MCPOutboundStatus, error)
	// Authorize 校验调用方带来的 token（常量时间比较哈希）。
	Authorize(ctx context.Context, token string) bool
	// Dispatch 处理一条 JSON-RPC 请求；respond=false 表示这是通知（不回响应体）。
	Dispatch(ctx context.Context, req MCPRPCRequest) (MCPRPCResponse, bool)
	Tools(ctx context.Context) []MCPToolDescriptor
	Resources(ctx context.Context) ([]MCPResourceDescriptor, error)
	CallTool(ctx context.Context, name string, args map[string]any) (mcp.CallToolResult, error)
	ReadResource(ctx context.Context, uri string) (string, string, error)
}

type mcpOutboundService struct {
	settings repository.SettingsRepository
	entries  EntryService
	feeds    repository.FeedRepository
	folders  repository.FolderRepository
}

func NewMCPOutboundService(settings repository.SettingsRepository, entries EntryService, feeds repository.FeedRepository, folders repository.FolderRepository) MCPOutboundService {
	return &mcpOutboundService{settings: settings, entries: entries, feeds: feeds, folders: folders}
}

// ---------------------------------------------------------------------------
// 状态 / 令牌
// ---------------------------------------------------------------------------

func (s *mcpOutboundService) getString(ctx context.Context, key string) string {
	setting, err := s.settings.Get(ctx, key)
	if err != nil || setting == nil {
		return ""
	}
	return setting.Value
}

func (s *mcpOutboundService) getBool(ctx context.Context, key string, fallback bool) bool {
	value := strings.TrimSpace(s.getString(ctx, key))
	if value == "" {
		return fallback
	}
	return value == "1" || strings.EqualFold(value, "true")
}

func (s *mcpOutboundService) Status(ctx context.Context) (MCPOutboundStatus, error) {
	tools := s.Tools(ctx)
	resources, err := s.Resources(ctx)
	if err != nil {
		return MCPOutboundStatus{}, err
	}
	hash := s.getString(ctx, keyMCPOutboundTokenHash)
	return MCPOutboundStatus{
		Enabled:       s.getBool(ctx, keyMCPOutboundEnabled, true),
		WriteEnabled:  s.getBool(ctx, keyMCPOutboundWriteEnabled, false),
		TokenSet:      hash != "",
		TokenPrefix:   s.getString(ctx, keyMCPOutboundTokenPrefix),
		TokenCreated:  s.getString(ctx, keyMCPOutboundTokenCreated),
		Endpoint:      "/mcp",
		ProtocolVer:   mcp.ProtocolVersion,
		ToolCount:     len(tools),
		ResourceCount: len(resources),
	}, nil
}

func (s *mcpOutboundService) GenerateToken(ctx context.Context) (MCPOutboundStatus, string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return MCPOutboundStatus{}, "", fmt.Errorf("生成 token 失败: %w", err)
	}
	token := MCPTokenPrefix + hex.EncodeToString(raw)
	values := map[string]string{
		keyMCPOutboundTokenHash:    hashToken(token),
		keyMCPOutboundTokenPrefix:  token[:len(MCPTokenPrefix)+8],
		keyMCPOutboundTokenCreated: time.Now().UTC().Format(time.RFC3339),
	}
	if err := s.settings.SetMany(ctx, values); err != nil {
		return MCPOutboundStatus{}, "", err
	}
	logger.Info("mcp outbound token generated", "module", "service", "action", "create", "resource", "mcp_token", "result", "ok")
	status, err := s.Status(ctx)
	return status, token, err
}

func (s *mcpOutboundService) RevokeToken(ctx context.Context) error {
	for _, key := range []string{keyMCPOutboundTokenHash, keyMCPOutboundTokenPrefix, keyMCPOutboundTokenCreated} {
		if err := s.settings.Delete(ctx, key); err != nil {
			return err
		}
	}
	logger.Info("mcp outbound token revoked", "module", "service", "action", "delete", "resource", "mcp_token", "result", "ok")
	return nil
}

func (s *mcpOutboundService) UpdateOptions(ctx context.Context, enabled, writeEnabled bool) (MCPOutboundStatus, error) {
	values := map[string]string{
		keyMCPOutboundEnabled:      boolToSettingValue(enabled),
		keyMCPOutboundWriteEnabled: boolToSettingValue(writeEnabled),
	}
	if err := s.settings.SetMany(ctx, values); err != nil {
		return MCPOutboundStatus{}, err
	}
	return s.Status(ctx)
}

// Authorize 校验 token：库里只存哈希，比较哈希（长度固定，比较即常量时间）。
func (s *mcpOutboundService) Authorize(ctx context.Context, token string) bool {
	token = strings.TrimSpace(token)
	if token == "" {
		return false
	}
	if !s.getBool(ctx, keyMCPOutboundEnabled, true) {
		return false
	}
	stored := s.getString(ctx, keyMCPOutboundTokenHash)
	if stored == "" {
		return false
	}
	return stored == hashToken(token)
}

// NewMCPSessionID 给 streamable-http 会话一个不透明 id（我们无状态，只是让客户端有东西可带）。
func NewMCPSessionID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("krss-%d", time.Now().UnixNano())
	}
	return "krss-" + hex.EncodeToString(raw)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func boolToSettingValue(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

// ---------------------------------------------------------------------------
// 协议：Dispatch
// ---------------------------------------------------------------------------

func (s *mcpOutboundService) Dispatch(ctx context.Context, req MCPRPCRequest) (MCPRPCResponse, bool) {
	respond := func(result any) (MCPRPCResponse, bool) {
		return MCPRPCResponse{JSONRPC: "2.0", ID: req.ID, Result: result}, true
	}
	fail := func(code int, message string) (MCPRPCResponse, bool) {
		return MCPRPCResponse{JSONRPC: "2.0", ID: req.ID, Error: &MCPRPCError{Code: code, Message: message}}, true
	}

	switch req.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &params)
		version := mcp.ProtocolVersion
		return respond(map[string]any{
			"protocolVersion": version,
			"capabilities": map[string]any{
				"tools":     map[string]any{"listChanged": false},
				"resources": map[string]any{"subscribe": false, "listChanged": false},
			},
			"serverInfo": map[string]any{
				"name":    "krss",
				"title":   "Krss Reader",
				"version": "1.0",
			},
			"instructions": "Krss 阅读器。tools 取订阅与条目、可按关键词搜；resources 用 krss://unread、krss://feed/<id>、krss://entry/<id>。第一版默认只读。",
		})

	case "notifications/initialized", "notifications/cancelled":
		return MCPRPCResponse{}, false

	case "ping":
		return respond(map[string]any{})

	case "tools/list":
		return respond(map[string]any{"tools": s.Tools(ctx)})

	case "tools/call":
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return fail(MCPErrInvalidParams, "tools/call 参数不合法: "+err.Error())
		}
		result, err := s.CallTool(ctx, params.Name, params.Arguments)
		if err != nil {
			return fail(MCPErrInternal, err.Error())
		}
		return respond(result)

	case "resources/list":
		resources, err := s.Resources(ctx)
		if err != nil {
			return fail(MCPErrInternal, err.Error())
		}
		return respond(map[string]any{"resources": resources})

	case "resources/templates/list":
		return respond(map[string]any{"resourceTemplates": []map[string]any{
			{
				"uriTemplate": "krss://feed/{feedId}",
				"name":        "某个订阅的最新条目",
				"description": "以 markdown 返回该订阅最新 N 条（默认 20）",
				"mimeType":    "text/markdown",
			},
			{
				"uriTemplate": "krss://entry/{entryId}",
				"name":        "单条条目正文",
				"description": "以 markdown 返回单条条目的正文",
				"mimeType":    "text/markdown",
			},
			{
				"uriTemplate": "krss://unread",
				"name":        "未读列表",
				"description": "以 markdown 返回当前未读条目（默认 50 条）",
				"mimeType":    "text/markdown",
			},
		}})

	case "resources/read":
		var params struct {
			URI string `json:"uri"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return fail(MCPErrInvalidParams, "resources/read 参数不合法: "+err.Error())
		}
		mimeType, text, err := s.ReadResource(ctx, params.URI)
		if err != nil {
			return fail(MCPErrInternal, err.Error())
		}
		return respond(map[string]any{
			"contents": []map[string]any{{"uri": params.URI, "mimeType": mimeType, "text": text}},
		})
	}

	return fail(MCPErrMethodNotFound, "不支持的方法: "+req.Method)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

func toolSchema(raw string) json.RawMessage {
	return json.RawMessage(raw)
}

func (s *mcpOutboundService) Tools(ctx context.Context) []MCPToolDescriptor {
	readOnly := map[string]any{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
	writeHint := map[string]any{"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}

	tools := []MCPToolDescriptor{
		{
			Name:         "list_feeds",
			Title:        "列出订阅",
			Description:  "列出所有订阅（含文件夹、未读数、类型）。用于「我订了哪些源」「哪个源未读最多」。",
			InputSchema:  toolSchema(`{"type":"object","properties":{"includeUnreadCount":{"type":"boolean","description":"是否带未读数，默认 true"}},"additionalProperties":false}`),
			OutputSchema: toolSchema(`{"type":"object","properties":{"feeds":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"folder":{"type":"string"},"type":{"type":"string"},"unreadCount":{"type":"integer"},"sourceType":{"type":"string"}}}}},"required":["feeds"]}`),
			Annotations:  readOnly,
		},
		{
			Name:        "list_entries",
			Title:       "列出条目",
			Description: "按订阅 / 视图 / 未读 / 星标列条目。默认未读优先，limit 默认 20（上限 100）。",
			InputSchema: toolSchema(`{"type":"object","properties":{"feedId":{"type":"string","description":"订阅 id（可省略）"},"viewId":{"type":"string","description":"保存筛选视图 id（可省略）"},"unreadOnly":{"type":"boolean","description":"只看未读，默认 true"},"starredOnly":{"type":"boolean","description":"只看星标，默认 false"},"limit":{"type":"integer","description":"条数，默认 20，上限 100"}},"additionalProperties":false}`),
			OutputSchema: toolSchema(`{"type":"object","properties":{"count":{"type":"integer"},"entries":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"feedId":{"type":"string"},"title":{"type":"string"},"url":{"type":"string"},"publishedAt":{"type":"string"},"summary":{"type":"string"},"read":{"type":"boolean"},"starred":{"type":"boolean"}}}}},"required":["entries"]}`),
			Annotations: readOnly,
		},
		{
			Name:         "search_entries",
			Title:        "搜索条目",
			Description:  "按关键词检索库里的条目（复用阅读器的中文子串搜索）。",
			InputSchema:  toolSchema(`{"type":"object","properties":{"query":{"type":"string","description":"关键词"},"limit":{"type":"integer","description":"条数，默认 20，上限 100"}},"required":["query"],"additionalProperties":false}`),
			OutputSchema: toolSchema(`{"type":"object","properties":{"query":{"type":"string"},"count":{"type":"integer"},"entries":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"feedId":{"type":"string"},"title":{"type":"string"},"url":{"type":"string"},"publishedAt":{"type":"string"},"summary":{"type":"string"}}}}},"required":["entries"]}`),
			Annotations:  readOnly,
		},
		{
			Name:         "get_entry",
			Title:        "取单条正文",
			Description:  "取一条条目的完整正文（含已提取的阅读模式正文，如果有）。",
			InputSchema:  toolSchema(`{"type":"object","properties":{"id":{"type":"string","description":"条目 id"}},"required":["id"],"additionalProperties":false}`),
			OutputSchema: toolSchema(`{"type":"object","properties":{"id":{"type":"string"},"feedId":{"type":"string"},"title":{"type":"string"},"url":{"type":"string"},"author":{"type":"string"},"publishedAt":{"type":"string"},"content":{"type":"string"}},"required":["id"]}`),
			Annotations:  readOnly,
		},
	}

	// 写操作（17-3）：默认关，逐连接（这里只有一条自用连接）开关 —— 第一版只读。
	if s.getBool(ctx, keyMCPOutboundWriteEnabled, false) {
		tools = append(tools,
			MCPToolDescriptor{
				Name:        "mark_read",
				Title:       "标记已读 / 未读",
				Description: "把某条条目标为已读或未读。写操作，需要在设置里显式开启。",
				InputSchema: toolSchema(`{"type":"object","properties":{"id":{"type":"string"},"read":{"type":"boolean","description":"true=标已读，false=标未读"}},"required":["id"],"additionalProperties":false}`),
				Annotations: writeHint,
			},
			MCPToolDescriptor{
				Name:        "star_entry",
				Title:       "加星 / 取消星标",
				Description: "把某条条目加星或取消星标。写操作，需要在设置里显式开启。",
				InputSchema: toolSchema(`{"type":"object","properties":{"id":{"type":"string"},"starred":{"type":"boolean","description":"true=加星，false=取消星标"}},"required":["id"],"additionalProperties":false}`),
				Annotations: writeHint,
			},
		)
	}
	return tools
}

func (s *mcpOutboundService) CallTool(ctx context.Context, name string, args map[string]any) (mcp.CallToolResult, error) {
	if args == nil {
		args = map[string]any{}
	}
	switch name {
	case "list_feeds":
		payload, err := s.listFeeds(ctx, boolArg(args, "includeUnreadCount", true))
		if err != nil {
			return mcp.CallToolResult{}, err
		}
		return structuredResult(payload, "已列出订阅")
	case "list_entries":
		payload, err := s.listEntries(ctx, args)
		if err != nil {
			return mcp.CallToolResult{}, err
		}
		return structuredResult(payload, fmt.Sprintf("共 %d 条", payload["count"]))
	case "search_entries":
		query, _ := args["query"].(string)
		if strings.TrimSpace(query) == "" {
			return mcp.CallToolResult{}, fmt.Errorf("query 不能为空")
		}
		limit := clampLimit(intArg(args, "limit", 20), 20, 100)
		entries, err := s.entries.Search(ctx, strings.TrimSpace(query), limit)
		if err != nil {
			return mcp.CallToolResult{}, err
		}
		payload := map[string]any{"query": query, "count": len(entries), "entries": entrySummaries(entries)}
		return structuredResult(payload, fmt.Sprintf("关键词 %q 命中 %d 条", query, len(entries)))
	case "get_entry":
		id, err := idArg(args, "id")
		if err != nil {
			return mcp.CallToolResult{}, err
		}
		entry, err := s.entries.GetByID(ctx, id)
		if err != nil {
			return mcp.CallToolResult{}, fmt.Errorf("取条目 %d 失败: %w", id, err)
		}
		payload := entryDetail(entry)
		return structuredResult(payload, "已取回条目正文")
	case "mark_read":
		if !s.getBool(ctx, keyMCPOutboundWriteEnabled, false) {
			return mcp.CallToolResult{}, fmt.Errorf("写操作未开启（设置 → 数据控制 → MCP 服务器）")
		}
		id, err := idArg(args, "id")
		if err != nil {
			return mcp.CallToolResult{}, err
		}
		read := boolArg(args, "read", true)
		if err := s.entries.MarkAsRead(ctx, id, read); err != nil {
			return mcp.CallToolResult{}, err
		}
		return structuredResult(map[string]any{"id": strconv.FormatInt(id, 10), "read": read}, "已更新已读状态")
	case "star_entry":
		if !s.getBool(ctx, keyMCPOutboundWriteEnabled, false) {
			return mcp.CallToolResult{}, fmt.Errorf("写操作未开启（设置 → 数据控制 → MCP 服务器）")
		}
		id, err := idArg(args, "id")
		if err != nil {
			return mcp.CallToolResult{}, err
		}
		starred := boolArg(args, "starred", true)
		if err := s.entries.MarkAsStarred(ctx, id, starred); err != nil {
			return mcp.CallToolResult{}, err
		}
		return structuredResult(map[string]any{"id": strconv.FormatInt(id, 10), "starred": starred}, "已更新星标")
	}
	return mcp.CallToolResult{}, fmt.Errorf("未知工具: %s", name)
}

// structuredResult 规范建议「结构化内容同时把 JSON 序列化进一个 TextContent」以兼容旧客户端。
func structuredResult(payload map[string]any, text string) (mcp.CallToolResult, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return mcp.CallToolResult{}, err
	}
	return mcp.CallToolResult{
		Content: []mcp.Content{
			{Type: "text", Text: text},
			{Type: "text", Text: string(raw)},
		},
		StructuredContent: raw,
	}, nil
}

func (s *mcpOutboundService) listFeeds(ctx context.Context, withUnread bool) (map[string]any, error) {
	feeds, err := s.feeds.List(ctx, nil)
	if err != nil {
		return nil, err
	}
	unread := map[int64]int{}
	if withUnread {
		if counts, err := s.entries.GetUnreadCounts(ctx); err == nil {
			unread = counts
		}
	}
	type feedItem struct {
		ID          string `json:"id"`
		Title       string `json:"title"`
		Folder      string `json:"folder,omitempty"`
		Type        string `json:"type"`
		SourceType  string `json:"sourceType"`
		UnreadCount int    `json:"unreadCount"`
	}
	items := make([]feedItem, 0, len(feeds))
	for _, feed := range feeds {
		item := feedItem{
			ID:          strconv.FormatInt(feed.ID, 10),
			Title:       feed.Title,
			Type:        feed.Type,
			SourceType:  feedSourceTypeOrRSS(feed),
			UnreadCount: unread[feed.ID],
		}
		if feed.FolderID != nil {
			if folder, err := s.folders.GetByID(ctx, *feed.FolderID); err == nil {
				item.Folder = folder.Name
			}
		}
		items = append(items, item)
	}
	return map[string]any{"feeds": items, "count": len(items)}, nil
}

func (s *mcpOutboundService) listEntries(ctx context.Context, args map[string]any) (map[string]any, error) {
	limit := clampLimit(intArg(args, "limit", 20), 20, 100)
	params := EntryListParams{
		UnreadOnly:  boolArg(args, "unreadOnly", true),
		StarredOnly: boolArg(args, "starredOnly", false),
		Limit:       limit,
	}
	if raw := strings.TrimSpace(stringArg(args, "feedId")); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("feedId 不合法")
		}
		params.FeedID = &id
	}
	if raw := strings.TrimSpace(stringArg(args, "viewId")); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("viewId 不合法")
		}
		params.ViewID = &id
	}
	entries, err := s.entries.List(ctx, params)
	if err != nil {
		return nil, err
	}
	return map[string]any{"count": len(entries), "entries": entrySummaries(entries)}, nil
}

func entrySummaries(entries []model.Entry) []map[string]any {
	out := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entrySummary(entry))
	}
	return out
}

func entrySummary(entry model.Entry) map[string]any {
	item := map[string]any{
		"id":     strconv.FormatInt(entry.ID, 10),
		"feedId": strconv.FormatInt(entry.FeedID, 10),
	}
	if entry.Title != nil {
		item["title"] = *entry.Title
	}
	if entry.URL != nil {
		item["url"] = *entry.URL
	}
	if entry.Author != nil {
		item["author"] = *entry.Author
	}
	if entry.PublishedAt != nil {
		item["publishedAt"] = entry.PublishedAt.UTC().Format(time.RFC3339)
	}
	if summary := entrySummaryText(entry); summary != "" {
		item["summary"] = summary
	}
	item["read"] = entry.Read
	item["starred"] = entry.Starred
	return item
}

func entryDetail(entry model.Entry) map[string]any {
	item := entrySummary(entry)
	content := ""
	if entry.ReadableContent != nil && strings.TrimSpace(*entry.ReadableContent) != "" {
		content = *entry.ReadableContent
	} else if entry.Content != nil {
		content = *entry.Content
	}
	item["content"] = content
	return item
}

func entrySummaryText(entry model.Entry) string {
	source := ""
	if entry.Content != nil {
		source = *entry.Content
	}
	source = stripHTML(source)
	source = strings.Join(strings.Fields(source), " ")
	if len(source) > 300 {
		return source[:300] + "…"
	}
	return source
}

// feedSourceTypeOrRSS 空值当 rss（列本身默认 'rss'，这里只是补一层保险）。
func feedSourceTypeOrRSS(feed model.Feed) string {
	if feed.SourceType == "" {
		return model.FeedSourceRSS
	}
	return feed.SourceType
}

// stripHTML 粗剥标签（只用于给 agent 的摘要，不做 HTML 解析）。
func stripHTML(input string) string {
	var builder strings.Builder
	depth := 0
	for _, r := range input {
		switch r {
		case '<':
			depth++
		case '>':
			if depth > 0 {
				depth--
			}
		default:
			if depth == 0 {
				builder.WriteRune(r)
			}
		}
	}
	return builder.String()
}

// ---------------------------------------------------------------------------
// 资源
// ---------------------------------------------------------------------------

func (s *mcpOutboundService) Resources(ctx context.Context) ([]MCPResourceDescriptor, error) {
	out := []MCPResourceDescriptor{
		{
			URI:         "krss://unread",
			Name:        "未读列表",
			Description: "当前未读条目（markdown，默认 50 条）",
			MimeType:    "text/markdown",
		},
	}
	feeds, err := s.feeds.List(ctx, nil)
	if err != nil {
		return nil, err
	}
	sort.Slice(feeds, func(i, j int) bool { return feeds[i].Title < feeds[j].Title })
	for index, feed := range feeds {
		if index >= 200 {
			break
		}
		out = append(out, MCPResourceDescriptor{
			URI:         fmt.Sprintf("krss://feed/%d", feed.ID),
			Name:        feed.Title,
			Description: "该订阅最新条目（markdown，默认 20 条）",
			MimeType:    "text/markdown",
		})
	}
	return out, nil
}

func (s *mcpOutboundService) ReadResource(ctx context.Context, uri string) (string, string, error) {
	trimmed := strings.TrimSpace(uri)
	switch {
	case trimmed == "krss://unread":
		entries, err := s.entries.List(ctx, EntryListParams{UnreadOnly: true, Limit: 50})
		if err != nil {
			return "", "", err
		}
		return "text/markdown", entriesToMarkdown("未读条目", entries), nil
	case strings.HasPrefix(trimmed, "krss://feed/"):
		id, err := strconv.ParseInt(strings.TrimPrefix(trimmed, "krss://feed/"), 10, 64)
		if err != nil {
			return "", "", fmt.Errorf("资源地址里的订阅 id 不合法: %s", uri)
		}
		feed, err := s.feeds.GetByID(ctx, id)
		if err != nil {
			return "", "", fmt.Errorf("订阅 %d 不存在", id)
		}
		feedID := id
		entries, err := s.entries.List(ctx, EntryListParams{FeedID: &feedID, Limit: 20})
		if err != nil {
			return "", "", err
		}
		return "text/markdown", entriesToMarkdown(feed.Title, entries), nil
	case strings.HasPrefix(trimmed, "krss://entry/"):
		id, err := strconv.ParseInt(strings.TrimPrefix(trimmed, "krss://entry/"), 10, 64)
		if err != nil {
			return "", "", fmt.Errorf("资源地址里的条目 id 不合法: %s", uri)
		}
		entry, err := s.entries.GetByID(ctx, id)
		if err != nil {
			return "", "", fmt.Errorf("条目 %d 不存在", id)
		}
		return "text/markdown", entryToMarkdown(entry), nil
	}
	return "", "", fmt.Errorf("不认识的资源地址: %s（可用：krss://unread、krss://feed/<id>、krss://entry/<id>）", uri)
}

func entriesToMarkdown(title string, entries []model.Entry) string {
	var builder strings.Builder
	builder.WriteString("# " + title + "\n\n")
	if len(entries) == 0 {
		builder.WriteString("（没有条目）\n")
		return builder.String()
	}
	for _, entry := range entries {
		builder.WriteString("- ")
		if entry.Title != nil && strings.TrimSpace(*entry.Title) != "" {
			builder.WriteString(strings.TrimSpace(*entry.Title))
		} else {
			builder.WriteString("（无标题）")
		}
		meta := []string{}
		if entry.PublishedAt != nil {
			meta = append(meta, entry.PublishedAt.UTC().Format("2006-01-02 15:04"))
		}
		if entry.URL != nil && *entry.URL != "" {
			meta = append(meta, *entry.URL)
		}
		if len(meta) > 0 {
			builder.WriteString(" — " + strings.Join(meta, " · "))
		}
		builder.WriteString("\n  id: " + strconv.FormatInt(entry.ID, 10) + "\n")
		if summary := entrySummaryText(entry); summary != "" {
			builder.WriteString("  " + summary + "\n")
		}
	}
	return builder.String()
}

func entryToMarkdown(entry model.Entry) string {
	var builder strings.Builder
	if entry.Title != nil {
		builder.WriteString("# " + *entry.Title + "\n\n")
	}
	if entry.URL != nil && *entry.URL != "" {
		builder.WriteString("链接：" + *entry.URL + "\n\n")
	}
	if entry.Author != nil && *entry.Author != "" {
		builder.WriteString("作者：" + *entry.Author + "\n\n")
	}
	if entry.PublishedAt != nil {
		builder.WriteString("时间：" + entry.PublishedAt.UTC().Format(time.RFC3339) + "\n\n")
	}
	builder.WriteString("id：" + strconv.FormatInt(entry.ID, 10) + "\n\n")
	if entry.ReadableContent != nil && strings.TrimSpace(*entry.ReadableContent) != "" {
		builder.WriteString(*entry.ReadableContent)
	} else if entry.Content != nil {
		builder.WriteString(*entry.Content)
	}
	return builder.String()
}

// ---------------------------------------------------------------------------
// 参数小工具
// ---------------------------------------------------------------------------

func stringArg(args map[string]any, key string) string {
	value, ok := args[key]
	if !ok || value == nil {
		return ""
	}
	switch v := value.(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	default:
		return fmt.Sprint(v)
	}
}

func boolArg(args map[string]any, key string, fallback bool) bool {
	value, ok := args[key]
	if !ok || value == nil {
		return fallback
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		if v == "" {
			return fallback
		}
		return v == "1" || strings.EqualFold(v, "true")
	case float64:
		return v != 0
	default:
		return fallback
	}
}

func intArg(args map[string]any, key string, fallback int) int {
	value, ok := args[key]
	if !ok || value == nil {
		return fallback
	}
	switch v := value.(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		if parsed, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return parsed
		}
	}
	return fallback
}

func clampLimit(value, fallback, max int) int {
	if value <= 0 {
		return fallback
	}
	if value > max {
		return max
	}
	return value
}

func idArg(args map[string]any, key string) (int64, error) {
	raw := strings.TrimSpace(stringArg(args, key))
	if raw == "" {
		return 0, fmt.Errorf("%s 不能为空", key)
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s 不合法", key)
	}
	return id, nil
}
