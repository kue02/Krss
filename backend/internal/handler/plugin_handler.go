//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package handler

import (
	"errors"
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
	// 清单里的固定段：必须在 /plugins/:id 之前注册
	g.GET("/plugins/contributions", h.ListContributions)
	g.PATCH("/plugins/:id", h.SetEnabled)
	g.GET("/plugins/:id/settings", h.GetSettings)
	g.PUT("/plugins/:id/settings", h.PutSettings)
	g.POST("/plugins/:id/actions/:actionId/test", h.TestAction)
	g.POST("/plugins/:id/actions/:actionId/invoke", h.InvokePluginAction)
}

type pluginCatalogResponse struct {
	Plugins []pluginCatalogItem `json:"plugins"`
}

type pluginCatalogItem struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`
	Builtin     bool   `json:"builtin"`
	// Transport builtin（编译进二进制）| http（外部进程，即装即用）
	Transport string                   `json:"transport"`
	Enabled   bool                     `json:"enabled"`
	Actions   []plugin.ActionMeta      `json:"actions"`
	Sections  []plugin.SettingsSection `json:"sections"`
	// LastError 外部插件最近一次故障（非空 ⇒ UI 显示「已崩溃 / 起不来」）
	LastError string `json:"lastError,omitempty"`
}

// toCatalogItems 清单出参（三条路由共用一份映射，别各写一遍）。
func toCatalogItems(items []plugin.CatalogItem) []pluginCatalogItem {
	out := make([]pluginCatalogItem, 0, len(items))
	for _, item := range items {
		out = append(out, pluginCatalogItem{
			ID:          item.ID,
			Name:        item.Name,
			Description: item.Description,
			Version:     item.Version,
			Builtin:     item.Builtin,
			Transport:   item.Transport,
			Enabled:     item.Enabled,
			Actions:     item.Actions,
			Sections:    item.Sections,
			LastError:   item.LastError,
		})
	}
	return out
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

// pluginContributionsResponse 各 surface 的界面贡献。surfaces 为空时是 {}（handler 负责初始化 map）。
type pluginContributionsResponse struct {
	Surfaces map[plugin.Surface][]plugin.Contribution `json:"surfaces"`
}

// ListContributions godoc
// @Summary 各插入位置（surface）上可用的插件界面项
// @Tags plugins
// @Produce json
// @Success 200 {object} pluginContributionsResponse
// @Router /api/plugins/contributions [get]
func (h *PluginHandler) ListContributions(c echo.Context) error {
	surfaces := h.service.Contributions(c.Request().Context())
	if surfaces == nil {
		surfaces = map[plugin.Surface][]plugin.Contribution{}
	}
	return c.JSON(http.StatusOK, pluginContributionsResponse{Surfaces: surfaces})
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
	return c.JSON(http.StatusOK, pluginCatalogResponse{Plugins: toCatalogItems(items)})
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
	return c.JSON(http.StatusOK, pluginCatalogResponse{Plugins: toCatalogItems(items)})
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
// @Failure 404 {object} errorResponse
// @Failure 409 {object} errorResponse
// @Failure 502 {object} errorResponse "投递失败，error 里是插件给的可见原因（地址已打码）"
// @Router /api/plugins/{id}/actions/{actionId}/test [post]
func (h *PluginHandler) TestAction(c echo.Context) error {
	err := h.service.TestAction(c.Request().Context(), strings.TrimSpace(c.Param("id")), strings.TrimSpace(c.Param("actionId")))
	if err == nil {
		return c.JSON(http.StatusOK, map[string]int{"status": http.StatusOK})
	}
	logger.Error("plugin action test failed", "module", "handler", "action", "test", "resource", "plugin", "result", "failed", "id", c.Param("id"), "error", err)
	// 没有地址 / 动作不可测这类「用户要改配置」的错 → 400；
	// 其余（真出网失败）→ 502 并回插件给的原因，与旧的 /api/notify/test 同口径
	// （只回 internal error 的话用户看不到为什么发不出去）。
	switch {
	case errors.Is(err, service.ErrInvalid), errors.Is(err, service.ErrPluginActionNotTestable):
		return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
	case errors.Is(err, service.ErrPluginNotFound), errors.Is(err, service.ErrPluginDisabled):
		return writeServiceError(c, err)
	default:
		return c.JSON(http.StatusBadGateway, errorResponse{Error: err.Error()})
	}
}

// pluginInvokeRequest 界面直调的入参：哪个挂点、选了什么、动作自己的配置。
type pluginInvokeRequest struct {
	Surface   string            `json:"surface"`
	Selection plugin.Selection  `json:"selection"`
	Config    map[string]string `json:"config"`
}

// InvokePluginAction godoc
// @Summary 界面直调一个插件动作（按插件声明的权限补上下文）
// @Tags plugins
// @Accept json
// @Produce json
// @Param id path string true "插件 id"
// @Param actionId path string true "动作 id"
// @Param body body pluginInvokeRequest true "挂点 + 选择 + 配置"
// @Success 200 {object} plugin.InvokeResult
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Failure 502 {object} errorResponse "插件执行失败，error 里是插件给的可见原因"
// @Router /api/plugins/{id}/actions/{actionId}/invoke [post]
func (h *PluginHandler) InvokePluginAction(c echo.Context) error {
	var req pluginInvokeRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	pluginID := strings.TrimSpace(c.Param("id"))
	actionID := strings.TrimSpace(c.Param("actionId"))
	result, err := h.service.Invoke(c.Request().Context(), pluginID, actionID, plugin.InvokeRequest{
		Surface:   plugin.Surface(req.Surface),
		Selection: req.Selection,
		Config:    req.Config,
	})
	if err != nil {
		logger.Error("plugin action invoke failed", "module", "handler", "action", "invoke", "resource", "plugin", "result", "failed", "id", pluginID, "actionId", actionID, "error", err)
		switch {
		case errors.Is(err, service.ErrPluginActionNotFound):
			return c.JSON(http.StatusNotFound, errorResponse{Error: err.Error()})
		case errors.Is(err, service.ErrPluginActionNotInvokable), errors.Is(err, service.ErrPluginSurfaceUndeclared):
			return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
		case errors.Is(err, service.ErrPluginNotFound), errors.Is(err, service.ErrPluginDisabled), errors.Is(err, service.ErrInvalid):
			return writeServiceError(c, err)
		default:
			// 插件真执行失败 → 502 并回插件给的原因（与 /test 同口径：用户要知道为什么没成）
			return c.JSON(http.StatusBadGateway, errorResponse{Error: err.Error()})
		}
	}
	return c.JSON(http.StatusOK, result)
}

// Rescan 手动重新扫描插件目录（55-7b：与 List 同一份 Catalog —— ensureExternal 就在 Catalog 链上，
// 所以「重新扫描」= 再拿一次清单；等不及轮询的用户点它）。
func (h *PluginHandler) Rescan(c echo.Context) error {
	items, err := h.service.Catalog(c.Request().Context())
	if err != nil {
		logger.Error("plugin rescan failed", "module", "handler", "action", "rescan", "resource", "plugin", "result", "failed", "error", err)
		return writeServiceError(c, err)
	}
	return c.JSON(http.StatusOK, pluginCatalogResponse{Plugins: toCatalogItems(items)})
}
