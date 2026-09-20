//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/mmcdole/gofeed"

	"krss/backend/internal/hashutil"
	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/internal/service/mcp"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/network"
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
	// OAuthClientID / OAuthClientSecret 手填的客户端凭证（不支持 DCR 的服务用 —— 16-11）。
	// 传掩码 = 没改（与 Header 同一口径）。
	OAuthClientID     string
	OAuthClientSecret string
}

// MCPTestResult 连通性测试结果（回服务名/版本/工具与资源计数）。
type MCPTestResult struct {
	Connected     bool               `json:"connected"`
	ServerName    string             `json:"serverName,omitempty"`
	ServerVersion string             `json:"serverVersion,omitempty"`
	ToolCount     int                `json:"toolCount"`
	ResourceCount int                `json:"resourceCount"`
	Error         string             `json:"error,omitempty"`
	// Failure 结构化失败（16-12：三处共用；成功时为 nil）。
	Failure *model.MCPFailure `json:"failure,omitempty"`
	// Transport 这次实际用的传输；LatencyMs 握手耗时毫秒。
	Transport string `json:"transport,omitempty"`
	LatencyMs int64  `json:"latencyMs,omitempty"`
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
	// Failure 结构化失败（16-12：向导预览与测试按钮共用同一套文案）。
	Failure *model.MCPFailure `json:"failure,omitempty"`
	// NextCursor 第一页之后还有页时回传（向导「拉更多」把游标塞进 arguments 再 inspect）。
	NextCursor string `json:"nextCursor,omitempty"`
	// CursorParam 游标参数名（inputSchema 里自动找到的；前端「拉更多」往这个参数填）。
	CursorParam string `json:"cursorParam,omitempty"`
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
	// RedetectTransport 重新探测传输（清掉记住的上次成功项，再测一次 —— 16-10）。
	RedetectTransport(ctx context.Context, id int64) (MCPTestResult, error)
	ListTools(ctx context.Context, id int64) (MCPToolListResult, error)
	// Inspect 干跑一次调用并预览前 5 条 + 自动推断映射（不写库、不落条目）。
	Inspect(ctx context.Context, id int64, req MCPInspectRequest) (MCPInspectResult, error)
	// SuggestMapping 第 4 档 AI 兜底：调一次 AI 猜映射，只返回不落库（16-3）。
	SuggestMapping(ctx context.Context, id int64, req MCPSuggestRequest) (MCPSuggestResult, error)
	// OAuthDiscovery / OAuthStart / OAuthCallback / OAuthRevoke 见 mcp_oauth.go（16-11）。
	OAuthDiscovery(ctx context.Context, id int64) (OAuthDiscoveryResult, error)
	OAuthStart(ctx context.Context, id int64, redirectURI, scope, clientID, clientSecret string) (OAuthStartResult, error)
	OAuthCallback(ctx context.Context, state, code string) (model.MCPServer, error)
	OAuthRevoke(ctx context.Context, id int64) error
	// FetchFeedItems 按该订阅的映射抓一次，产出可直接进 saveEntries 的条目。
	FetchFeedItems(ctx context.Context, feed model.Feed) (MCPFetchResult, error)
}

type mcpService struct {
	servers       repository.MCPServerRepository
	settings      SettingsService
	clientFactory *network.ClientFactory
	// ai 第 4 档兜底用（16-3）。nil = 没配 AI，SuggestMapping 明确报错。
	ai AIService
}

func NewMCPService(servers repository.MCPServerRepository, settings SettingsService, clientFactory *network.ClientFactory, ai AIService) MCPService {
	return &mcpService{servers: servers, settings: settings, clientFactory: clientFactory, ai: ai}
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

// MaskMCPServer 出接口前把敏感值打成掩码（凭据只存在于库里与出网那一刻）。
// Header 值 / client_secret / token 一律掩码；client_id 与 token 指纹可出（界面要显示状态）。
func MaskMCPServer(server model.MCPServer) model.MCPServer {
	if len(server.Headers) > 0 {
		masked := make(map[string]string, len(server.Headers))
		for key := range server.Headers {
			masked[key] = MCPMaskedValue
		}
		server.Headers = masked
	}
	if server.OAuthClientSecret != "" {
		server.OAuthClientSecret = MCPMaskedValue
	}
	if server.OAuthAccessToken != "" {
		server.OAuthAccessToken = MCPMaskedValue
	}
	if server.OAuthRefreshToken != "" {
		server.OAuthRefreshToken = MCPMaskedValue
	}
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
		input.Transport = model.MCPTransportAuto
	}
	switch input.Transport {
	case model.MCPTransportAuto, model.MCPTransportStreamableHTTP, model.MCPTransportSSE:
	default:
		return input, fmt.Errorf("%w: 传输只能是 auto / streamable-http / sse", ErrMCPInvalid)
	}
	if input.AuthType == "" {
		input.AuthType = model.MCPAuthNone
	}
	if input.AuthType != model.MCPAuthNone && input.AuthType != model.MCPAuthHeader && input.AuthType != model.MCPAuthOAuth {
		return input, fmt.Errorf("%w: 认证只能是 none / header / oauth", ErrMCPInvalid)
	}
	if input.AuthType == model.MCPAuthNone {
		input.Headers = nil
	}
	if input.AuthType != model.MCPAuthOAuth {
		input.OAuthClientID = ""
		input.OAuthClientSecret = ""
	}
	input.OAuthClientID = strings.TrimSpace(input.OAuthClientID)
	// client_secret 传掩码 = 没改（与 Header 同一口径）—— 但新建时掩码没有意义，直接清掉
	if IsMaskedMCPValue(input.OAuthClientSecret) {
		input.OAuthClientSecret = ""
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
		OAuthClientID:          normalized.OAuthClientID,
		OAuthClientSecret:      normalized.OAuthClientSecret,
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
	// client_secret 传掩码 = 没改（与 Header 同一口径）：先换回真值再进 normalize
	if IsMaskedMCPValue(input.OAuthClientSecret) {
		input.OAuthClientSecret = existing.OAuthClientSecret
	}
	if strings.TrimSpace(input.OAuthClientID) == "" && input.AuthType == model.MCPAuthOAuth {
		input.OAuthClientID = existing.OAuthClientID
	}
	normalized, err := normalizeMCPInput(input)
	if err != nil {
		return model.MCPServer{}, err
	}
	// 认证方式切走 oauth → 旧 token 作废（不清掉会留着一把开不了的钥匙）
	oauthKept := existing.OAuthAccessToken
	oauthRefreshKept := existing.OAuthRefreshToken
	oauthExpiresKept := existing.OAuthExpiresAt
	if normalized.AuthType != model.MCPAuthOAuth {
		oauthKept, oauthRefreshKept, oauthExpiresKept = "", "", nil
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
	existing.OAuthClientID = normalized.OAuthClientID
	existing.OAuthClientSecret = normalized.OAuthClientSecret
	existing.OAuthAccessToken = oauthKept
	existing.OAuthRefreshToken = oauthRefreshKept
	existing.OAuthExpiresAt = oauthExpiresKept

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
//
// 传输（16-10）：显式指定就只试那一种；auto 则按「上次成功的 → streamable-http → sse」
// 试，传输选错味的失败（404/405/非 MCP 响应/空响应）才换下一种试，其他失败直接回。
// 成功后把这次用的传输记下来（SetLastTransport），下次优先试它。
// 调用方必须 defer client.Close()（SSE 流要关）。
func (s *mcpService) newClient(ctx context.Context, server model.MCPServer) (*mcp.Client, error) {
	if !server.Enabled {
		return nil, ErrMCPDisabled
	}
	headers, err := s.oauthHeaders(ctx, server)
	if err != nil {
		return nil, err
	}
	candidates := transportCandidates(server)
	var lastErr error
	for _, transport := range candidates {
		client, err := dialTransport(ctx, s, server, headers, transport)
		if err == nil {
			if server.LastTransport != transport {
				_ = s.servers.SetLastTransport(ctx, server.ID, transport)
			}
			return client, nil
		}
		lastErr = err
		if !isTransportMismatch(err) || transport == candidates[len(candidates)-1] {
			return nil, err
		}
		// 换下一种传输前，把上一次的流关掉（SSE 的 GET 长连接不能泄漏）
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("%w: 没有可用的传输", ErrMCPUnsupported)
	}
	return nil, lastErr
}

// transportCandidates 试的顺序：显式一种；auto = 上次成功的 + http + sse（去重）。
func transportCandidates(server model.MCPServer) []string {
	if server.Transport == model.MCPTransportSSE {
		return []string{model.MCPTransportSSE}
	}
	if server.Transport == model.MCPTransportStreamableHTTP {
		return []string{model.MCPTransportStreamableHTTP}
	}
	ordered := []string{}
	if server.LastTransport == model.MCPTransportStreamableHTTP || server.LastTransport == model.MCPTransportSSE {
		ordered = append(ordered, server.LastTransport)
	}
	for _, transport := range []string{model.MCPTransportStreamableHTTP, model.MCPTransportSSE} {
		duplicate := false
		for _, existing := range ordered {
			if existing == transport {
				duplicate = true
				break
			}
		}
		if !duplicate {
			ordered = append(ordered, transport)
		}
	}
	return ordered
}

func dialTransport(ctx context.Context, s *mcpService, server model.MCPServer, headers map[string]string, transport string) (*mcp.Client, error) {
	httpClient := s.clientFactory.NewHTTPClient(ctx, s.timeoutFor(ctx, server))
	client := mcp.NewClientWithTransport(httpClient, server.URL, headers, transport)
	if _, err := client.Initialize(ctx); err != nil {
		client.Close()
		return nil, err
	}
	return client, nil
}

// isTransportMismatch 这错像不像「传输选错了」—— 像才值得换另一种试一次。
// 判据：HTTP 404/405/400（端点不在/方法不对）、协议桶的非 MCP/空响应、SSE 流里没 endpoint。
func isTransportMismatch(err error) bool {
	var httpErr *mcp.HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.StatusCode == http.StatusNotFound ||
			httpErr.StatusCode == http.StatusMethodNotAllowed ||
			httpErr.StatusCode == http.StatusBadRequest
	}
	var oauthErr *oauthFailureError
	if errors.As(err, &oauthErr) {
		return false // 认证问题换传输没用，别试了
	}
	if errors.Is(err, ErrMCPDisabled) || errors.Is(err, ErrMCPUnsupported) {
		return false
	}
	text := strings.ToLower(err.Error())
	for _, hint := range []string{
		"serverinfo", "initialize", "空响应体", "没有找到 json-rpc",
		"不是 sse", "endpoint 事件", "不是合法 json",
	} {
		if strings.Contains(text, hint) {
			return true
		}
	}
	return false
}

// markStatus 回写连接状态（成功清 last_error，失败写原因）—— 失败必须可见。
// 16-12：同时写结构化失败（last_failure JSON，三处共用）；last_error 存人话标题（兼容旧显示）。
func (s *mcpService) markStatus(ctx context.Context, server model.MCPServer, connectErr error, toolCount, resourceCount int) {
	failure := failureOf(connectErr, server.URL)
	var message *string
	if failure != nil {
		message = &failure.Title
	}
	if err := s.servers.UpdateStatus(ctx, server.ID, connectErr == nil, message, toolCount, resourceCount); err != nil {
		logger.Warn("update mcp status failed", "module", "service", "action", "update", "resource", "mcp_server", "result", "failed", "mcp_server_id", server.ID, "error", err)
	}
	// 结构化失败另存一列（best-effort：写不进去不影响主流程）
	var failureJSON *string
	if failure != nil {
		if raw, err := json.Marshal(failure); err == nil {
			text := string(raw)
			failureJSON = &text
		}
	}
	if err := s.servers.SetLastFailure(ctx, server.ID, failureJSON); err != nil {
		logger.Warn("update mcp failure failed", "module", "service", "action", "update", "resource", "mcp_server", "result", "failed", "mcp_server_id", server.ID, "error", err)
	}
}

// failureOf 把 error 收成结构化失败（nil → nil）。OAuth 预检错误自带失败体，直接用。
func failureOf(err error, endpoint string) *model.MCPFailure {
	if err == nil {
		return nil
	}
	var oauthErr *oauthFailureError
	if errors.As(err, &oauthErr) {
		return &oauthErr.failure
	}
	failure := mcp.Classify(err, endpoint)
	return &failure
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
	start := time.Now()
	client, connectErr := s.newClient(ctx, server)
	if connectErr != nil {
		result.Failure = failureOf(connectErr, server.URL)
		result.Error = connectErr.Error()
		s.markStatus(ctx, server, connectErr, 0, 0)
		logger.Warn("mcp test failed", "module", "service", "action", "test", "resource", "mcp_server", "result", "failed",
			"mcp_server_id", server.ID, "host", network.ExtractHost(server.URL), "error", connectErr)
		return result, connectErr
	}
	defer client.Close()
	result.LatencyMs = time.Since(start).Milliseconds()
	result.Transport = client.Transport()
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

// RedetectTransport 重新探测传输（16-10）：忘掉上次成功的，下次 auto 从头试。
func (s *mcpService) RedetectTransport(ctx context.Context, id int64) (MCPTestResult, error) {
	server, err := s.servers.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MCPTestResult{}, ErrMCPNotFound
		}
		return MCPTestResult{}, err
	}
	_ = s.servers.SetLastTransport(ctx, id, "")
	server.LastTransport = ""
	return s.TestServer(ctx, id)
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
	defer client.Close()

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
		return MCPInspectResult{Notes: []string{}, Failure: failureOf(err, server.URL), Error: err.Error()}, err
	}
	defer client.Close()

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

	// 用户手改过的映射优先（可手改 = 拿改后的再看一遍预览）
	var userMapping *model.MCPFieldMapping
	var userTier string
	if req.Mapping != nil && !req.Mapping.Empty() {
		userMapping = req.Mapping
		userTier = req.Tier
	}

	if req.Kind == "tool" && strings.TrimSpace(req.ToolName) != "" {
		return s.inspectToolPage(ctx, client, req, limit, userMapping, userTier)
	}

	payload, inference, err := s.samplePayload(ctx, client, req)
	if err != nil {
		result.Error = err.Error()
		result.Failure = failureOf(err, "")
		return result, err
	}
	built, buildErr := buildInspectResult(payload, inference, limit, userMapping, userTier)
	if buildErr != nil {
		return built, buildErr
	}
	return built, nil
}

// inspectToolPage 工具干跑：只取第一页（预览前 5 条），同时把 nextCursor / cursorParam
// 回传 —— 向导「拉更多」把游标塞进 arguments 再调一次 inspect。
func (s *mcpService) inspectToolPage(ctx context.Context, client *mcp.Client, req MCPInspectRequest, limit int, userMapping *model.MCPFieldMapping, userTier string) (MCPInspectResult, error) {
	result := MCPInspectResult{Notes: []string{}}
	schema := s.outputSchemaFor(ctx, client, req.ToolName)
	inputSchema := s.inputSchemaFor(ctx, client, req.ToolName)
	pages, cursorParam, next, pageErr := s.pagedToolCall(ctx, client, req.ToolName, req.Arguments, limit, &model.MCPPagination{Mode: model.MCPPaginationSingle}, inputSchema)
	result.CursorParam = cursorParam
	result.NextCursor = next
	if pageErr != nil {
		result.Error = pageErr.Error()
		result.Failure = failureOf(pageErr, "")
		return result, pageErr
	}
	if len(pages) == 0 {
		err := fmt.Errorf("工具 %s 没有返回内容", req.ToolName)
		result.Error = err.Error()
		result.Failure = failureOf(err, "")
		return result, err
	}
	inference, err := mcp.InferFromToolResult(pages[0], schema)
	if err != nil {
		result.Error = err.Error()
		result.Failure = failureOf(err, "")
		return result, err
	}
	payload, err := payloadFromToolResult(pages[0])
	if err != nil {
		result.Error = err.Error()
		result.Failure = failureOf(err, "")
		return result, err
	}
	built, buildErr := buildInspectResult(payload, inference, limit, userMapping, userTier)
	if buildErr != nil {
		return built, buildErr
	}
	// 游标是这一页取数时带出来的，build 只管映射 → 在这里合上
	built.CursorParam = result.CursorParam
	built.NextCursor = result.NextCursor
	return built, nil
}

// buildInspectResult 档位 + 映射（用户改过的优先）→ 建条目 → 截前 N 条预览。
func buildInspectResult(payload any, inference mcp.Inference, limit int, userMapping *model.MCPFieldMapping, userTier string) (MCPInspectResult, error) {
	result := MCPInspectResult{Notes: []string{}}
	result.Tier = inference.Tier
	result.Mapping = inference.Mapping
	result.Notes = append(result.Notes, inference.Notes...)
	if userMapping != nil {
		result.Mapping = *userMapping
		if userTier != "" {
			result.Tier = userTier
		}
	}
	if result.Tier == "" {
		result.Tier = inference.Tier
	}
	items, buildErr := mcp.BuildItems(payload, result.Tier, result.Mapping)
	if buildErr != nil {
		result.Error = buildErr.Error()
		result.Failure = failureOf(buildErr, "")
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

// inputSchemaFor 从 tools/list 里取该工具的 inputSchema（猜游标参数名用 —— 16-8）。
func (s *mcpService) inputSchemaFor(ctx context.Context, client *mcp.Client, toolName string) json.RawMessage {
	tools, err := client.ListTools(ctx)
	if err != nil {
		return nil
	}
	for _, tool := range tools {
		if tool.Name == toolName {
			return tool.InputSchema
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
	defer client.Close()

	req := MCPInspectRequest{
		Kind:        config.Kind,
		ToolName:    config.ToolName,
		ResourceURI: config.ResourceURI,
		Arguments:   config.Arguments,
		Limit:       config.Limit,
	}

	tier := config.Tier
	mapping := config.Mapping
	keyLevel := config.KeyLevel
	var items []mcp.Item

	if config.Kind == "resource" {
		payload, inference, err := s.samplePayload(ctx, client, req)
		if err != nil {
			s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
			return MCPFetchResult{}, err
		}
		if mapping.Empty() {
			tier = inference.Tier
			mapping = inference.Mapping
		}
		if tier == "" {
			tier = inference.Tier
		}
		built, err := mcp.BuildItems(payload, tier, mapping)
		if err != nil {
			s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
			return MCPFetchResult{}, err
		}
		items = built
	} else {
		// 工具：单次调用内 cursor 循环（16-8）。默认 single 只取一页。
		limit := config.Limit
		if limit <= 0 {
			limit = 20
		}
		schema := s.outputSchemaFor(ctx, client, config.ToolName)
		inputSchema := s.inputSchemaFor(ctx, client, config.ToolName)
		pages, _, _ /*游标只在 inspect「拉更多」用，刷新循环内部消化*/, fetchErr := s.pagedToolCall(ctx, client, config.ToolName, config.Arguments, limit, config.Pagination, inputSchema)
		if fetchErr != nil {
			s.markStatus(ctx, server, fetchErr, server.ToolCount, server.ResourceCount)
			return MCPFetchResult{}, fetchErr
		}
		if len(pages) == 0 {
			err := fmt.Errorf("工具 %s 没有返回内容", config.ToolName)
			s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
			return MCPFetchResult{}, err
		}
		_, maxPages, maxItems := config.Pagination.Effective()
		_ = maxPages // 上限在 pagedToolCall 里已经执行，这里只截条数
		for pageIndex, page := range pages {
			payload, err := payloadFromToolResult(page)
			if err != nil {
				if pageIndex == 0 {
					s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
					return MCPFetchResult{}, err
				}
				break // 后面页坏了不推翻前面已拿到的
			}
			if pageIndex == 0 && mapping.Empty() {
				inference, err := mcp.InferFromToolResult(page, schema)
				if err != nil {
					s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
					return MCPFetchResult{}, err
				}
				tier = inference.Tier
				mapping = inference.Mapping
			}
			if tier == "" {
				tier = config.Tier
			}
			built, err := mcp.BuildItems(payload, tier, mapping)
			if err != nil {
				if pageIndex == 0 {
					s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
					return MCPFetchResult{}, err
				}
				break
			}
			items = append(items, built...)
			if len(items) >= maxItems {
				items = items[:maxItems]
				break
			}
		}
	}

	out := MCPFetchResult{Items: make([]*gofeed.Item, 0, len(items)), Tier: tier}
	for _, item := range items {
		out.Items = append(out.Items, toGofeedItem(server.ID, item))
		if out.KeyLevel == "" {
			out.KeyLevel = item.KeyLevel
		}
	}
	if out.KeyLevel == "" {
		out.KeyLevel = keyLevel
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
	// 分页（16-8）：只认 single / history；双上限钳住（页 1~20、条 1~2000），缺省 3 页 / 200 条。
	if config.Pagination != nil {
		if config.Pagination.Mode != model.MCPPaginationHistory {
			config.Pagination.Mode = model.MCPPaginationSingle
		}
		if config.Pagination.MaxPages <= 0 || config.Pagination.MaxPages > 20 {
			config.Pagination.MaxPages = model.MCPPaginationDefaultMaxPages
		}
		if config.Pagination.MaxItems <= 0 || config.Pagination.MaxItems > 2000 {
			config.Pagination.MaxItems = model.MCPPaginationDefaultMaxItems
		}
		config.Pagination.CursorParam = strings.TrimSpace(config.Pagination.CursorParam)
		config.Pagination.CursorPath = strings.TrimSpace(config.Pagination.CursorPath)
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
