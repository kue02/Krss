//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/mmcdole/gofeed"

	"gist/backend/internal/hashutil"
	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/internal/service/mcp"
	"gist/backend/pkg/logger"
	"gist/backend/pkg/network"
)

// ---------------------------------------------------------------------------
// 16 批（入向）：MCP 取到的内容当 Feed 处理。
// 抓取分叉点放在 saveEntries() 之前 —— 这里只负责「把 MCP 的返回变成 []*gofeed.Item」，
// 之后的去重 / FTS / 规则引擎 / 翻译标记一行不改。
// ---------------------------------------------------------------------------

// MCPMaskedValue 出接口时替换 Header 值的掩码（凭据不进前端、不进日志）。
const MCPMaskedValue = "••••••••"

// MCP 单连接取数频率下限（A3 已拍板：15 分钟起，有次数限额的 MCP 别被刷爆）。
const MCPMinRefreshIntervalMinutes = 15

// 建源向导预览条数（A2 已拍板：预览前 5 条是强制步骤）。
const MCPPreviewLimit = 5

var (
	ErrMCPNotFound    = errors.New("mcp server not found")
	ErrMCPInvalid     = errors.New("invalid mcp server config")
	ErrMCPDisabled    = errors.New("mcp server disabled")
	ErrMCPInUse       = errors.New("mcp server in use")
	ErrMCPUnsupported = errors.New("unsupported mcp transport")
)

// MCPServerInput 新建 / 编辑连接的入参（来自接口 Body）。
type MCPServerInput struct {
	Name                   string
	Transport              string
	URL                    string
	AuthType               string
	Headers                map[string]string
	Enabled                bool
	Purposes               []string
	UseGlobalFetch         bool
	FetchTimeoutSeconds    *int
	FetchConcurrency       *int
	RefreshIntervalMinutes *int
}

// MCPTestResult 连通性测试结果（回服务名/版本/工具与资源计数）。
type MCPTestResult struct {
	Connected     bool   `json:"connected"`
	ServerName    string `json:"serverName,omitempty"`
	ServerVersion string `json:"serverVersion,omitempty"`
	ToolCount     int    `json:"toolCount"`
	ResourceCount int    `json:"resourceCount"`
	Error         string `json:"error,omitempty"`
}

// MCPToolListResult 工具 + 资源清单（建源向导第二步用）。
type MCPToolListResult struct {
	Tools     []MCPToolItem     `json:"tools"`
	Resources []MCPResourceItem `json:"resources"`
}

type MCPToolItem struct {
	Name         string          `json:"name"`
	Title        string          `json:"title,omitempty"`
	Description  string          `json:"description,omitempty"`
	InputSchema  json.RawMessage `json:"inputSchema,omitempty"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
}

type MCPResourceItem struct {
	URI         string `json:"uri"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

// MCPInspectRequest 干跑一次调用（建源向导第三步：预览前 5 条 + 自动推断映射）。
type MCPInspectRequest struct {
	Kind        string
	ToolName    string
	ResourceURI string
	Arguments   map[string]any
	Limit       int
	// Mapping 有值 = 用户手改后的映射再预览一次（空 = 让后端自动推断）
	Mapping *model.MCPFieldMapping
	Tier    string
}

// MCPPreviewItem 预览里的一条（含算出来的去重键与「用了哪一级」）。
type MCPPreviewItem struct {
	Title       string `json:"title,omitempty"`
	URL         string `json:"url,omitempty"`
	Content     string `json:"content,omitempty"`
	PublishedAt string `json:"publishedAt,omitempty"`
	Author      string `json:"author,omitempty"`
	Key         string `json:"key"`
	KeyLevel    string `json:"keyLevel"`
}

// MCPInspectResult 干跑结果：档位 + 映射 + 预览 + 可能的报错。
type MCPInspectResult struct {
	Tier      string               `json:"tier"`
	Mapping   model.MCPFieldMapping `json:"mapping"`
	KeyLevel  string               `json:"keyLevel"`
	Notes     []string             `json:"notes"`
	Preview   []MCPPreviewItem     `json:"preview"`
	Total     int                  `json:"total"`
	Error     string               `json:"error,omitempty"`
	Truncated bool                 `json:"truncated,omitempty"`
}

// MCPFetchResult 抓一次的结果（去重键的取值与档位一并回传，供 last_error / 调试）。
type MCPFetchResult struct {
	Items    []*gofeed.Item
	Tier     string
	KeyLevel string
}

// MCPService MCP 连接管理 + 取数。
type MCPService interface {
	ListServers(ctx context.Context) ([]model.MCPServer, error)
	GetServer(ctx context.Context, id int64) (model.MCPServer, error)
	CreateServer(ctx context.Context, input MCPServerInput) (model.MCPServer, error)
	UpdateServer(ctx context.Context, id int64, input MCPServerInput) (model.MCPServer, error)
	DeleteServer(ctx context.Context, id int64) error
	// TestServer 连通性测试（回工具/资源计数），并把状态写回该连接。
	TestServer(ctx context.Context, id int64) (MCPTestResult, error)
	ListTools(ctx context.Context, id int64) (MCPToolListResult, error)
	// Inspect 干跑一次调用并预览前 5 条 + 自动推断映射（不写库、不落条目）。
	Inspect(ctx context.Context, id int64, req MCPInspectRequest) (MCPInspectResult, error)
	// FetchFeedItems 按该订阅的映射抓一次，产出可直接进 saveEntries 的条目。
	FetchFeedItems(ctx context.Context, feed model.Feed) (MCPFetchResult, error)
}

type mcpService struct {
	servers       repository.MCPServerRepository
	settings      SettingsService
	clientFactory *network.ClientFactory
}

func NewMCPService(servers repository.MCPServerRepository, settings SettingsService, clientFactory *network.ClientFactory) MCPService {
	return &mcpService{servers: servers, settings: settings, clientFactory: clientFactory}
}

func (s *mcpService) ListServers(ctx context.Context) ([]model.MCPServer, error) {
	servers, err := s.servers.List(ctx)
	if err != nil {
		return nil, err
	}
	for i := range servers {
		servers[i] = MaskMCPServer(servers[i])
	}
	return servers, nil
}

func (s *mcpService) GetServer(ctx context.Context, id int64) (model.MCPServer, error) {
	return s.servers.GetByID(ctx, id)
}

// MaskMCPServer 出接口前把 Header 值打成掩码（凭据只存在于库里与出网那一刻）。
func MaskMCPServer(server model.MCPServer) model.MCPServer {
	if len(server.Headers) == 0 {
		return server
	}
	masked := make(map[string]string, len(server.Headers))
	for key := range server.Headers {
		masked[key] = MCPMaskedValue
	}
	server.Headers = masked
	return server
}

// IsMaskedMCPValue 判断前端回传的是不是「没改过的掩码值」。
func IsMaskedMCPValue(value string) bool {
	return strings.TrimSpace(value) == MCPMaskedValue
}

func normalizeMCPInput(input MCPServerInput) (MCPServerInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.URL = strings.TrimSpace(input.URL)
	if input.Name == "" {
		return input, fmt.Errorf("%w: 名称不能为空", ErrMCPInvalid)
	}
	if input.URL == "" || !strings.HasPrefix(input.URL, "http") {
		return input, fmt.Errorf("%w: 地址必须是 http(s) 开头的完整 URL", ErrMCPInvalid)
	}
	if input.Transport == "" {
		input.Transport = model.MCPTransportStreamableHTTP
	}
	if input.Transport != model.MCPTransportStreamableHTTP {
		return input, fmt.Errorf("%w: 第一版只支持 %s（%s 留后面）", ErrMCPUnsupported, model.MCPTransportStreamableHTTP, input.Transport)
	}
	if input.AuthType == "" {
		input.AuthType = model.MCPAuthNone
	}
	if input.AuthType != model.MCPAuthNone && input.AuthType != model.MCPAuthHeader {
		return input, fmt.Errorf("%w: 第一版只做无认证 + Header 认证", ErrMCPInvalid)
	}
	if input.AuthType == model.MCPAuthNone {
		input.Headers = nil
	}
	if len(input.Purposes) == 0 {
		input.Purposes = []string{model.MCPPurposeAI}
	}
	for _, purpose := range input.Purposes {
		if purpose != model.MCPPurposeAI && purpose != model.MCPPurposeFeed {
			return input, fmt.Errorf("%w: 用途标记只能是 ai / feed", ErrMCPInvalid)
		}
	}
	if input.RefreshIntervalMinutes != nil {
		if *input.RefreshIntervalMinutes < MCPMinRefreshIntervalMinutes {
			return input, fmt.Errorf("%w: 单连接刷新间隔下限 %d 分钟", ErrMCPInvalid, MCPMinRefreshIntervalMinutes)
		}
	}
	if input.UseGlobalFetch {
		// 跟全局时，单连接那几个参数没有意义 —— 清掉，避免「配了却不生效」的隐性不一致
		input.FetchTimeoutSeconds = nil
		input.FetchConcurrency = nil
	}
	if input.FetchConcurrency != nil && *input.FetchConcurrency > 0 {
		max := DefaultRefreshConcurrency * 4
		if *input.FetchConcurrency > max {
			input.FetchConcurrency = &max
		}
	}
	if input.FetchTimeoutSeconds != nil && *input.FetchTimeoutSeconds > 0 {
		max := DefaultRefreshTimeoutSeconds * 4
		if *input.FetchTimeoutSeconds > max {
			input.FetchTimeoutSeconds = &max
		}
	}
	return input, nil
}

func (s *mcpService) CreateServer(ctx context.Context, input MCPServerInput) (model.MCPServer, error) {
	normalized, err := normalizeMCPInput(input)
	if err != nil {
		return model.MCPServer{}, err
	}
	server := model.MCPServer{
		Name:                   normalized.Name,
		Transport:              normalized.Transport,
		URL:                    normalized.URL,
		AuthType:               normalized.AuthType,
		Headers:                normalized.Headers,
		Enabled:                normalized.Enabled,
		Purposes:               normalized.Purposes,
		UseGlobalFetch:         normalized.UseGlobalFetch,
		FetchTimeoutSeconds:    normalized.FetchTimeoutSeconds,
		FetchConcurrency:       normalized.FetchConcurrency,
		RefreshIntervalMinutes: normalized.RefreshIntervalMinutes,
	}
	created, err := s.servers.Create(ctx, server)
	if err != nil {
		return model.MCPServer{}, err
	}
	logger.Info("mcp server created", "module", "service", "action", "create", "resource", "mcp_server", "result", "ok",
		"mcp_server_id", created.ID, "transport", created.Transport, "host", network.ExtractHost(created.URL))
	return MaskMCPServer(created), nil
}

func (s *mcpService) UpdateServer(ctx context.Context, id int64, input MCPServerInput) (model.MCPServer, error) {
	existing, err := s.servers.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.MCPServer{}, ErrMCPNotFound
		}
		return model.MCPServer{}, err
	}
	// 掩码值 = 用户没改这一项：沿用库里的真值（否则一次编辑就把凭据清空了）
	for key, value := range input.Headers {
		if IsMaskedMCPValue(value) {
			if old, ok := existing.Headers[key]; ok {
				input.Headers[key] = old
			} else {
				delete(input.Headers, key)
			}
		}
	}
	if input.AuthType != "" && input.AuthType != model.MCPAuthHeader {
		input.Headers = nil
	}
	normalized, err := normalizeMCPInput(input)
	if err != nil {
		return model.MCPServer{}, err
	}
	existing.Name = normalized.Name
	existing.Transport = normalized.Transport
	existing.URL = normalized.URL
	existing.AuthType = normalized.AuthType
	existing.Headers = normalized.Headers
	existing.Enabled = normalized.Enabled
	existing.Purposes = normalized.Purposes
	existing.UseGlobalFetch = normalized.UseGlobalFetch
	existing.FetchTimeoutSeconds = normalized.FetchTimeoutSeconds
	existing.FetchConcurrency = normalized.FetchConcurrency
	existing.RefreshIntervalMinutes = normalized.RefreshIntervalMinutes

	updated, err := s.servers.Update(ctx, existing)
	if err != nil {
		return model.MCPServer{}, err
	}
	logger.Info("mcp server updated", "module", "service", "action", "update", "resource", "mcp_server", "result", "ok", "mcp_server_id", updated.ID)
	return MaskMCPServer(updated), nil
}

func (s *mcpService) DeleteServer(ctx context.Context, id int64) error {
	used, err := s.servers.CountFeedsUsing(ctx, id)
	if err != nil {
		return err
	}
	if used > 0 {
		return fmt.Errorf("%w: 还有 %d 条订阅在用这个连接，先删订阅再来", ErrMCPInUse, used)
	}
	return s.servers.Delete(ctx, id)
}

// timeoutFor 取数超时：UseGlobalFetch = true 时用设置里的全局值；
// 单独配了（false）就用连接自己的值 —— 单独配了就不走全局（16-7 已拍板）。
func (s *mcpService) timeoutFor(ctx context.Context, server model.MCPServer) time.Duration {
	if !server.UseGlobalFetch {
		if server.FetchTimeoutSeconds != nil && *server.FetchTimeoutSeconds > 0 {
			return time.Duration(*server.FetchTimeoutSeconds) * time.Second
		}
		// 单独配但没填超时：用全局超时兜底，仍然不占用全局并发闸门
	}
	timeout := DefaultRefreshTimeoutSeconds * time.Second
	if s.settings != nil {
		if fs, err := s.settings.GetFetchSettings(ctx); err == nil && fs != nil && fs.TimeoutSeconds > 0 {
			timeout = time.Duration(fs.TimeoutSeconds) * time.Second
		}
	}
	return timeout
}

// newClient 建一个已握手的会话。出网一律走 network.ClientFactory（继承代理设置），
// 绝不自己 http.Get。
func (s *mcpService) newClient(ctx context.Context, server model.MCPServer) (*mcp.Client, error) {
	if !server.Enabled {
		return nil, ErrMCPDisabled
	}
	if server.Transport != model.MCPTransportStreamableHTTP {
		return nil, fmt.Errorf("%w: %s", ErrMCPUnsupported, server.Transport)
	}
	httpClient := s.clientFactory.NewHTTPClient(ctx, s.timeoutFor(ctx, server))
	client := mcp.NewClient(httpClient, server.URL, server.Headers)
	if _, err := client.Initialize(ctx); err != nil {
		return nil, err
	}
	return client, nil
}

// markStatus 回写连接状态（成功清 last_error，失败写原因）—— 失败必须可见。
func (s *mcpService) markStatus(ctx context.Context, server model.MCPServer, connectErr error, toolCount, resourceCount int) {
	var message *string
	connected := connectErr == nil
	if connectErr != nil {
		text := connectErr.Error()
		message = &text
	}
	if err := s.servers.UpdateStatus(ctx, server.ID, connected, message, toolCount, resourceCount); err != nil {
		logger.Warn("update mcp status failed", "module", "service", "action", "update", "resource", "mcp_server", "result", "failed", "mcp_server_id", server.ID, "error", err)
	}
}

func (s *mcpService) TestServer(ctx context.Context, id int64) (MCPTestResult, error) {
	server, err := s.servers.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MCPTestResult{}, ErrMCPNotFound
		}
		return MCPTestResult{}, err
	}

	result := MCPTestResult{}
	client, connectErr := s.newClient(ctx, server)
	if connectErr != nil {
		s.markStatus(ctx, server, connectErr, 0, 0)
		logger.Warn("mcp test failed", "module", "service", "action", "test", "resource", "mcp_server", "result", "failed",
			"mcp_server_id", server.ID, "host", network.ExtractHost(server.URL), "error", connectErr)
		return result, connectErr
	}
	info := client.ServerInfo()
	result.Connected = true
	result.ServerName = info.Name()
	result.ServerVersion = info.ServerInfo.Version

	// 工具与资源清单：任一项不支持（-32601 之类）不算失败 —— 自建 MCP 常见只实现一半。
	if tools, err := client.ListTools(ctx); err == nil {
		result.ToolCount = len(tools)
	} else {
		logger.Debug("mcp list tools failed", "module", "service", "action", "list", "resource", "mcp_tool", "result", "failed", "mcp_server_id", server.ID, "error", err)
	}
	if resources, err := client.ListResources(ctx); err == nil {
		result.ResourceCount = len(resources)
	} else {
		logger.Debug("mcp list resources failed", "module", "service", "action", "list", "resource", "mcp_resource", "result", "failed", "mcp_server_id", server.ID, "error", err)
	}

	s.markStatus(ctx, server, nil, result.ToolCount, result.ResourceCount)
	_ = s.servers.TouchLastUsed(ctx, server.ID)
	return result, nil
}

func (s *mcpService) ListTools(ctx context.Context, id int64) (MCPToolListResult, error) {
	server, err := s.servers.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MCPToolListResult{}, ErrMCPNotFound
		}
		return MCPToolListResult{}, err
	}
	client, err := s.newClient(ctx, server)
	if err != nil {
		s.markStatus(ctx, server, err, 0, 0)
		return MCPToolListResult{}, err
	}

	out := MCPToolListResult{Tools: []MCPToolItem{}, Resources: []MCPResourceItem{}}
	if tools, listErr := client.ListTools(ctx); listErr == nil {
		for _, tool := range tools {
			out.Tools = append(out.Tools, MCPToolItem{
				Name:         tool.Name,
				Title:        tool.Title,
				Description:  tool.Description,
				InputSchema:  tool.InputSchema,
				OutputSchema: tool.OutputSchema,
			})
		}
	} else {
		logger.Debug("mcp list tools failed", "module", "service", "action", "list", "resource", "mcp_tool", "result", "failed", "mcp_server_id", server.ID, "error", listErr)
	}
	if resources, listErr := client.ListResources(ctx); listErr == nil {
		for _, resource := range resources {
			out.Resources = append(out.Resources, MCPResourceItem{
				URI:         resource.URI,
				Name:        resource.Name,
				Description: resource.Description,
				MimeType:    resource.MimeType,
			})
		}
	}
	s.markStatus(ctx, server, nil, len(out.Tools), len(out.Resources))
	return out, nil
}

// Inspect 干跑一次调用（不落库）：返回档位 + 自动推断/用户指定的映射 + 前 5 条预览。
func (s *mcpService) Inspect(ctx context.Context, id int64, req MCPInspectRequest) (MCPInspectResult, error) {
	server, err := s.servers.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MCPInspectResult{}, ErrMCPNotFound
		}
		return MCPInspectResult{}, err
	}
	client, err := s.newClient(ctx, server)
	if err != nil {
		s.markStatus(ctx, server, err, 0, 0)
		return MCPInspectResult{}, err
	}

	result, callErr := s.inspectWithClient(ctx, client, req)
	// 计数沿用这条连接上一次测试的结果：取数不该把工具数刷成 0（那是「测试连接」的产出）
	if callErr != nil {
		// 映射/取数失败也写回连接状态：界面上要看得见原因
		s.markStatus(ctx, server, callErr, server.ToolCount, server.ResourceCount)
		return result, callErr
	}
	_ = s.servers.TouchLastUsed(ctx, server.ID)
	s.markStatus(ctx, server, nil, server.ToolCount, server.ResourceCount)
	return result, nil
}

// InspectTool 建源向导的干跑（不带连接 id 的临时连接场景也走这一份实现）。
func (s *mcpService) inspectWithClient(ctx context.Context, client *mcp.Client, req MCPInspectRequest) (MCPInspectResult, error) {
	limit := req.Limit
	if limit <= 0 {
		limit = MCPPreviewLimit
	}
	result := MCPInspectResult{Notes: []string{}}

	payload, inference, err := s.samplePayload(ctx, client, req)
	if err != nil {
		result.Error = err.Error()
		return result, err
	}
	result.Tier = inference.Tier
	result.Mapping = inference.Mapping
	result.Notes = append(result.Notes, inference.Notes...)

	// 用户手改过的映射优先（可手改 = 拿改后的再看一遍预览）
	if req.Mapping != nil && !req.Mapping.Empty() {
		result.Mapping = *req.Mapping
		if req.Tier != "" {
			result.Tier = req.Tier
		}
	}
	if result.Tier == "" {
		result.Tier = inference.Tier
	}

	items, buildErr := mcp.BuildItems(payload, result.Tier, result.Mapping)
	if buildErr != nil {
		result.Error = buildErr.Error()
		return result, buildErr
	}
	result.Total = len(items)
	if len(items) > limit {
		result.Truncated = true
		items = items[:limit]
	}
	for _, item := range items {
		preview := MCPPreviewItem{
			Title:       item.Title,
			URL:         item.URL,
			Content:     item.Content,
			PublishedAt: item.PublishedAt,
			Author:      item.Author,
			Key:         item.Key,
			KeyLevel:    item.KeyLevel,
		}
		if len(preview.Content) > 400 {
			preview.Content = preview.Content[:400] + "…"
		}
		result.Preview = append(result.Preview, preview)
		if result.KeyLevel == "" {
			result.KeyLevel = item.KeyLevel
		}
	}
	return result, nil
}

// samplePayload 取一次原始返回，并给出「自动推断的映射」。
func (s *mcpService) samplePayload(ctx context.Context, client *mcp.Client, req MCPInspectRequest) (any, mcp.Inference, error) {
	if strings.TrimSpace(req.ToolName) == "" && strings.TrimSpace(req.ResourceURI) == "" {
		return nil, mcp.Inference{}, fmt.Errorf("%w: 要先选一个工具或资源", ErrMCPInvalid)
	}

	if req.Kind == "resource" {
		contents, err := client.ReadResource(ctx, req.ResourceURI)
		if err != nil {
			return nil, mcp.Inference{}, err
		}
		if len(contents.Contents) == 0 {
			return nil, mcp.Inference{}, fmt.Errorf("资源 %s 没有内容", req.ResourceURI)
		}
		text := contents.Contents[0].Text
		var payload any
		if err := json.Unmarshal([]byte(text), &payload); err == nil {
			return payload, mcp.Inference{Tier: model.MCPTierStructured, Mapping: inferMappingFromPayload(payload), Notes: []string{"资源内容是 JSON"}}, nil
		}
		inf, err := mcp.InferFromResourceContents(contents.Contents)
		if err != nil {
			return nil, inf, err
		}
		return text, inf, nil
	}

	args := req.Arguments
	if args == nil {
		args = map[string]any{}
	}
	if req.Limit > 0 {
		if _, ok := args["limit"]; !ok {
			args["limit"] = req.Limit
		}
	}
	result, err := client.CallTool(ctx, req.ToolName, args)
	if err != nil {
		return nil, mcp.Inference{}, err
	}
	outputSchema := s.outputSchemaFor(ctx, client, req.ToolName)
	inference, err := mcp.InferFromToolResult(result, outputSchema)
	if err != nil {
		return nil, inference, err
	}
	payload, err := payloadFromToolResult(result)
	if err != nil {
		return nil, inference, err
	}
	return payload, inference, nil
}

// outputSchemaFor 从 tools/list 里取该工具声明的 outputSchema（有它就能零人工生成映射）。
func (s *mcpService) outputSchemaFor(ctx context.Context, client *mcp.Client, toolName string) json.RawMessage {
	tools, err := client.ListTools(ctx)
	if err != nil {
		return nil
	}
	for _, tool := range tools {
		if tool.Name == toolName {
			return tool.OutputSchema
		}
	}
	return nil
}

// inferMappingFromPayload 供资源 JSON 分支复用「按字段名预填」。
func inferMappingFromPayload(payload any) model.MCPFieldMapping {
	inf, err := mcp.InferFromToolResult(mcp.CallToolResult{
		StructuredContent: mustJSON(payload),
	}, nil)
	if err != nil {
		return model.MCPFieldMapping{}
	}
	return inf.Mapping
}

func mustJSON(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return raw
}

// payloadFromToolResult 把工具结果转成「可映射的 JSON」：
// 优先 structuredContent；否则把 text 当 JSON 解析；再否则用纯文本。
func payloadFromToolResult(result mcp.CallToolResult) (any, error) {
	if len(result.StructuredContent) > 0 {
		var payload any
		if err := json.Unmarshal(result.StructuredContent, &payload); err != nil {
			return nil, fmt.Errorf("解析 structuredContent 失败: %w", err)
		}
		return payload, nil
	}
	text := ""
	for _, content := range result.Content {
		if content.Type == "text" && strings.TrimSpace(content.Text) != "" {
			text = content.Text
			break
		}
	}
	if strings.TrimSpace(text) != "" {
		var payload any
		if err := json.Unmarshal([]byte(text), &payload); err == nil {
			return payload, nil
		}
		return text, nil
	}

	// 第 ① 档：工具直接返回 resource / resource_link（没有文本）——规范化成可映射的列表
	if items, ok := mcp.ResourceContentsToItems(result.Content); ok {
		list := make([]any, 0, len(items))
		for _, item := range items {
			list = append(list, item)
		}
		return list, nil
	}

	return nil, fmt.Errorf("工具返回里没有结构化内容，也没有文本内容")
}

// FetchFeedItems 抓一次：按订阅里的 mcp_config 走工具或资源，产出条目。
// 失败一律返回错误（调用方写进该源的 last_error）—— 不许静默出空条目。
func (s *mcpService) FetchFeedItems(ctx context.Context, feed model.Feed) (MCPFetchResult, error) {
	config, err := ParseMCPFeedConfig(feed.MCPConfig)
	if err != nil {
		return MCPFetchResult{}, err
	}
	if config.ServerID.Int64() == 0 {
		return MCPFetchResult{}, fmt.Errorf("%w: 订阅里没有指定 MCP 连接", ErrMCPInvalid)
	}
	server, err := s.servers.GetByID(ctx, config.ServerID.Int64())
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MCPFetchResult{}, fmt.Errorf("%w: 连接已不存在（id=%d）", ErrMCPNotFound, config.ServerID.Int64())
		}
		return MCPFetchResult{}, err
	}
	client, err := s.newClient(ctx, server)
	if err != nil {
		s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
		return MCPFetchResult{}, err
	}

	req := MCPInspectRequest{
		Kind:        config.Kind,
		ToolName:    config.ToolName,
		ResourceURI: config.ResourceURI,
		Arguments:   config.Arguments,
		Limit:       config.Limit,
	}
	payload, inference, err := s.samplePayload(ctx, client, req)
	if err != nil {
		s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
		return MCPFetchResult{}, err
	}

	tier := config.Tier
	mapping := config.Mapping
	if mapping.Empty() {
		tier = inference.Tier
		mapping = inference.Mapping
	}
	if tier == "" {
		tier = inference.Tier
	}
	items, err := mcp.BuildItems(payload, tier, mapping)
	if err != nil {
		s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
		return MCPFetchResult{}, err
	}

	out := MCPFetchResult{Items: make([]*gofeed.Item, 0, len(items)), Tier: tier}
	for _, item := range items {
		out.Items = append(out.Items, toGofeedItem(server.ID, item))
		if out.KeyLevel == "" {
			out.KeyLevel = item.KeyLevel
		}
	}
	_ = s.servers.TouchLastUsed(ctx, server.ID)
	s.markStatus(ctx, server, nil, server.ToolCount, server.ResourceCount)
	return out, nil
}

// toGofeedItem 把候选条目变成 gofeed.Item —— 这样就能原样喂给既有的 saveEntries()。
// GUID = 去重键（computeEntryHash 的第一级就是 GUID，于是 MCP 的去重顺序与 RSS 完全一致：
// 键字段 → 链接 → 标题+时间）。
func toGofeedItem(serverID int64, item mcp.Item) *gofeed.Item {
	link := strings.TrimSpace(item.URL)
	if link == "" {
		// 没有链接字段时给一个稳定的内部地址：既保证条目能入库（saveEntries 会跳过空 URL 的条目），
		// 又保证重复取回不会重复入库（地址由去重键派生）。
		link = fmt.Sprintf("mcp://server/%d/%s", serverID, hashutil.SHA256Hex(item.Key)[:16])
	}
	gofeedItem := &gofeed.Item{
		Title:       strings.TrimSpace(item.Title),
		Link:        link,
		Description: item.Content,
		GUID:        strings.TrimSpace(item.Key),
	}
	if author := strings.TrimSpace(item.Author); author != "" {
		gofeedItem.Author = &gofeed.Person{Name: author}
	}
	if published, ok := mcp.ParseTime(item.PublishedAt); ok {
		t := published
		gofeedItem.Published = published.Format(time.RFC3339)
		gofeedItem.PublishedParsed = &t
	}
	return gofeedItem
}

// ParseMCPFeedConfig 解析 feeds.mcp_config（空 / 坏 JSON 都明确报错，不静默）。
func ParseMCPFeedConfig(raw *string) (model.MCPFeedConfig, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return model.MCPFeedConfig{}, fmt.Errorf("%w: 这条 MCP 订阅没有配置（mcp_config 为空）", ErrMCPInvalid)
	}
	var config model.MCPFeedConfig
	if err := json.Unmarshal([]byte(*raw), &config); err != nil {
		return model.MCPFeedConfig{}, fmt.Errorf("%w: mcp_config 不是合法 JSON: %v", ErrMCPInvalid, err)
	}
	return config, nil
}

// BuildMCPFeedConfig 建源时把入参规整成落库的那份 JSON。
func BuildMCPFeedConfig(config model.MCPFeedConfig) (string, error) {
	if config.ServerID.Int64() == 0 {
		return "", fmt.Errorf("%w: 没选 MCP 连接", ErrMCPInvalid)
	}
	if config.Kind == "" {
		config.Kind = "tool"
	}
	if config.Kind != "tool" && config.Kind != "resource" {
		return "", fmt.Errorf("%w: kind 只能是 tool / resource", ErrMCPInvalid)
	}
	if config.Kind == "tool" && strings.TrimSpace(config.ToolName) == "" {
		return "", fmt.Errorf("%w: 没选工具", ErrMCPInvalid)
	}
	if config.Kind == "resource" && strings.TrimSpace(config.ResourceURI) == "" {
		return "", fmt.Errorf("%w: 没选资源", ErrMCPInvalid)
	}
	if config.Limit <= 0 || config.Limit > 200 {
		config.Limit = 20
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("序列化 mcp_config 失败: %w", err)
	}
	return string(raw), nil
}

// MCPFeedURL MCP 订阅的「地址」：feeds.url 是 NOT NULL UNIQUE，MCP 源没有真的 URL，
// 用 mcp://<连接>/<工具或资源>?args=<参数指纹> 表示 —— 同参同源会被判成重复订阅（与 RSS 一致）。
func MCPFeedURL(config model.MCPFeedConfig) string {
	name := config.ToolName
	if config.Kind == "resource" {
		name = config.ResourceURI
	}
	base := fmt.Sprintf("mcp://%d/%s/%s", config.ServerID.Int64(), config.Kind, name)
	if len(config.Arguments) == 0 {
		return base
	}
	keys := make([]string, 0, len(config.Arguments))
	for key := range config.Arguments {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", key, config.Arguments[key]))
	}
	return base + "?args=" + hashutil.SHA256Hex(strings.Join(parts, "&"))[:8]
}
