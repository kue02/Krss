package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"

	"gist/backend/internal/service"
	"gist/backend/pkg/logger"
)

// MCPEndpointHandler 17 批（出向）：Krss 作为 MCP 服务器。
// 传输：streamable-http，端点 /mcp（与既有 API 同源，复用 echo 路由）。
// 鉴权：长期 token（Bearer），库里只存哈希 —— 不复用登录 JWT（那是短期的，B3 已拍板）。
type MCPEndpointHandler struct {
	outbound service.MCPOutboundService
}

func NewMCPEndpointHandler(outbound service.MCPOutboundService) *MCPEndpointHandler {
	return &MCPEndpointHandler{outbound: outbound}
}

// RegisterRoutes 注册在根路由上（不在 /api 组里 —— 那组要 JWT，MCP 客户端只带长期 token）。
func (h *MCPEndpointHandler) RegisterRoutes(e *echo.Echo) {
	e.POST("/mcp", h.Handle)
	e.GET("/mcp", h.RejectStream)
	e.DELETE("/mcp", h.DeleteSession)
}

// Handle 处理一条（或一批）JSON-RPC 请求。
func (h *MCPEndpointHandler) Handle(c echo.Context) error {
	if !h.authorize(c) {
		return c.JSON(http.StatusUnauthorized, service.MCPRPCResponse{
			JSONRPC: "2.0",
			Error: &service.MCPRPCError{
				Code:    -32000,
				Message: "unauthorized：请在 krss 的设置 → 数据控制 → MCP 服务器里生成长期 token，并放进 Authorization: Bearer <token>",
			},
		})
	}

	ctx := c.Request().Context()
	body, err := io.ReadAll(io.LimitReader(c.Request().Body, 4<<20))
	if err != nil {
		return c.JSON(http.StatusBadRequest, rpcParseError())
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return c.JSON(http.StatusBadRequest, rpcParseError())
	}

	// 会话 id：streamable-http 允许无状态。给一个不透明 id 让客户端下次带上（我们不做服务端状态）。
	sessionID := strings.TrimSpace(c.Request().Header.Get("Mcp-Session-Id"))
	if sessionID == "" {
		sessionID = service.NewMCPSessionID()
		c.Response().Header().Set("Mcp-Session-Id", sessionID)
	}

	// 批量请求（JSON 数组）：逐个处理，通知不回响应。
	if trimmed[0] == '[' {
		var requests []service.MCPRPCRequest
		if err := json.Unmarshal(trimmed, &requests); err != nil {
			return c.JSON(http.StatusBadRequest, rpcParseError())
		}
		responses := make([]service.MCPRPCResponse, 0, len(requests))
		for _, request := range requests {
			response, respond := h.outbound.Dispatch(ctx, request)
			if respond {
				responses = append(responses, response)
			}
		}
		if len(responses) == 0 {
			return c.NoContent(http.StatusAccepted)
		}
		return c.JSON(http.StatusOK, responses)
	}

	var request service.MCPRPCRequest
	if err := json.Unmarshal(trimmed, &request); err != nil {
		return c.JSON(http.StatusBadRequest, rpcParseError())
	}
	response, respond := h.outbound.Dispatch(ctx, request)
	if !respond {
		// 通知（notifications/*）：规范要求 202 Accepted + 空体
		return c.NoContent(http.StatusAccepted)
	}
	logger.Debug("mcp outbound call", "module", "handler", "action", "request", "resource", "mcp_outbound", "result", "ok", "method", request.Method)
	return c.JSON(http.StatusOK, response)
}

// RejectStream 规范的 GET（服务端主动推流）我们不支持：回 405 让客户端走 POST。
func (h *MCPEndpointHandler) RejectStream(c echo.Context) error {
	if !h.authorize(c) {
		return c.JSON(http.StatusUnauthorized, service.MCPRPCResponse{
			JSONRPC: "2.0",
			Error:   &service.MCPRPCError{Code: -32000, Message: "unauthorized"},
		})
	}
	c.Response().Header().Set("Allow", "POST, DELETE")
	return c.JSON(http.StatusMethodNotAllowed, service.MCPRPCResponse{
		JSONRPC: "2.0",
		Error:   &service.MCPRPCError{Code: service.MCPErrInvalidRequest, Message: "本服务器不提供 SSE 流，请用 POST"},
	})
}

// DeleteSession 规范里的会话终止（我们无状态，直接 204）。
func (h *MCPEndpointHandler) DeleteSession(c echo.Context) error {
	if !h.authorize(c) {
		return c.NoContent(http.StatusUnauthorized)
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *MCPEndpointHandler) authorize(c echo.Context) bool {
	header := strings.TrimSpace(c.Request().Header.Get("Authorization"))
	token := ""
	if len(header) > 7 && strings.EqualFold(header[:7], "bearer ") {
		token = strings.TrimSpace(header[7:])
	} else if header != "" && !strings.Contains(header, " ") {
		// 有些客户端直接放裸 token（不标准但常见）——照样接受
		token = header
	}
	if token == "" {
		// 也接受 X-Api-Key（部分客户端习惯）
		token = strings.TrimSpace(c.Request().Header.Get("X-Api-Key"))
	}
	authorized := h.outbound.Authorize(c.Request().Context(), token)
	if !authorized {
		logger.Warn("mcp outbound unauthorized", "module", "handler", "action", "request", "resource", "mcp_outbound", "result", "failed")
	}
	return authorized
}

func rpcParseError() service.MCPRPCResponse {
	return service.MCPRPCResponse{
		JSONRPC: "2.0",
		Error:   &service.MCPRPCError{Code: service.MCPErrParse, Message: "请求体不是合法 JSON"},
	}
}
