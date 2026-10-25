//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package handler

import (
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"

	"krss/backend/internal/plugin"
	"krss/backend/internal/service"
	"krss/backend/pkg/logger"
)

// PluginHandler 插件管理：清单 / 启停 / 插件设置 / 动作测试。
type PluginHandler struct {
	service service.PluginService
}

func NewPluginHandler(svc service.PluginService) *PluginHandler {
	return &PluginHandler{service: svc}
}

func (h *PluginHandler) RegisterRoutes(g *echo.Group) {
	// 固定段必须排在 /plugins/:id 之前（照 filter_handler.go 的 /filters/parse 先例；
	// echo 虽以静态优先，固定段靠前是本项目的明规则）
	g.POST("/plugins/rescan", h.Rescan)
	g.GET("/plugins", h.List)
	g.PATCH("/plugins/:id", h.SetEnabled)
	g.GET("/plugins/:id/settings", h.GetSettings)
	g.PUT("/plugins/:id/settings", h.PutSettings)
	g.POST("/plugins/:id/actions/:actionId/test", h.TestAction)
}

type pluginCatalogResponse struct {
	Plugins []pluginCatalogItem `json:"plugins"`
}

type pluginCatalogItem struct {
	ID          string                   `json:"id"`
	Name        string                   `json:"name"`
	Description string                   `json:"description"`
	Version     string                   `json:"version"`
	Builtin     bool                     `json:"builtin"`
	Enabled     bool                     `json:"enabled"`
	Actions     []plugin.ActionMeta      `json:"actions"`
	Sections    []plugin.SettingsSection `json:"sections"`
}

type pluginSettingsResponse struct {
	Values map[string]string `json:"values"`
}

type pluginSettingsRequest struct {
	Values map[string]string `json:"values"`
}

type pluginEnabledRequest struct {
	Enabled bool `json:"enabled"`
}

// List godoc
// @Summary 插件清单（含各插件声明的动作与设置段）
// @Tags plugins
// @Produce json
// @Success 200 {object} pluginCatalogResponse
// @Router /api/plugins [get]
func (h *PluginHandler) List(c echo.Context) error {
	items, err := h.service.Catalog(c.Request().Context())
	if err != nil {
		logger.Error("plugin catalog failed", "module", "handler", "action", "list", "resource", "plugin", "result", "failed", "error", err)
		return writeServiceError(c, err)
	}
	resp := pluginCatalogResponse{Plugins: make([]pluginCatalogItem, 0, len(items))}
	for _, item := range items {
		resp.Plugins = append(resp.Plugins, pluginCatalogItem{
			ID:          item.ID,
			Name:        item.Name,
			Description: item.Description,
			Version:     item.Version,
			Builtin:     item.Builtin,
			Enabled:     item.Enabled,
			Actions:     item.Actions,
			Sections:    item.Sections,
		})
	}
	return c.JSON(http.StatusOK, resp)
}

// SetEnabled godoc
// @Summary 启用 / 停用一个插件
// @Tags plugins
// @Accept json
// @Produce json
// @Param id path string true "插件 id"
// @Param body body pluginEnabledRequest true "启停"
// @Success 200 {object} pluginCatalogResponse
// @Router /api/plugins/{id} [patch]
func (h *PluginHandler) SetEnabled(c echo.Context) error {
	var req pluginEnabledRequest
	if err := c.Bind(&req); err != nil {
		return writeServiceError(c, err)
	}
	items, err := h.service.SetEnabled(c.Request().Context(), c.Param("id"), req.Enabled)
	if err != nil {
		logger.Error("plugin set enabled failed", "module", "handler", "action", "update", "resource", "plugin", "result", "failed", "id", c.Param("id"), "error", err)
		return writeServiceError(c, err)
	}
	resp := pluginCatalogResponse{Plugins: make([]pluginCatalogItem, 0, len(items))}
	for _, item := range items {
		resp.Plugins = append(resp.Plugins, pluginCatalogItem{
			ID:          item.ID,
			Name:        item.Name,
			Description: item.Description,
			Version:     item.Version,
			Builtin:     item.Builtin,
			Enabled:     item.Enabled,
			Actions:     item.Actions,
			Sections:    item.Sections,
		})
	}
	return c.JSON(http.StatusOK, resp)
}

// GetSettings godoc
// @Summary 读插件设置（secret 字段掩码）
// @Tags plugins
// @Produce json
// @Success 200 {object} pluginSettingsResponse
// @Router /api/plugins/{id}/settings [get]
func (h *PluginHandler) GetSettings(c echo.Context) error {
	result, err := h.service.GetSettings(c.Request().Context(), c.Param("id"))
	if err != nil {
		return writeServiceError(c, err)
	}
	if result.Values == nil {
		result.Values = map[string]string{}
	}
	return c.JSON(http.StatusOK, pluginSettingsResponse{Values: result.Values})
}

// PutSettings godoc
// @Summary 写插件设置（值为掩码 = 保持原值）
// @Tags plugins
// @Accept json
// @Produce json
// @Success 200 {object} pluginSettingsResponse
// @Router /api/plugins/{id}/settings [put]
func (h *PluginHandler) PutSettings(c echo.Context) error {
	var req pluginSettingsRequest
	if err := c.Bind(&req); err != nil {
		return writeServiceError(c, err)
	}
	result, err := h.service.PutSettings(c.Request().Context(), c.Param("id"), req.Values)
	if err != nil {
		return writeServiceError(c, err)
	}
	if result.Values == nil {
		result.Values = map[string]string{}
	}
	return c.JSON(http.StatusOK, pluginSettingsResponse{Values: result.Values})
}

// TestAction godoc
// @Summary 让插件动作自己发一条测试（Bark 发送测试推送）
// @Tags plugins
// @Success 200 {object} map[string]int
// @Router /api/plugins/{id}/actions/{actionId}/test [post]
func (h *PluginHandler) TestAction(c echo.Context) error {
	if err := h.service.TestAction(c.Request().Context(), strings.TrimSpace(c.Param("id")), strings.TrimSpace(c.Param("actionId"))); err != nil {
		logger.Error("plugin action test failed", "module", "handler", "action", "test", "resource", "plugin", "result", "failed", "id", c.Param("id"), "error", err)
		return writeServiceError(c, err)
	}
	return c.JSON(http.StatusOK, map[string]int{"status": http.StatusOK})
}

// Rescan 手动重新扫描插件目录（55-7b：与 List 同一份 Catalog —— ensureExternal 就在 Catalog 链上，
// 所以「重新扫描」= 再拿一次清单；等不及轮询的用户点它）。
func (h *PluginHandler) Rescan(c echo.Context) error {
	items, err := h.service.Catalog(c.Request().Context())
	if err != nil {
		logger.Error("plugin rescan failed", "module", "handler", "action", "rescan", "resource", "plugin", "result", "failed", "error", err)
		return writeServiceError(c, err)
	}
	resp := pluginCatalogResponse{Plugins: make([]pluginCatalogItem, 0, len(items))}
	for _, item := range items {
		resp.Plugins = append(resp.Plugins, pluginCatalogItem{
			ID:          item.ID,
			Name:        item.Name,
			Description: item.Description,
			Version:     item.Version,
			Builtin:     item.Builtin,
			Enabled:     item.Enabled,
			Actions:     item.Actions,
			Sections:    item.Sections,
		})
	}
	return c.JSON(http.StatusOK, resp)
}
