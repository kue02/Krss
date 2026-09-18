package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"

	"gist/backend/internal/model"
	"gist/backend/internal/service"
	"gist/backend/pkg/logger"
	"gist/backend/pkg/network"
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
	g.POST("/mcp/servers/:id/tools", h.ListTools)
	g.POST("/mcp/servers/:id/inspect", h.Inspect)

	// 出向：Krss 作为 MCP 服务器（设置 → 数据控制）
	g.GET("/mcp/outbound", h.OutboundStatus)
	g.PUT("/mcp/outbound", h.UpdateOutbound)
	g.POST("/mcp/outbound/token", h.GenerateOutboundToken)
	g.DELETE("/mcp/outbound/token", h.RevokeOutboundToken)
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
	LastUsedAt             *string `json:"lastUsedAt,omitempty"`
	CreatedAt              string  `json:"createdAt"`
	UpdatedAt              string  `json:"updatedAt"`
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
	Enabled      bool `json:"enabled"`
	WriteEnabled bool `json:"writeEnabled"`
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
		CreatedAt:              server.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:              server.UpdatedAt.UTC().Format(time.RFC3339),
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
		logger.Warn("mcp server test failed", "module", "handler", "action", "test", "resource", "mcp_server", "result", "failed", "mcp_server_id", id, "error", err)
		return c.JSON(http.StatusOK, service.MCPTestResult{Connected: false, Error: err.Error()})
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
	status, err := h.outbound.UpdateOptions(c.Request().Context(), req.Enabled, req.WriteEnabled)
	if err != nil {
		return writeMCPError(c, err)
	}
	logger.Info("mcp outbound options updated", "module", "handler", "action", "update", "resource", "mcp_outbound", "result", "ok",
		"enabled", req.Enabled, "write_enabled", req.WriteEnabled)
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
