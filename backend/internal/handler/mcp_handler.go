package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"

	"krss/backend/internal/model"
	"krss/backend/internal/service"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/network"
)

// MCPHandler 16 批（入向）连接管理 + 17 批（出向）状态/令牌。
type MCPHandler struct {
	service  service.MCPService
	outbound service.MCPOutboundService
}

func NewMCPHandler(mcpService service.MCPService, outbound service.MCPOutboundService) *MCPHandler {
	return &MCPHandler{service: mcpService, outbound: outbound}
}

func (h *MCPHandler) RegisterRoutes(g *echo.Group) {
	// 入向：连接管理（AI 设置栏 → MCP 服务）
	g.GET("/mcp/servers", h.ListServers)
	g.POST("/mcp/servers", h.CreateServer)
	g.PATCH("/mcp/servers/:id", h.UpdateServer)
	g.DELETE("/mcp/servers/:id", h.DeleteServer)
	g.POST("/mcp/servers/:id/test", h.TestServer)
	g.POST("/mcp/servers/:id/redetect", h.RedetectTransport)
	g.POST("/mcp/servers/:id/tools", h.ListTools)
	g.POST("/mcp/servers/:id/inspect", h.Inspect)
	g.POST("/mcp/servers/:id/suggest-mapping", h.SuggestMapping)

	// 入向：OAuth（16-11）。start/discovery 走 JWT；callback 例外，见 RegisterPublicRoutes。
	g.POST("/mcp/servers/:id/oauth/discovery", h.OAuthDiscovery)
	g.POST("/mcp/servers/:id/oauth/start", h.OAuthStart)
	g.POST("/mcp/servers/:id/oauth/revoke", h.OAuthRevoke)

	// 出向：Krss 作为 MCP 服务器（设置 → 数据控制）
	g.GET("/mcp/outbound", h.OutboundStatus)
	g.PUT("/mcp/outbound", h.UpdateOutbound)
	g.POST("/mcp/outbound/token", h.GenerateOutboundToken)
	g.DELETE("/mcp/outbound/token", h.RevokeOutboundToken)
}

// RegisterPublicRoutes 挂在根路由上（不走 JWT）：OAuth 回调。
// 浏览器从授权服务器跳回来时带不了 JWT，安全靠 state（256 位随机、单次有效、10 分钟过期）。
func (h *MCPHandler) RegisterPublicRoutes(e *echo.Echo) {
	e.GET("/api/mcp/oauth/callback", h.OAuthCallback)
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

type mcpServerRequest struct {
	Name        string            `json:"name" binding:"required"`
	Transport   string            `json:"transport"`
	URL         string            `json:"url" binding:"required"`
	AuthType    string            `json:"authType"`
	Headers     map[string]string `json:"headers"`
	Enabled     *bool             `json:"enabled"`
	Purposes    []string          `json:"purposes"`
	UseGlobalFe *bool             `json:"useGlobalFetch"`
	// 单连接取数参数（useGlobalFetch=false 时生效；单独配了就不走全局）
	FetchTimeoutSeconds    *int `json:"fetchTimeoutSeconds"`
	FetchConcurrency       *int `json:"fetchConcurrency"`
	RefreshIntervalMinutes *int `json:"refreshIntervalMinutes"`
	// OAuth 手填凭证（16-11：不支持 DCR 的服务用；secret 传掩码 = 没改）
	OAuthClientID     string `json:"oauthClientId"`
	OAuthClientSecret string `json:"oauthClientSecret"`
}

type mcpServerResponse struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Transport     string            `json:"transport"`
	URL           string            `json:"url"`
	AuthType      string            `json:"authType"`
	Headers       map[string]string `json:"headers,omitempty"`
	Enabled       bool              `json:"enabled"`
	IsConnected   bool              `json:"isConnected"`
	LastError     *string           `json:"lastError,omitempty"`
	ToolCount     int               `json:"toolCount"`
	ResourceCount int               `json:"resourceCount"`
	Purposes      []string          `json:"purposes"`
	UseGlobalFetch         bool  `json:"useGlobalFetch"`
	FetchTimeoutSeconds    *int  `json:"fetchTimeoutSeconds,omitempty"`
	FetchConcurrency       *int  `json:"fetchConcurrency,omitempty"`
	RefreshIntervalMinutes *int  `json:"refreshIntervalMinutes,omitempty"`
	// LastTransport 上次成功的传输（transport='auto' 时下次优先试它 —— 16-10）
	LastTransport string `json:"lastTransport,omitempty"`
	// OAuth 状态（16-11：secret/token 只出掩码，真值永不出接口）
	OAuthClientID     string  `json:"oauthClientId,omitempty"`
	OAuthClientSecret string  `json:"oauthClientSecret,omitempty"`
	OAuthAuthorized   bool    `json:"oauthAuthorized"`
	OAuthExpiresAt    *string `json:"oauthExpiresAt,omitempty"`
	OAuthAuthServer   string  `json:"oauthAuthServer,omitempty"`
	// LastFailure 结构化失败（16-12：列表行/测试/预览三处共用）
	LastFailure  *model.MCPFailure `json:"lastFailure,omitempty"`
	LastUsedAt   *string           `json:"lastUsedAt,omitempty"`
	CreatedAt    string            `json:"createdAt"`
	UpdatedAt    string            `json:"updatedAt"`
}

type mcpInspectRequest struct {
	Kind        string                `json:"kind"`
	ToolName    string                `json:"toolName"`
	ResourceURI string                `json:"resourceUri"`
	Arguments   map[string]any        `json:"arguments"`
	Limit       int                   `json:"limit"`
	Mapping     *model.MCPFieldMapping `json:"mapping"`
	Tier        string                `json:"tier"`
}

type mcpOutboundOptionsRequest struct {
	Enabled      bool   `json:"enabled"`
	WriteEnabled bool   `json:"writeEnabled"`
	// BaseURL 对外访问地址（用户填的公网/局域网可达 origin；空字符串 = 清掉）。
	BaseURL string `json:"baseUrl"`
}

func toMCPServerResponse(server model.MCPServer) mcpServerResponse {
	response := mcpServerResponse{
		ID:                     strconv.FormatInt(server.ID, 10),
		Name:                   server.Name,
		Transport:              server.Transport,
		URL:                    server.URL,
		AuthType:               server.AuthType,
		Headers:                server.Headers,
		Enabled:                server.Enabled,
		IsConnected:            server.IsConnected,
		LastError:              server.LastError,
		ToolCount:              server.ToolCount,
		ResourceCount:          server.ResourceCount,
		Purposes:               server.Purposes,
		UseGlobalFetch:         server.UseGlobalFetch,
		FetchTimeoutSeconds:    server.FetchTimeoutSeconds,
		FetchConcurrency:       server.FetchConcurrency,
		RefreshIntervalMinutes: server.RefreshIntervalMinutes,
		LastTransport:          server.LastTransport,
		OAuthClientID:          server.OAuthClientID,
		OAuthClientSecret:      server.OAuthClientSecret,
		OAuthAuthorized:        server.OAuthAuthorized(),
		OAuthAuthServer:        server.OAuthAuthServer,
		CreatedAt:              server.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:              server.UpdatedAt.UTC().Format(time.RFC3339),
	}
	if server.OAuthExpiresAt != nil {
		value := server.OAuthExpiresAt.UTC().Format(time.RFC3339)
		response.OAuthExpiresAt = &value
	}
	if server.LastFailure != nil && strings.TrimSpace(*server.LastFailure) != "" {
		var failure model.MCPFailure
		if err := json.Unmarshal([]byte(*server.LastFailure), &failure); err == nil && failure.Bucket != "" {
			response.LastFailure = &failure
		}
	}
	if server.LastUsedAt != nil {
		value := server.LastUsedAt.UTC().Format(time.RFC3339)
		response.LastUsedAt = &value
	}
	return response
}

// writeMCPError MCP 这一类错误必须给可见原因（「只支持 streamable-http」「还有 N 条订阅在用」），
// 不能落成一句 internal error；其余仍走项目的统一映射。
func writeMCPError(c echo.Context, err error) error {
	switch {
	case errors.Is(err, service.ErrMCPInvalid),
		errors.Is(err, service.ErrMCPUnsupported),
		errors.Is(err, service.ErrMCPDisabled):
		return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
	case errors.Is(err, service.ErrMCPNotFound):
		return c.JSON(http.StatusNotFound, errorResponse{Error: err.Error()})
	case errors.Is(err, service.ErrMCPInUse):
		return c.JSON(http.StatusConflict, errorResponse{Error: err.Error()})
	default:
		return writeServiceError(c, err)
	}
}

func mcpInputFromRequest(req mcpServerRequest) service.MCPServerInput {
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	useGlobal := true
	if req.UseGlobalFe != nil {
		useGlobal = *req.UseGlobalFe
	}
	return service.MCPServerInput{
		Name:                   strings.TrimSpace(req.Name),
		Transport:              strings.TrimSpace(req.Transport),
		URL:                    strings.TrimSpace(req.URL),
		AuthType:               strings.TrimSpace(req.AuthType),
		Headers:                req.Headers,
		Enabled:                enabled,
		Purposes:               req.Purposes,
		UseGlobalFetch:         useGlobal,
		FetchTimeoutSeconds:    req.FetchTimeoutSeconds,
		FetchConcurrency:       req.FetchConcurrency,
		RefreshIntervalMinutes: req.RefreshIntervalMinutes,
		OAuthClientID:          strings.TrimSpace(req.OAuthClientID),
		OAuthClientSecret:      req.OAuthClientSecret,
	}
}

// ---------------------------------------------------------------------------
// 入向：连接管理
// ---------------------------------------------------------------------------

// ListServers 列出 MCP 连接（Header 值一律掩码）。
// @Summary List MCP servers
// @Tags mcp
// @Produce json
// @Success 200 {array} mcpServerResponse
// @Router /mcp/servers [get]
func (h *MCPHandler) ListServers(c echo.Context) error {
	servers, err := h.service.ListServers(c.Request().Context())
	if err != nil {
		logger.Error("mcp list servers failed", "module", "handler", "action", "list", "resource", "mcp_server", "result", "failed", "error", err)
		return writeMCPError(c, err)
	}
	response := make([]mcpServerResponse, 0, len(servers))
	for _, server := range servers {
		response = append(response, toMCPServerResponse(server))
	}
	return c.JSON(http.StatusOK, response)
}

// CreateServer 新建 MCP 连接。
// @Summary Create a MCP server
// @Tags mcp
// @Accept json
// @Produce json
// @Param server body mcpServerRequest true "MCP server"
// @Success 201 {object} mcpServerResponse
// @Failure 400 {object} errorResponse
// @Router /mcp/servers [post]
func (h *MCPHandler) CreateServer(c echo.Context) error {
	var req mcpServerRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	created, err := h.service.CreateServer(c.Request().Context(), mcpInputFromRequest(req))
	if err != nil {
		return writeMCPError(c, err)
	}
	logger.Info("mcp server created", "module", "handler", "action", "create", "resource", "mcp_server", "result", "ok",
		"mcp_server_id", created.ID, "host", network.ExtractHost(created.URL))
	return c.JSON(http.StatusCreated, toMCPServerResponse(created))
}

// UpdateServer 编辑 MCP 连接（Header 传掩码值 = 不改动该项）。
// @Summary Update a MCP server
// @Tags mcp
// @Accept json
// @Produce json
// @Param id path int true "MCP server ID"
// @Param server body mcpServerRequest true "MCP server"
// @Success 200 {object} mcpServerResponse
// @Router /mcp/servers/{id} [patch]
func (h *MCPHandler) UpdateServer(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
	}
	var req mcpServerRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	updated, err := h.service.UpdateServer(c.Request().Context(), id, mcpInputFromRequest(req))
	if err != nil {
		return writeMCPError(c, err)
	}
	logger.Info("mcp server updated", "module", "handler", "action", "update", "resource", "mcp_server", "result", "ok", "mcp_server_id", id)
	return c.JSON(http.StatusOK, toMCPServerResponse(updated))
}

// DeleteServer 删除 MCP 连接（还有订阅在用会被拒绝）。
// @Summary Delete a MCP server
// @Tags mcp
// @Param id path int true "MCP server ID"
// @Success 204
// @Router /mcp/servers/{id} [delete]
func (h *MCPHandler) DeleteServer(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
	}
	if err := h.service.DeleteServer(c.Request().Context(), id); err != nil {
		return writeMCPError(c, err)
	}
	logger.Info("mcp server deleted", "module", "handler", "action", "delete", "resource", "mcp_server", "result", "ok", "mcp_server_id", id)
	return c.NoContent(http.StatusNoContent)
}

// TestServer 连通性测试（回工具/资源计数）。
// @Summary Test a MCP server
// @Tags mcp
// @Produce json
// @Param id path int true "MCP server ID"
// @Success 200 {object} service.MCPTestResult
// @Router /mcp/servers/{id}/test [post]
func (h *MCPHandler) TestServer(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
	}
	result, err := h.service.TestServer(c.Request().Context(), id)
	if err != nil {
		// 连通性失败是「这条连接的 last_error」，用 200 + connected=false 回给界面，
		// 免得前端把「源连不上」当成请求出错（与代理测试同一口径）。
		// 16-12：同时带结构化失败（三处共用文案）。
		logger.Warn("mcp server test failed", "module", "handler", "action", "test", "resource", "mcp_server", "result", "failed", "mcp_server_id", id, "error", err)
		result.Error = err.Error()
		return c.JSON(http.StatusOK, result)
	}
	return c.JSON(http.StatusOK, result)
}

// RedetectTransport 重新探测传输（16-10：忘掉上次成功的再测一次）。
// @Summary Redetect transport of a MCP server
// @Tags mcp
// @Produce json
// @Param id path int true "MCP server ID"
// @Success 200 {object} service.MCPTestResult
// @Router /mcp/servers/{id}/redetect [post]
func (h *MCPHandler) RedetectTransport(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
	}
	result, err := h.service.RedetectTransport(c.Request().Context(), id)
	if err != nil {
		logger.Warn("mcp redetect failed", "module", "handler", "action", "redetect", "resource", "mcp_server", "result", "failed", "mcp_server_id", id, "error", err)
		result.Error = err.Error()
		return c.JSON(http.StatusOK, result)
	}
	return c.JSON(http.StatusOK, result)
}

// ListTools 拉工具 + 资源清单（建源向导第二步）。
// @Summary List tools of a MCP server
// @Tags mcp
// @Produce json
// @Param id path int true "MCP server ID"
// @Success 200 {object} service.MCPToolListResult
// @Router /mcp/servers/{id}/tools [post]
func (h *MCPHandler) ListTools(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
	}
	result, err := h.service.ListTools(c.Request().Context(), id)
	if err != nil {
		logger.Warn("mcp list tools failed", "module", "handler", "action", "list", "resource", "mcp_tool", "result", "failed", "mcp_server_id", id, "error", err)
		return writeMCPError(c, err)
	}
	return c.JSON(http.StatusOK, result)
}

// Inspect 干跑一次调用：预览前 5 条 + 自动推断映射（建源向导第三步，强制步骤）。
// @Summary Inspect a MCP server (dry run + preview)
// @Tags mcp
// @Accept json
// @Produce json
// @Param id path int true "MCP server ID"
// @Param req body mcpInspectRequest true "Inspect request"
// @Success 200 {object} service.MCPInspectResult
// @Router /mcp/servers/{id}/inspect [post]
func (h *MCPHandler) Inspect(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
	}
	var req mcpInspectRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	result, err := h.service.Inspect(c.Request().Context(), id, service.MCPInspectRequest{
		Kind:        strings.TrimSpace(req.Kind),
		ToolName:    strings.TrimSpace(req.ToolName),
		ResourceURI: strings.TrimSpace(req.ResourceURI),
		Arguments:   req.Arguments,
		Limit:       req.Limit,
		Mapping:     req.Mapping,
		Tier:        req.Tier,
	})
	if err != nil {
		// 干跑失败要带原因回界面（映射失败必须当场看见），所以 200 + error 字段
		logger.Warn("mcp inspect failed", "module", "handler", "action", "inspect", "resource", "mcp_server", "result", "failed", "mcp_server_id", id, "error", err)
		result.Error = err.Error()
		return c.JSON(http.StatusOK, result)
	}
	return c.JSON(http.StatusOK, result)
}

type mcpSuggestRequest struct {
	Kind        string         `json:"kind"`
	ToolName    string         `json:"toolName"`
	ResourceURI string         `json:"resourceUri"`
	Arguments   map[string]any `json:"arguments"`
	Limit       int            `json:"limit"`
}

// SuggestMapping 第 4 档 AI 兜底：调一次 AI 猜映射，只返回不落库（16-3）。
// 预览确认后才落库 —— 落库走建源那条老路，这里不写任何东西。
// @Summary Suggest a mapping with AI
// @Tags mcp
// @Accept json
// @Produce json
// @Param id path int true "MCP server ID"
// @Param req body mcpSuggestRequest true "Suggest request"
// @Success 200 {object} service.MCPSuggestResult
// @Router /mcp/servers/{id}/suggest-mapping [post]
func (h *MCPHandler) SuggestMapping(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
	}
	var req mcpSuggestRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	result, err := h.service.SuggestMapping(c.Request().Context(), id, service.MCPSuggestRequest{
		Kind:        strings.TrimSpace(req.Kind),
		ToolName:    strings.TrimSpace(req.ToolName),
		ResourceURI: strings.TrimSpace(req.ResourceURI),
		Arguments:   req.Arguments,
		Limit:       req.Limit,
	})
	if err != nil {
		return writeMCPError(c, err)
	}
	return c.JSON(http.StatusOK, result)
}

// ---------------------------------------------------------------------------
// OAuth（16-11）
// ---------------------------------------------------------------------------

// OAuthDiscovery 找授权服务器（不写库，纯读；找不到就回 needsManual，界面给手填框）。
// @Summary Discover OAuth authorization server
// @Tags mcp
// @Produce json
// @Param id path int true "MCP server ID"
// @Success 200 {object} service.OAuthDiscoveryResult
// @Router /mcp/servers/{id}/oauth/discovery [post]
func (h *MCPHandler) OAuthDiscovery(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
	}
	result, err := h.service.OAuthDiscovery(c.Request().Context(), id)
	if err != nil {
		return writeMCPError(c, err)
	}
	return c.JSON(http.StatusOK, result)
}

type mcpOAuthStartRequest struct {
	// RedirectURI 回调地址 —— 前端按当前访问 origin 拼（<origin>/api/mcp/oauth/callback），
	// 后端不拼不存，零配置、远程可用。
	RedirectURI  string `json:"redirectUri"`
	Scope        string `json:"scope"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

// OAuthStart 开始一次授权：回浏览器授权地址，前端开浏览器。
// @Summary Start OAuth authorization
// @Tags mcp
// @Accept json
// @Produce json
// @Param id path int true "MCP server ID"
// @Param req body mcpOAuthStartRequest true "OAuth start request"
// @Success 200 {object} service.OAuthStartResult
// @Router /mcp/servers/{id}/oauth/start [post]
func (h *MCPHandler) OAuthStart(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
	}
	var req mcpOAuthStartRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	result, err := h.service.OAuthStart(c.Request().Context(), id, req.RedirectURI, req.Scope, req.ClientID, req.ClientSecret)
	if err != nil {
		return writeMCPError(c, err)
	}
	return c.JSON(http.StatusOK, result)
}

// OAuthCallback 授权回调（公开路由，见 RegisterPublicRoutes）：换 token 进库，回成功页。
// @Summary OAuth callback
// @Tags mcp
// @Param code query string true "Authorization code"
// @Param state query string true "State"
// @Success 200 {string} string "HTML result page"
// @Router /mcp/oauth/callback [get]
func (h *MCPHandler) OAuthCallback(c echo.Context) error {
	code := strings.TrimSpace(c.QueryParam("code"))
	state := strings.TrimSpace(c.QueryParam("state"))
	oauthErr := strings.TrimSpace(c.QueryParam("error"))
	if oauthErr != "" {
		return c.HTML(http.StatusOK, oauthCallbackPage(false, "授权被拒绝（"+oauthErr+"）"))
	}
	_, err := h.service.OAuthCallback(c.Request().Context(), state, code)
	if err != nil {
		logger.Warn("mcp oauth callback failed", "module", "handler", "action", "oauth_callback", "resource", "mcp_server", "result", "failed", "error", err)
		return c.HTML(http.StatusOK, oauthCallbackPage(false, err.Error()))
	}
	return c.HTML(http.StatusOK, oauthCallbackPage(true, ""))
}

// oauthCallbackPage 回调结果页（不含任何秘密，关掉即可，前端轮询状态）。
func oauthCallbackPage(ok bool, message string) string {
	title := "MCP 授权成功"
	desc := "可以关掉这一页，回到 Krss 里点「测试连接」验证。"
	if !ok {
		title = "MCP 授权失败"
		desc = message + " —— 关掉这一页，回到 Krss 重试。"
	}
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>` + title +
		`</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;color:#26262b}div{max-width:420px;text-align:center;line-height:1.7}h1{font-size:18px}</style></head><body><div><h1>` +
		title + `</h1><p>` + desc + `</p></div></body></html>`
}

// OAuthRevoke 撤销授权（清 token 与 secret）。
// @Summary Revoke OAuth authorization
// @Tags mcp
// @Param id path int true "MCP server ID"
// @Success 204
// @Router /mcp/servers/{id}/oauth/revoke [post]
func (h *MCPHandler) OAuthRevoke(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
	}
	if err := h.service.OAuthRevoke(c.Request().Context(), id); err != nil {
		return writeMCPError(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// 出向：状态 / 令牌
// ---------------------------------------------------------------------------

// OutboundStatus 出向状态。
// @Summary MCP outbound status
// @Tags mcp
// @Produce json
// @Success 200 {object} service.MCPOutboundStatus
// @Router /mcp/outbound [get]
func (h *MCPHandler) OutboundStatus(c echo.Context) error {
	status, err := h.outbound.Status(c.Request().Context())
	if err != nil {
		return writeMCPError(c, err)
	}
	return c.JSON(http.StatusOK, status)
}

// UpdateOutbound 开关出向（默认只读；写操作需显式开启）。
// @Summary Update MCP outbound options
// @Tags mcp
// @Accept json
// @Produce json
// @Param req body mcpOutboundOptionsRequest true "Options"
// @Success 200 {object} service.MCPOutboundStatus
// @Router /mcp/outbound [put]
func (h *MCPHandler) UpdateOutbound(c echo.Context) error {
	var req mcpOutboundOptionsRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	status, err := h.outbound.UpdateOptions(c.Request().Context(), req.Enabled, req.WriteEnabled, req.BaseURL)
	if err != nil {
		return writeMCPError(c, err)
	}
	logger.Info("mcp outbound options updated", "module", "handler", "action", "update", "resource", "mcp_outbound", "result", "ok",
		"enabled", req.Enabled, "write_enabled", req.WriteEnabled, "base_url_set", req.BaseURL != "")
	return c.JSON(http.StatusOK, status)
}

type mcpTokenResponse struct {
	service.MCPOutboundStatus
	// Token 只在生成这一刻返回一次（库里只存哈希）。
	Token string `json:"token,omitempty"`
}

// GenerateOutboundToken 生成长期 token（明文只显示一次）。
// @Summary Generate MCP outbound token
// @Tags mcp
// @Produce json
// @Success 200 {object} mcpTokenResponse
// @Router /mcp/outbound/token [post]
func (h *MCPHandler) GenerateOutboundToken(c echo.Context) error {
	status, token, err := h.outbound.GenerateToken(c.Request().Context())
	if err != nil {
		return writeMCPError(c, err)
	}
	logger.Info("mcp outbound token generated", "module", "handler", "action", "create", "resource", "mcp_token", "result", "ok")
	return c.JSON(http.StatusOK, mcpTokenResponse{MCPOutboundStatus: status, Token: token})
}

// RevokeOutboundToken 撤销 token。
// @Summary Revoke MCP outbound token
// @Tags mcp
// @Success 204
// @Router /mcp/outbound/token [delete]
func (h *MCPHandler) RevokeOutboundToken(c echo.Context) error {
	if err := h.outbound.RevokeToken(c.Request().Context()); err != nil {
		return writeMCPError(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}
