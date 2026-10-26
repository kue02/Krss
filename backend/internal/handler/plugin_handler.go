//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package handler

import (
	"errors"
	"io/fs"
	"net/http"
	"net/url"
	"strconv"
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
	// 插件专属数据（56-19）。段数不同（整 collection 2 段 / 单键 3 段）⇒ 不会互相吃掉；
	// 宿主只认「插件碰自己」：id 由路由给出，外部插件走 socket 时由宿主注入，插件填不了别人的。
	g.GET("/plugins/:id/data/:collection", h.ListPluginData)
	g.DELETE("/plugins/:id/data/:collection", h.DeletePluginDataCollection)
	g.GET("/plugins/:id/data/:collection/:key", h.GetPluginData)
	g.PUT("/plugins/:id/data/:collection/:key", h.PutPluginData)
	g.DELETE("/plugins/:id/data/:collection/:key", h.DeletePluginData)
	// 正文装饰聚合（56-21）：路由按业务挂在 /entries/:id 下（阅读器取装饰的入口），
	// 聚合逻辑却属插件域（要注册表 + 各插件），所以由 PluginHandler 注册 ——
	// 为它把 PluginService 塞进 EntryHandler 要动 NewEntryHandler/NewRouter 的签名与既有测试，不值当。
	g.GET("/entries/:id/decorations", h.ListEntryDecorations)
	// 沙箱界面资源（56-24）：插件自带 HTML/JS，宿主按同源路径服务（iframe 侧是 opaque origin）。
	// 两条路由：`/ui` 与 `/ui/*` —— 前者让 `<iframe src="…/ui">` 少一次 301（FileServer 的目录重定向），
	// 两条都走同一个 handler；`*` 拿到的是不带前导斜杠的相对路径（空串 = 目录根）。
	g.GET("/plugins/:id/ui", h.GetUIAssets)
	g.GET("/plugins/:id/ui/*", h.GetUIAssets)
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

// pluginDataValueResponse 单键出参：键 + 不透明值（插件自己的 JSON 字符串，本体不动）。
type pluginDataValueResponse struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// pluginDataListResponse collection 列举的出参（空 collection 是 {} 不是 null）。
type pluginDataListResponse struct {
	Values map[string]string `json:"values"`
}

// pluginDataPutRequest 写入入参：value 必须是字符串（插件自己序列化好的 JSON）。
// 不接受任意 JSON 树 —— 本体不解析，原样存，免得「存进去一个对象、读出来是另一种串」。
type pluginDataPutRequest struct {
	Value string `json:"value"`
}

// ListPluginData godoc
// @Summary 列插件某个 collection 的键值（?prefix= 过滤、?limit= 限条数，缺省 200 上限 1000）
// @Tags plugins
// @Produce json
// @Param id path string true "插件 id"
// @Param collection path string true "collection 名（^[a-z0-9_-]{1,32}$）"
// @Param prefix query string false "只列以此开头的键（空 = 全部）"
// @Param limit query int false "最多几条（缺省 200，上限 1000）"
// @Success 200 {object} pluginDataListResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Failure 409 {object} errorResponse "插件已停用"
// @Router /api/plugins/{id}/data/{collection} [get]
func (h *PluginHandler) ListPluginData(c echo.Context) error {
	// limit 传垃圾值当缺省处理（别把「前端少填一个参数」变成 500）。
	limit, err := strconv.Atoi(strings.TrimSpace(c.QueryParam("limit")))
	if err != nil {
		limit = 0
	}
	values, err := h.service.ListData(c.Request().Context(), c.Param("id"), c.Param("collection"),
		c.QueryParam("prefix"), limit)
	if err != nil {
		logger.Error("plugin data list failed", "module", "handler", "action", "list", "resource", "plugin_data",
			"result", "failed", "id", c.Param("id"), "collection", c.Param("collection"), "error", err)
		return writeServiceError(c, err)
	}
	if values == nil {
		values = map[string]string{}
	}
	return c.JSON(http.StatusOK, pluginDataListResponse{Values: values})
}

// GetPluginData godoc
// @Summary 读插件自己存的一个键
// @Tags plugins
// @Produce json
// @Param id path string true "插件 id"
// @Param collection path string true "collection 名（^[a-z0-9_-]{1,32}$）"
// @Param key path string true "键名（1..200 字节，特殊字符要 URL 编码）"
// @Success 200 {object} pluginDataValueResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse "键不存在（或插件不存在）"
// @Failure 409 {object} errorResponse "插件已停用"
// @Router /api/plugins/{id}/data/{collection}/{key} [get]
func (h *PluginHandler) GetPluginData(c echo.Context) error {
	value, err := h.service.GetData(c.Request().Context(), c.Param("id"), c.Param("collection"), c.Param("key"))
	if err != nil {
		return writeServiceError(c, err)
	}
	return c.JSON(http.StatusOK, pluginDataValueResponse{Key: c.Param("key"), Value: value})
}

// PutPluginData godoc
// @Summary 写 / 覆盖插件自己的一个键（同键再写 = 覆盖）
// @Tags plugins
// @Accept json
// @Produce json
// @Param id path string true "插件 id"
// @Param collection path string true "collection 名（^[a-z0-9_-]{1,32}$）"
// @Param key path string true "键名（1..200 字节）"
// @Param body body pluginDataPutRequest true "值（字符串，≤256KB）"
// @Success 200 {object} pluginDataValueResponse
// @Failure 400 {object} errorResponse "collection / 键名不合规，或值超 256KB"
// @Failure 404 {object} errorResponse
// @Failure 409 {object} errorResponse "插件已停用"
// @Router /api/plugins/{id}/data/{collection}/{key} [put]
func (h *PluginHandler) PutPluginData(c echo.Context) error {
	var req pluginDataPutRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	if err := h.service.PutData(c.Request().Context(), c.Param("id"), c.Param("collection"), c.Param("key"), req.Value); err != nil {
		logger.Error("plugin data put failed", "module", "handler", "action", "put", "resource", "plugin_data",
			"result", "failed", "id", c.Param("id"), "collection", c.Param("collection"), "key", c.Param("key"), "error", err)
		return writeServiceError(c, err)
	}
	return c.JSON(http.StatusOK, pluginDataValueResponse{Key: c.Param("key"), Value: req.Value})
}

// DeletePluginData godoc
// @Summary 删插件自己的一个键（键不在 = 404）
// @Tags plugins
// @Produce json
// @Param id path string true "插件 id"
// @Param collection path string true "collection 名（^[a-z0-9_-]{1,32}$）"
// @Param key path string true "键名"
// @Success 204
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Failure 409 {object} errorResponse "插件已停用"
// @Router /api/plugins/{id}/data/{collection}/{key} [delete]
func (h *PluginHandler) DeletePluginData(c echo.Context) error {
	if err := h.service.DeleteData(c.Request().Context(), c.Param("id"), c.Param("collection"), c.Param("key")); err != nil {
		return writeServiceError(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// DeletePluginDataCollection godoc
// @Summary 删插件某个 collection 的全部键（幂等：空 collection 也 204）
// @Tags plugins
// @Produce json
// @Param id path string true "插件 id"
// @Param collection path string true "collection 名（^[a-z0-9_-]{1,32}$）"
// @Success 204
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Failure 409 {object} errorResponse "插件已停用"
// @Router /api/plugins/{id}/data/{collection} [delete]
func (h *PluginHandler) DeletePluginDataCollection(c echo.Context) error {
	if err := h.service.DeleteDataCollection(c.Request().Context(), c.Param("id"), c.Param("collection")); err != nil {
		return writeServiceError(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// entryDecorationsResponse 一条条目的正文装饰。空时是 []（不是 null）—— 阅读器直接遍历，不必判空。
type entryDecorationsResponse struct {
	Decorations []plugin.Decoration `json:"decorations"`
}

// ListEntryDecorations godoc
// @Summary 一条条目的正文装饰（各启用插件声明的段落样式区间）
// @Description 区间偏移以「正文纯文本」为基准（rune 计数，HTML 已由宿主剥掉）；单个插件 300ms 超时，
// @Description 出错/超时/越界一律跳过，返回的永远只是能画的那些。
// @Tags entries
// @Produce json
// @Param id path int true "Entry ID"
// @Success 200 {object} entryDecorationsResponse
// @Failure 400 {object} errorResponse
// @Router /api/entries/{id}/decorations [get]
func (h *PluginHandler) ListEntryDecorations(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid id"})
	}
	items, err := h.service.Decorations(c.Request().Context(), id)
	if err != nil {
		logger.Error("entry decorations failed", "module", "handler", "action", "decorate", "resource", "entry", "result", "failed", "entry_id", id, "error", err)
		return writeServiceError(c, err)
	}
	if items == nil {
		items = []plugin.Decoration{}
	}
	return c.JSON(http.StatusOK, entryDecorationsResponse{Decorations: items})
}

// uiIndexFile 目录访问的默认文件（访问 /ui/ 或 /ui 时补上）。
const uiIndexFile = "index.html"

// GetUIAssets godoc
// @Summary 插件自带的界面资源（沙箱 iframe 用；内置插件读 embed.FS、外部插件代理到 socket）
// @Description 只认 GET。插件不存在 404、停用 409、没声明 ui:custom 403、路径含 `..` 或绝对路径 400。
// @Description 响应固定带 CSP（connect-src 'none'）、X-Content-Type-Options: nosniff、Cache-Control: no-store。
// @Tags plugins
// @Produce application/octet-stream
// @Param id path string true "插件 id"
// @Param path path string false "资源相对路径（缺省 = index.html）"
// @Success 200 {file} file
// @Failure 400 {object} errorResponse
// @Failure 403 {object} errorResponse "插件没有声明 ui:custom"
// @Failure 404 {object} errorResponse
// @Failure 409 {object} errorResponse "插件已停用"
// @Failure 502 {object} errorResponse "外部插件取资源失败"
// @Router /api/plugins/{id}/ui/{path} [get]
func (h *PluginHandler) GetUIAssets(c echo.Context) error {
	subpath := c.Param("*")
	if !validUIAssetPath(subpath) {
		logger.Warn("plugin ui asset path rejected",
			"module", "handler", "action", "ui", "resource", "plugin", "result", "rejected",
			"plugin_id", c.Param("id"), "path", subpath)
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid ui asset path"})
	}
	// 目录访问（/ui 或 /ui/）补 index.html：前端 iframe 的 src 就写成这个形态。
	isDir := subpath == "" || strings.HasSuffix(subpath, "/")
	assetPath := subpath
	if isDir {
		assetPath = subpath + uiIndexFile
	}

	assets, err := h.service.UIAssets(c.Request().Context(), c.Param("id"))
	if err != nil {
		logger.Error("plugin ui assets failed", "module", "handler", "action", "ui", "resource", "plugin",
			"result", "failed", "id", c.Param("id"), "path", assetPath, "error", err)
		switch {
		case errors.Is(err, service.ErrPluginUIUndeclared):
			// 文案要点名缺什么：插件作者看日志 / 用户看报错都该知道去 Meta.Permissions 里补一条
			return c.JSON(http.StatusForbidden, errorResponse{
				Error: "插件没有声明 ui:custom 权限，禁止加载自带界面",
			})
		case errors.Is(err, service.ErrPluginUIUnavailable):
			return c.JSON(http.StatusNotFound, errorResponse{Error: "插件没有提供界面资源"})
		default:
			return writeServiceError(c, err)
		}
	}

	if assets.Files != nil {
		setUIAssetHeaders(c.Response().Header())
		serveUIAssetFile(c, assetPath, assets.Files)
		return nil
	}

	// 外部插件：宿主转发一次（service 已带 5s 超时）
	file, err := assets.Proxy(c.Request().Context(), assetPath)
	if err != nil {
		if errors.Is(err, plugin.ErrUIAssetNotFound) {
			return c.JSON(http.StatusNotFound, errorResponse{Error: "ui asset not found"})
		}
		logger.Error("plugin ui asset proxy failed", "module", "handler", "action", "ui", "resource", "plugin",
			"result", "failed", "id", c.Param("id"), "path", assetPath, "error", err)
		return c.JSON(http.StatusBadGateway, errorResponse{Error: err.Error()})
	}
	setUIAssetHeaders(c.Response().Header())
	if file.ContentType != "" {
		c.Response().Header().Set(echo.HeaderContentType, file.ContentType)
	}
	if _, err := c.Response().Write(file.Body); err != nil {
		return err
	}
	return nil
}

// setUIAssetHeaders 沙箱界面的三条固定响应头。
// no-store 是硬要求：插件更新后不能还让浏览器拿旧页（iframe 缓存的旧脚本会对着新契约发消息）。
func setUIAssetHeaders(header http.Header) {
	header.Set("Content-Security-Policy", plugin.UISandboxCSP)
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Cache-Control", "no-store")
}

// serveUIAssetFile 用 FileServer 服务一份内置插件资源。
// FileServer 只认 URL.Path（echo 的 `*` 参数不是它要的形态），所以复制一份请求换掉路径。
//
// 另一个坑：net/http 的 serveFile 见到以 index.html 结尾的路径会 301 到 "./"（它的规矩），
// 而插件视图入口偏偏就写成 index.html ⇒ 这里把 index.html 折成目录根，让 FileServer 自己挑 index，
// 免得客户端（iframe）多跳一次、也免得相对路径在 301 之后按新目录解析。
// 路径到这一步已经过 validUIAssetPath + 解码，不再二次清洗。
func serveUIAssetFile(c echo.Context, assetPath string, files fs.FS) {
	// URL.Path 是**解码后**的形态（FileServer 按它找文件），所以这里先解一次（已校验过，安全）。
	if decoded, err := url.PathUnescape(assetPath); err == nil {
		assetPath = decoded
	}
	path := assetPath
	if path == uiIndexFile {
		path = ""
	} else if strings.HasSuffix(path, "/"+uiIndexFile) {
		path = strings.TrimSuffix(path, "/"+uiIndexFile)
	}
	req := new(http.Request)
	*req = *c.Request()
	urlCopy := *c.Request().URL
	req.URL = &urlCopy
	req.URL.Path = "/" + path
	req.URL.RawPath = ""
	http.FileServer(http.FS(files)).ServeHTTP(c.Response(), req)
}

// validUIAssetPath 路径防护：自己先查一道，不把「穿越」指望给 FileServer / embedding 的洁癖。
//   - 空串 = 目录根（后面补 index.html），放行；
//   - 含 ".."（不管是不是整段）一律拒 —— 宁可误杀 a..b.js 这种怪名，也不给穿越留口子；
//   - 以 "/" 开头 = 绝对路径 / 双斜杠（echo 的 `*` 不带前导斜杠），拒；
//   - 反斜杠（Windows 分隔符）与 NUL 字节，拒；
//   - 编码写法（%2e%2e）在 echo 这边以 RawPath 形态递过来（Param("*") 不解码），所以解码后再查一遍，
//     否则 "%2e%2e/secret" 会绕过检查一路走到 FileServer。
func validUIAssetPath(subpath string) bool {
	if subpath == "" {
		return true
	}
	if strings.HasPrefix(subpath, "/") {
		return false
	}
	if strings.ContainsAny(subpath, "\\\x00") {
		return false
	}
	decoded, err := url.PathUnescape(subpath)
	if err != nil {
		return false
	}
	if strings.Contains(decoded, "..") || strings.HasPrefix(decoded, "/") {
		return false
	}
	return !strings.ContainsAny(decoded, "\\\x00")
}
