package handler

import (
	"context"
	"encoding/json"
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

type FeedHandler struct {
	service        service.FeedService
	refreshService service.RefreshService
	// proxySources 解析「这条订阅实际用哪套代理」（14 批）；nil 时响应里不带 effective
	proxySources service.ProxySourceService
}

type createFeedRequest struct {
	URL      string  `json:"url"`
	FolderID *string `json:"folderId"`
	Title    string  `json:"title"`
	Type     string  `json:"type"`
	// 16 批：sourceType=mcp 时走 MCP 建源（url 可空，改由 mcpConfig 描述怎么取数）。
	SourceType string            `json:"sourceType"`
	MCPConfig  *mcpFeedConfigReq `json:"mcpConfig"`
}

// mcpFeedConfigReq 建 MCP 订阅时带过来的配置（连接 + 工具/资源 + 参数 + 字段映射）。
type mcpFeedConfigReq struct {
	ServerID    string                `json:"serverId"`
	Kind        string                `json:"kind"`
	ToolName    string                `json:"toolName"`
	ResourceURI string                `json:"resourceUri"`
	Arguments   map[string]any        `json:"arguments"`
	Limit       int                   `json:"limit"`
	Mapping     model.MCPFieldMapping `json:"mapping"`
	Tier        string                `json:"tier"`
	KeyLevel    string                `json:"keyLevel"`
}

type updateTypeRequest struct {
	Type string `json:"type"`
}

type feedConflictResponse struct {
	Error        string       `json:"error" example:"feed_exists"`
	ExistingFeed feedResponse `json:"existingFeed"`
}

type updateFeedRequest struct {
	Title                 string  `json:"title" binding:"required"`
	FolderID              *string `json:"folderId"`
	SummaryPromptReminder *string `json:"summaryPromptReminder"`
}

// 改地址时撞上另一个订阅（RSSHub 换实例后同源）：带上是哪条，前端据此弹「确认合并」
type feedURLConflictResponse struct {
	Error    string              `json:"error"`
	Conflict *feedConflictDetail `json:"conflict"`
}

type feedConflictDetail struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type mergeIntoRequest struct {
	TargetID string `json:"targetId"`
}

type feedMergeSideResponse struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Entries int64  `json:"entries"`
	Starred int64  `json:"starred"`
}

type feedMergePreviewResponse struct {
	Source feedMergeSideResponse  `json:"source"`
	Target *feedMergeSideResponse `json:"target"`
}

type feedMergeResultResponse struct {
	TargetID       string `json:"targetId"`
	MovedEntries   int64  `json:"movedEntries"`
	DedupedEntries int64  `json:"dedupedEntries"`
}

type updateFeedURLRequest struct {
	URL string `json:"url"`
}

type updateFeedAIRequest struct {
	AutoTranslate *bool `json:"autoTranslate"`
	AutoSummary   *bool `json:"autoSummary"`
	// ReaderMode：正文打开方式，nil = 跟随全局；true = 阅读模式，false = 原文
	ReaderMode *bool `json:"readerMode"`
}

type deleteFeedsRequest struct {
	IDs []string `json:"ids"`
}

type feedResponse struct {
	ID                    string  `json:"id"`
	FolderID              *string `json:"folderId,omitempty"`
	Title                 string  `json:"title"`
	URL                   string  `json:"url"`
	SiteURL               *string `json:"siteUrl,omitempty"`
	Description           *string `json:"description,omitempty"`
	SummaryPromptReminder *string `json:"summaryPromptReminder,omitempty"`
	IconPath              *string `json:"iconPath,omitempty"`
	Type                  string  `json:"type"`
	ETag                  *string `json:"etag,omitempty"`
	LastModified          *string `json:"lastModified,omitempty"`
	ErrorMessage          *string `json:"errorMessage,omitempty"`
	CreatedAt             string  `json:"createdAt"`
	UpdatedAt             string  `json:"updatedAt"`
	AutoTranslate         *bool   `json:"autoTranslate,omitempty"`
	AutoSummary           *bool   `json:"autoSummary,omitempty"`
	ReaderMode            *bool   `json:"readerMode,omitempty"`
	// 代理覆盖（14 批）：inherit = 跟随文件夹链 → 全局；proxy / direct 是本条自己选的
	ProxyMode string `json:"proxyMode"`
	// ProxyConfig：本条单独指定的一套代理（密码已掩码）；缺省 = 用全局那套
	ProxyConfig *model.ProxyOverrideConfig `json:"proxyConfig,omitempty"`
	// 16 批：rss（默认）/ mcp；MCPConfig 只有 mcp 源才有。
	SourceType string          `json:"sourceType"`
	MCPConfig  json.RawMessage `json:"mcpConfig,omitempty"`
}

// feedProxyResponse PATCH /feeds/:id/proxy 的回显：订阅本体 + 这一条**实际生效**的结果
// （mode/source/sourceName），前端行上直接显示「走代理 · 来自：文件夹「技术」」。
type feedProxyResponse struct {
	Feed      feedResponse           `json:"feed"`
	Effective service.ProxyEffective `json:"effective"`
}

type refreshStatusResponse struct {
	IsRefreshing    bool    `json:"isRefreshing"`
	LastRefreshedAt *string `json:"lastRefreshedAt,omitempty"`
	// 本次刷新进度：Total 待刷新源数、Completed 已完成数（仅刷新中有效）
	Total     int `json:"total,omitempty"`
	Completed int `json:"completed,omitempty"`
	// Results 最近一轮刷新里每个订阅的结果（新/更新条数、失败原因）—— 刷新结果弹框用（用户 11-8）
	Results []service.RefreshFeedResult `json:"results,omitempty"`
	// Trigger 最近一轮刷新的来源（manual / auto）—— 12-17：自动刷新不弹框，改记历史
	Trigger string `json:"trigger,omitempty"`
}

type feedPreviewResponse struct {
	URL         string  `json:"url"`
	Title       string  `json:"title"`
	Description *string `json:"description,omitempty"`
	SiteURL     *string `json:"siteUrl,omitempty"`
	ImageURL    *string `json:"imageUrl,omitempty"`
	ItemCount   *int    `json:"itemCount,omitempty"`
	LastUpdated *string `json:"lastUpdated,omitempty"`
	// Entries 订阅前试看的前几条条目（不落库），供「添加订阅」按视图预览真实效果
	Entries []feedPreviewEntryResponse `json:"entries,omitempty"`
}

type feedPreviewEntryResponse struct {
	Title        *string `json:"title,omitempty"`
	URL          *string `json:"url,omitempty"`
	Content      *string `json:"content,omitempty"`
	ThumbnailURL *string `json:"thumbnailUrl,omitempty"`
	Author       *string `json:"author,omitempty"`
	PublishedAt  *string `json:"publishedAt,omitempty"`
}

// NewFeedHandler 第三个参数可选：装上「按来源取代理」的解析器后，PATCH proxy 的回显里带实际生效结果。
// （用可变参数是为了不让既有调用点全部改签名，仓库里 NewAIServiceWithFeedContext 也是这个路子。）
func NewFeedHandler(service service.FeedService, refreshService service.RefreshService, proxySources ...service.ProxySourceService) *FeedHandler {
	handler := &FeedHandler{service: service, refreshService: refreshService}
	if len(proxySources) > 0 {
		handler.proxySources = proxySources[0]
	}
	return handler
}

func (h *FeedHandler) RegisterRoutes(g *echo.Group) {
	g.POST("/feeds", h.Create)
	g.POST("/feeds/refresh", h.RefreshAll)
	g.GET("/feeds/refresh", h.RefreshStatus)
	g.GET("/feeds/preview", h.Preview)
	g.GET("/feeds", h.List)
	g.PUT("/feeds/:id", h.Update)
	g.PATCH("/feeds/:id/type", h.UpdateType)
	g.PATCH("/feeds/:id/url", h.UpdateURL)
	g.GET("/feeds/merge-preview", h.MergePreview)
	g.POST("/feeds/:id/merge", h.MergeInto)
	g.PATCH("/feeds/:id/ai", h.UpdateAIOverrides)
	g.PATCH("/feeds/:id/proxy", h.UpdateProxyOverride)
	g.DELETE("/feeds/:id", h.Delete)
	g.DELETE("/feeds", h.DeleteBatch)
}

// Create creates a new feed.
// @Summary Create a feed
// @Description Subscribe to a new RSS/Atom feed
// @Tags feeds
// @Accept json
// @Produce json
// @Param feed body createFeedRequest true "Feed creation request"
// @Success 201 {object} feedResponse
// @Failure 400 {object} errorResponse
// @Failure 409 {object} feedConflictResponse "Feed URL already exists"
// @Router /feeds [post]
func (h *FeedHandler) Create(c echo.Context) error {
	var req createFeedRequest
	if err := c.Bind(&req); err != nil {
		logger.Debug("feed create invalid request", "module", "handler", "action", "create", "resource", "feed", "result", "failed", "error", err)
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var folderID *int64
	if req.FolderID != nil {
		id, err := strconv.ParseInt(*req.FolderID, 10, 64)
		if err != nil {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid folder ID"})
		}
		folderID = &id
	}
	feedType := req.Type
	if feedType == "" {
		feedType = "article"
	} else if !isValidContentType(feedType) {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "type must be article, picture, notification, or social"})
	}
	// 16 批：MCP 订阅建源（建源向导最后一步）—— 同样落成一条普通 feed 行
	if req.SourceType == model.FeedSourceMCP {
		if req.MCPConfig == nil || strings.TrimSpace(req.MCPConfig.ServerID) == "" {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "mcpConfig.serverId is required"})
		}
		serverID, err := strconv.ParseInt(strings.TrimSpace(req.MCPConfig.ServerID), 10, 64)
		if err != nil {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid mcp server ID"})
		}
		created, err := h.service.AddMCP(c.Request().Context(), service.MCPFeedAddInput{
			ServerID:    serverID,
			Kind:        req.MCPConfig.Kind,
			ToolName:    req.MCPConfig.ToolName,
			ResourceURI: req.MCPConfig.ResourceURI,
			Arguments:   req.MCPConfig.Arguments,
			Limit:       req.MCPConfig.Limit,
			Mapping:     req.MCPConfig.Mapping,
			Tier:        req.MCPConfig.Tier,
			KeyLevel:    req.MCPConfig.KeyLevel,
			Title:       req.Title,
			FolderID:    folderID,
			FeedType:    feedType,
		})
		if err != nil {
			var conflictErr *service.FeedConflictError
			if errors.As(err, &conflictErr) {
				return c.JSON(http.StatusConflict, feedConflictResponse{
					Error:        "feed_exists",
					ExistingFeed: toFeedResponse(conflictErr.ExistingFeed),
				})
			}
			logger.Error("mcp feed create failed", "module", "handler", "action", "create", "resource", "feed", "result", "failed", "mcp_server_id", serverID, "error", err)
			return writeServiceError(c, err)
		}
		logger.Info("mcp feed created", "module", "handler", "action", "create", "resource", "feed", "result", "ok", "feed_id", created.ID, "mcp_server_id", serverID)
		return c.JSON(http.StatusCreated, toFeedResponse(created))
	}

	feed, err := h.service.Add(c.Request().Context(), req.URL, folderID, req.Title, feedType)
	if err != nil {
		var conflictErr *service.FeedConflictError
		if errors.As(err, &conflictErr) {
			logger.Warn("feed create conflict", "module", "handler", "action", "create", "resource", "feed", "result", "failed", "host", network.ExtractHost(req.URL), "feed_id", conflictErr.ExistingFeed.ID, "feed_title", conflictErr.ExistingFeed.Title)
			return c.JSON(http.StatusConflict, feedConflictResponse{
				Error:        "feed_exists",
				ExistingFeed: toFeedResponse(conflictErr.ExistingFeed),
			})
		}
		logger.Error("feed create failed", "module", "handler", "action", "create", "resource", "feed", "result", "failed", "host", network.ExtractHost(req.URL), "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("feed created", "module", "handler", "action", "create", "resource", "feed", "result", "ok", "feed_id", feed.ID, "feed_title", feed.Title, "host", network.ExtractHost(feed.URL))
	return c.JSON(http.StatusCreated, toFeedResponse(feed))
}

// List returns all feeds, optionally filtered by folder.
// @Summary List feeds
// @Description Get a list of all subscribed feeds
// @Tags feeds
// @Produce json
// @Param folderId query int false "Filter by folder ID"
// @Success 200 {array} feedResponse
// @Router /feeds [get]
func (h *FeedHandler) List(c echo.Context) error {
	var folderID *int64
	if raw := c.QueryParam("folderId"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
		}
		folderID = &parsed
	}

	feeds, err := h.service.List(c.Request().Context(), folderID)
	if err != nil {
		logger.Error("feed list failed", "module", "handler", "action", "list", "resource", "feed", "result", "failed", "folder_id", folderID, "error", err)
		return writeServiceError(c, err)
	}
	response := make([]feedResponse, 0, len(feeds))
	for _, feed := range feeds {
		response = append(response, toFeedResponse(feed))
	}
	return c.JSON(http.StatusOK, response)
}

// Preview fetches a feed's information without subscribing.
// @Summary Preview a feed
// @Description Fetch information about a feed from its URL
// @Tags feeds
// @Produce json
// @Param url query string true "Feed URL"
// @Success 200 {object} feedPreviewResponse
// @Failure 400 {object} errorResponse
// @Router /feeds/preview [get]
func (h *FeedHandler) Preview(c echo.Context) error {
	rawURL := strings.TrimSpace(c.QueryParam("url"))
	if rawURL == "" {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	preview, err := h.service.Preview(c.Request().Context(), rawURL)
	if err != nil {
		logger.Warn("feed preview failed", "module", "handler", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(rawURL), "error", err)
		return writeServiceError(c, err)
	}
	logger.Debug("feed preview", "module", "handler", "action", "fetch", "resource", "feed", "result", "ok", "host", network.ExtractHost(rawURL))
	return c.JSON(http.StatusOK, toFeedPreviewResponse(preview))
}

// Update updates an existing feed.
// @Summary Update a feed
// @Description Update an existing feed. title is required; folder and summary prompt reminder are optional.
// @Tags feeds
// @Accept json
// @Produce json
// @Param id path int true "Feed ID"
// @Param feed body updateFeedRequest true "Feed update request"
// @Success 200 {object} feedResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /feeds/{id} [put]
func (h *FeedHandler) Update(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var req updateFeedRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	if strings.TrimSpace(req.Title) == "" {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "title is required"})
	}
	var folderID *int64
	if req.FolderID != nil {
		fid, err := strconv.ParseInt(*req.FolderID, 10, 64)
		if err != nil {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid folder ID"})
		}
		folderID = &fid
	}
	feed, err := h.service.Update(c.Request().Context(), id, req.Title, folderID, req.SummaryPromptReminder)
	if err != nil {
		logger.Error("feed update failed", "module", "handler", "action", "update", "resource", "feed", "result", "failed", "feed_id", id, "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("feed updated", "module", "handler", "action", "update", "resource", "feed", "result", "ok", "feed_id", feed.ID, "feed_title", feed.Title)
	return c.JSON(http.StatusOK, toFeedResponse(feed))
}

// UpdateURL 改订阅地址（RSSHub 换实例域名等）。
//
// @Summary Update feed URL
// @Description Change the source URL of a subscription (e.g. switch RSSHub instance)
// @Tags feeds
// @Accept json
// @Param id path int true "Feed ID"
// @Param request body updateFeedURLRequest true "URL update request"
// @Success 200 {object} feedResponse
// @Router /api/feeds/{id}/url [patch]
func (h *FeedHandler) UpdateURL(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var req updateFeedURLRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	feed, err := h.service.UpdateURL(c.Request().Context(), id, req.URL)
	if err != nil {
		var conflict *service.FeedURLConflictError
		if errors.As(err, &conflict) {
			logger.Info("feed url conflict", "module", "handler", "action", "update", "resource", "feed", "result", "conflict", "feed_id", id, "conflict_feed_id", conflict.Feed.ID)
			return c.JSON(http.StatusConflict, feedURLConflictResponse{
				Error: "feed url already exists",
				Conflict: &feedConflictDetail{
					ID:    idToString(conflict.Feed.ID),
					Title: conflict.Feed.Title,
				},
			})
		}
		logger.Error("feed url update failed", "module", "handler", "action", "update", "resource", "feed", "result", "failed", "feed_id", id, "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("feed url updated", "module", "handler", "action", "update", "resource", "feed", "result", "ok", "feed_id", feed.ID)
	return c.JSON(http.StatusOK, toFeedResponse(feed))
}

// MergePreview 合并预览：把这个订阅换成某地址时，目标是谁、两边各有几条/几条星标。
//
// @Summary Feed merge preview
// @Description Preview merging a subscription into the one that already owns the target URL
// @Tags feeds
// @Produce json
// @Param sourceId query int true "Source feed ID"
// @Param url query string true "Target URL"
// @Success 200 {object} feedMergePreviewResponse
// @Router /api/feeds/merge-preview [get]
func (h *FeedHandler) MergePreview(c echo.Context) error {
	sourceID, err := strconv.ParseInt(c.QueryParam("sourceId"), 10, 64)
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	preview, err := h.service.MergePreview(c.Request().Context(), sourceID, c.QueryParam("url"))
	if err != nil {
		return writeServiceError(c, err)
	}
	response := feedMergePreviewResponse{
		Source: feedMergeSideResponse{
			ID:      idToString(preview.Source.ID),
			Title:   preview.Source.Title,
			Entries: preview.Source.Entries,
			Starred: preview.Source.Starred,
		},
	}
	if preview.Target != nil {
		response.Target = &feedMergeSideResponse{
			ID:      idToString(preview.Target.ID),
			Title:   preview.Target.Title,
			Entries: preview.Target.Entries,
			Starred: preview.Target.Starred,
		}
	}
	return c.JSON(http.StatusOK, response)
}

// MergeInto 把 :id 这个订阅并入 targetId（保留 target，条目/星标/分类都并过去，然后删掉 :id）。
//
// @Summary Merge feed into another
// @Description Move entries of :id into targetId, then delete :id (target is kept)
// @Tags feeds
// @Accept json
// @Param id path int true "Source feed ID"
// @Param request body mergeIntoRequest true "Merge target"
// @Success 200 {object} feedMergeResultResponse
// @Router /api/feeds/{id}/merge [post]
func (h *FeedHandler) MergeInto(c echo.Context) error {
	sourceID, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var req mergeIntoRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	targetID, err := strconv.ParseInt(strings.TrimSpace(req.TargetID), 10, 64)
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}

	result, err := h.service.MergeInto(c.Request().Context(), sourceID, targetID)
	if err != nil {
		logger.Error("feed merge failed", "module", "handler", "action", "merge", "resource", "feed", "result", "failed", "feed_id", sourceID, "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("feed merged", "module", "handler", "action", "merge", "resource", "feed", "result", "ok",
		"source_feed_id", sourceID, "target_feed_id", result.TargetID,
		"moved", result.MovedEntries, "deduped", result.DedupedEntries)
	return c.JSON(http.StatusOK, feedMergeResultResponse{
		TargetID:       idToString(result.TargetID),
		MovedEntries:   result.MovedEntries,
		DedupedEntries: result.DedupedEntries,
	})
}

// UpdateAIOverrides 单独设置某个订阅的自动翻译/自动摘要（字段为 null 表示跟随全局）。
//
// @Summary Update feed AI overrides
// @Description Per-feed override for auto translate / auto summary (null = follow global)
// @Tags feeds
// @Accept json
// @Param id path int true "Feed ID"
// @Param request body updateFeedAIRequest true "AI overrides"
// @Success 200 {object} feedResponse
// @Router /api/feeds/{id}/ai [patch]
func (h *FeedHandler) UpdateAIOverrides(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var req updateFeedAIRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	feed, err := h.service.UpdateAIOverrides(c.Request().Context(), id, req.AutoTranslate, req.AutoSummary, req.ReaderMode)
	if err != nil {
		logger.Error("feed ai overrides update failed", "module", "handler", "action", "update", "resource", "feed", "result", "failed", "feed_id", id, "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("feed ai overrides updated", "module", "handler", "action", "update", "resource", "feed", "result", "ok", "feed_id", feed.ID)
	return c.JSON(http.StatusOK, toFeedResponse(feed))
}

// UpdateProxyOverride 单独设置某个订阅的代理覆盖（14 批）：跟随上级 / 走代理 / 直连。
// 回显里带 effective（实际生效结果与来源），前端直接显示在行上。
//
// @Summary Update feed proxy override
// @Description Per-feed proxy override (inherit / proxy / direct) with optional dedicated proxy config
// @Tags feeds
// @Accept json
// @Param id path int true "Feed ID"
// @Param request body proxyOverrideRequest true "Proxy override"
// @Success 200 {object} feedProxyResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /api/feeds/{id}/proxy [patch]
func (h *FeedHandler) UpdateProxyOverride(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var req proxyOverrideRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	update, err := parseProxyOverrideUpdate(req)
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
	}

	ctx := c.Request().Context()
	feed, err := h.service.UpdateProxyOverride(ctx, id, update)
	if err != nil {
		logger.Error("feed proxy override update failed", "module", "handler", "action", "update", "resource", "proxy", "result", "failed", "feed_id", id, "error", err)
		return writeServiceError(c, err)
	}
	effective := h.proxySources.ResolveForFeed(ctx, feed)
	logger.Info("feed proxy override updated", "module", "handler", "action", "update", "resource", "proxy", "result", "ok", "feed_id", feed.ID, "mode", effective.Mode, "source", effective.Source)
	return c.JSON(http.StatusOK, feedProxyResponse{Feed: toFeedResponse(feed), Effective: effective})
}

// UpdateType updates the content type of a feed.
// @Summary Update feed type
// @Description Change the content type of a feed (article/picture/notification/social)
// @Tags feeds
// @Accept json
// @Param id path int true "Feed ID"
// @Param request body updateTypeRequest true "Type update request"
// @Success 204 "No Content"
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /feeds/{id}/type [patch]
func (h *FeedHandler) UpdateType(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	var req updateTypeRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	if !isValidContentType(req.Type) {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "type must be article, picture, notification, or social"})
	}
	if err := h.service.UpdateType(c.Request().Context(), id, req.Type); err != nil {
		logger.Error("feed update type failed", "module", "handler", "action", "update", "resource", "feed", "result", "failed", "feed_id", id, "type", req.Type, "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("feed type updated", "module", "handler", "action", "update", "resource", "feed", "result", "ok", "feed_id", id, "type", req.Type)
	return c.NoContent(http.StatusNoContent)
}

// Delete deletes a feed.
// @Summary Delete a feed
// @Description Unsubscribe from a feed
// @Tags feeds
// @Param id path int true "Feed ID"
// @Success 204 "No Content"
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /feeds/{id} [delete]
func (h *FeedHandler) Delete(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	if err := h.service.Delete(c.Request().Context(), id); err != nil {
		logger.Error("feed delete failed", "module", "handler", "action", "delete", "resource", "feed", "result", "failed", "feed_id", id, "error", err)
		return writeServiceError(c, err)
	}
	logger.Info("feed deleted", "module", "handler", "action", "delete", "resource", "feed", "result", "ok", "feed_id", id)
	return c.NoContent(http.StatusNoContent)
}

// DeleteBatch deletes multiple feeds.
// @Summary Delete multiple feeds
// @Description Unsubscribe from multiple feeds at once
// @Tags feeds
// @Accept json
// @Param request body deleteFeedsRequest true "Feed IDs to delete"
// @Success 204 "No Content"
// @Failure 400 {object} errorResponse
// @Router /feeds [delete]
func (h *FeedHandler) DeleteBatch(c echo.Context) error {
	var req deleteFeedsRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	if len(req.IDs) == 0 {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "no feed IDs provided"})
	}

	// Parse all IDs first
	ids := make([]int64, 0, len(req.IDs))
	for _, idStr := range req.IDs {
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid feed ID"})
		}
		ids = append(ids, id)
	}

	// Delete all at once
	if err := h.service.DeleteBatch(c.Request().Context(), ids); err != nil {
		logger.Error("feed batch delete failed", "module", "handler", "action", "delete", "resource", "feed", "result", "failed", "count", len(ids), "error", err)
		return writeServiceError(c, err)
	}

	logger.Info("feed batch deleted", "module", "handler", "action", "delete", "resource", "feed", "result", "ok", "count", len(ids))
	return c.NoContent(http.StatusNoContent)
}

// RefreshStatus returns the current refresh status.
// @Summary Get refresh status
// @Description Get the current refresh status including whether a refresh is in progress and when the last refresh completed
// @Tags feeds
// @Produce json
// @Success 200 {object} refreshStatusResponse
// @Router /feeds/refresh [get]
func (h *FeedHandler) RefreshStatus(c echo.Context) error {
	status := h.refreshService.GetRefreshStatus()
	resp := refreshStatusResponse{
		IsRefreshing: status.IsRefreshing,
		Total:        status.Total,
		Completed:    status.Completed,
		Trigger:      status.Trigger,
		// 刷新已结束才带上每源结果（刷新中带着会让前端一直重渲染）
	}
	if !status.IsRefreshing {
		resp.Results = h.refreshService.LastRefreshResults()
	}
	if status.LastRefreshedAt != nil {
		t := status.LastRefreshedAt.UTC().Format(time.RFC3339)
		resp.LastRefreshedAt = &t
	}
	return c.JSON(http.StatusOK, resp)
}

// RefreshAll triggers a refresh of all feeds.
// @Summary Refresh all feeds
// @Description Trigger an immediate refresh of feeds; pass {"feedIds": [...]} to refresh only those
// @Tags feeds
// @Success 204 "No Content"
// @Failure 409 {object} errorResponse "Refresh already in progress"
// @Router /feeds/refresh [post]
// refreshRequest 可选指定要刷新的订阅；不传则刷新全部
type refreshRequest struct {
	FeedIDs []string `json:"feedIds"`
	// Force 强制拉取（用户 11-19）：忽略 etag/last-modified 与「同主机多久内不重复抓」。
	Force bool `json:"force"`
}

// RefreshAll 触发刷新后立刻返回。
//
// 之前是同步跑完才回 204：79 个源、其中几个冷缓存/被限流的要挂到 15s 超时，
// 一轮下来 40~130s，这个 POST 就一直挂着（浏览器并发连接也被它占着），
// 用户点完刷新再去点条目会看着像卡死。前端本来就是轮询 GET /feeds/refresh 拿
// isRefreshing/completed 来画进度圈的，所以这里改成后台执行 —— 立刻回 204，
// 进度与「刷完了」由状态接口报。
func (h *FeedHandler) RefreshAll(c echo.Context) error {
	ctx := c.Request().Context()

	// 已经在刷了就直说，不用排队等一轮
	if h.refreshService.IsRefreshing() {
		logger.Warn("feed refresh skipped", "module", "handler", "action", "refresh", "resource", "feed", "result", "skipped")
		return c.JSON(http.StatusConflict, errorResponse{Error: "refresh already in progress"})
	}

	var req refreshRequest
	if err := c.Bind(&req); err == nil && len(req.FeedIDs) > 0 {
		ids := make([]int64, 0, len(req.FeedIDs))
		for _, raw := range req.FeedIDs {
			id, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil {
				return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid feedIds"})
			}
			ids = append(ids, id)
		}

		// 请求一返回 ctx 就被取消，后台任务要用脱离取消的 ctx 跑完这一轮
		bgCtx := context.WithoutCancel(ctx)
		forceScope := req.Force || c.QueryParam("force") == "true"
		go func() {
			var refreshErr error
			if forceScope {
				refreshErr = h.refreshService.ForceRefreshFeeds(bgCtx, ids)
			} else {
				refreshErr = h.refreshService.RefreshFeeds(bgCtx, ids)
			}
			if err := refreshErr; err != nil && !errors.Is(err, service.ErrAlreadyRefreshing) {
				logger.Error("feed refresh failed", "module", "handler", "action", "refresh", "resource", "feed", "result", "failed", "count", len(ids), "error", err)
			}
		}()
		logger.Info("feed refresh triggered", "module", "handler", "action", "refresh", "resource", "feed", "result", "ok", "scope", "partial", "count", len(ids))
		return c.NoContent(http.StatusNoContent)
	}

	// 强制拉取：忽略条件请求与同主机冷却（用户 11-19），走同一条后台执行路径
	force := req.Force || c.QueryParam("force") == "true"
	bgCtx := context.WithoutCancel(ctx)
	go func() {
		var err error
		if force {
			err = h.refreshService.ForceRefreshAll(bgCtx)
		} else {
			err = h.refreshService.RefreshAll(bgCtx)
		}
		if err != nil && !errors.Is(err, service.ErrAlreadyRefreshing) {
			logger.Error("feed refresh failed", "module", "handler", "action", "refresh", "resource", "feed", "result", "failed", "error", err)
		}
	}()
	logger.Info("feed refresh triggered", "module", "handler", "action", "refresh", "resource", "feed", "result", "ok", "force", force)
	return c.NoContent(http.StatusNoContent)
}

func toFeedResponse(feed model.Feed) feedResponse {
	return feedResponse{
		ID:                    idToString(feed.ID),
		FolderID:              idPtrToString(feed.FolderID),
		Title:                 feed.Title,
		URL:                   feed.URL,
		SiteURL:               feed.SiteURL,
		Description:           feed.Description,
		SummaryPromptReminder: feed.SummaryPromptReminder,
		IconPath:              feed.IconPath,
		Type:                  feed.Type,
		ETag:                  feed.ETag,
		LastModified:          feed.LastModified,
		ErrorMessage:          feed.ErrorMessage,
		CreatedAt:             feed.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:             feed.UpdatedAt.UTC().Format(time.RFC3339),
		AutoTranslate:         feed.AutoTranslate,
		ReaderMode:            feed.ReaderMode,
		AutoSummary:           feed.AutoSummary,
		ProxyMode:             service.ProxyModeToString(feed.ProxyMode),
		ProxyConfig:           toProxyConfigResponse(feed.ProxyConfig),
		SourceType:            feedSourceTypeOrRSS(feed),
		MCPConfig:             rawJSONOrNil(feed.MCPConfig),
	}
}

// feedSourceTypeOrRSS 空值当 rss（老行没写过这一列时的语义）。
func feedSourceTypeOrRSS(feed model.Feed) string {
	if feed.SourceType == "" {
		return model.FeedSourceRSS
	}
	return feed.SourceType
}

// rawJSONOrNil 把库里的 JSON 原样透出去（坏数据不导致整个列表 500）。
func rawJSONOrNil(raw *string) json.RawMessage {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	if !json.Valid([]byte(*raw)) {
		return nil
	}
	return json.RawMessage(*raw)
}

func toFeedPreviewResponse(preview service.FeedPreview) feedPreviewResponse {
	resp := feedPreviewResponse{
		URL:         preview.URL,
		Title:       preview.Title,
		Description: preview.Description,
		SiteURL:     preview.SiteURL,
		ImageURL:    preview.ImageURL,
		ItemCount:   preview.ItemCount,
		LastUpdated: preview.LastUpdated,
	}

	for _, entry := range preview.Entries {
		item := feedPreviewEntryResponse{
			Title:        entry.Title,
			URL:          entry.URL,
			Content:      truncatePreviewContent(entry.Content),
			ThumbnailURL: entry.ThumbnailURL,
			Author:       entry.Author,
		}
		if entry.PublishedAt != nil {
			published := entry.PublishedAt.UTC().Format(time.RFC3339)
			item.PublishedAt = &published
		}
		resp.Entries = append(resp.Entries, item)
	}

	return resp
}

// previewContentLimit 试看正文的字符上限：预览只需要看排版，不需要全文。
const previewContentLimit = 2000

func truncatePreviewContent(content *string) *string {
	if content == nil {
		return nil
	}
	runes := []rune(*content)
	if len(runes) <= previewContentLimit {
		return content
	}
	trimmed := string(runes[:previewContentLimit])
	return &trimmed
}
