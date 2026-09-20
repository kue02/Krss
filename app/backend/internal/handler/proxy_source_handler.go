package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"

	"krss/backend/internal/model"
	"krss/backend/internal/service"
	"krss/backend/pkg/logger"
)

// 代理按来源生效（用户 14 批 · 迁移 26）的接口层。
//
// PATCH /api/feeds/:id/proxy 与 PATCH /api/folders/:id/proxy 复用这里的请求体解析，
// GET /api/proxy/sources 给设置页「按来源覆盖」段与管理面板用。

// proxyOverrideRequest 订阅/文件夹共用的覆盖入参。
//
// Mode："inherit"（跟随上级）/ "proxy"（走代理）/ "direct"（直连）。不带该字段 = 不改这一步。
// Config 用 RawMessage 是为了区分「没带」（不动）与「带 null」（清掉单独指定那套）。
type proxyOverrideRequest struct {
	Mode   *string         `json:"mode"`
	Config json.RawMessage `json:"config"`
}

// parseProxyOverrideUpdate 把请求体归一化成 service.ProxyOverrideUpdate；不合法时返回错误（400）。
func parseProxyOverrideUpdate(req proxyOverrideRequest) (service.ProxyOverrideUpdate, error) {
	update := service.ProxyOverrideUpdate{}

	if req.Mode != nil {
		mode, ok := service.ProxyModeFromString(*req.Mode)
		if !ok {
			return update, errors.New("mode must be inherit, proxy or direct")
		}
		update.SetMode = true
		update.Mode = mode
	}

	if len(req.Config) > 0 {
		update.SetConfig = true
		trimmed := strings.TrimSpace(string(req.Config))
		if trimmed == "null" || trimmed == "" {
			update.Config = nil
			return update, nil
		}
		var cfg model.ProxyOverrideConfig
		if err := json.Unmarshal(req.Config, &cfg); err != nil {
			return update, errors.New("invalid proxy config")
		}
		if err := validateProxyConfig(&cfg); err != nil {
			return update, err
		}
		update.Config = &cfg
	}

	return update, nil
}

// validateProxyConfig 单独指定那套代理的校验（只校验形状，不试连通性 —— 试连通性有测试按钮）。
func validateProxyConfig(cfg *model.ProxyOverrideConfig) error {
	cfg.Type = strings.TrimSpace(cfg.Type)
	if cfg.Type == "" {
		cfg.Type = "http"
	}
	if cfg.Type != "http" && cfg.Type != "socks5" {
		return errors.New("proxy type must be http or socks5")
	}
	cfg.Host = strings.TrimSpace(cfg.Host)
	if cfg.Host == "" {
		return errors.New("proxy host is required")
	}
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return errors.New("proxy port must be between 1 and 65535")
	}
	return nil
}

// toProxyConfigResponse 返回前端的配置：密码一律掩码（订阅级/文件夹级也不许原样回）。
func toProxyConfigResponse(cfg *model.ProxyOverrideConfig) *model.ProxyOverrideConfig {
	return service.MaskedProxyConfig(cfg)
}

// ProxySourceHandler GET /api/proxy/sources
type ProxySourceHandler struct {
	sources service.ProxySourceService
}

func NewProxySourceHandler(sources service.ProxySourceService) *ProxySourceHandler {
	return &ProxySourceHandler{sources: sources}
}

func (h *ProxySourceHandler) RegisterRoutes(g *echo.Group) {
	g.GET("/proxy/sources", h.List)
}

// List 一览：全局一份 + 所有文件夹 + 所有订阅（都带「实际生效结果」）+ 计数。
// @Summary List proxy sources
// @Description 代理按来源生效的一览：全局配置（密码掩码）+ 文件夹/订阅各自的覆盖与生效结果 + 计数
// @Tags proxy
// @Produce json
// @Success 200 {object} service.ProxySourceOverview
// @Failure 500 {object} errorResponse
// @Router /proxy/sources [get]
func (h *ProxySourceHandler) List(c echo.Context) error {
	overview, err := h.sources.Overview(c.Request().Context())
	if err != nil {
		logger.Error("proxy sources list failed", "module", "handler", "action", "list", "resource", "proxy", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to list proxy sources"})
	}
	return c.JSON(http.StatusOK, overview)
}
