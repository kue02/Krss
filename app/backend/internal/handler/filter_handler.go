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
)

// FilterHandler 过滤规则（自动化）的 HTTP 层。
// 规则 = 作用域（全部/分类/订阅）+ 条件 + 动作；执行点在抓取入库之后，只改自己库里的标记。
type FilterHandler struct {
	service service.FilterService
}

func NewFilterHandler(service service.FilterService) *FilterHandler {
	return &FilterHandler{service: service}
}

func (h *FilterHandler) RegisterRoutes(g *echo.Group) {
	g.GET("/filters", h.List)
	g.POST("/filters", h.Create)
	// 注意：/filters/parse 与 /filters/exception 是固定段，必须排在 /filters/:id 之前
	g.POST("/filters/parse", h.ParseNaturalLanguage)
	g.POST("/filters/exception", h.CreateException)
	g.POST("/notify/test", h.TestNotify)
	g.PATCH("/filters/:id", h.Update)
	g.DELETE("/filters/:id", h.Delete)
	g.POST("/filters/preview", h.Preview)
	g.POST("/filters/:id/apply", h.ApplyToHistory)
	g.POST("/filters/:id/revert", h.Revert)
	g.GET("/filters/:id/matches", h.ListMatches)
	g.GET("/filters/view-counts", h.ViewCounts)
}

type filterConditionRequest struct {
	Logic    string `json:"logic,omitempty"`
	Negate   bool   `json:"negate"`
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

type filterActionsPayload struct {
	Mute       bool `json:"mute"`
	Unmute     bool `json:"unmute"`
	MarkRead   bool `json:"markRead"`
	MarkUnread bool `json:"markUnread"`
	Star       bool `json:"star"`
	Unstar     bool `json:"unstar"`
	KeepOnly   bool `json:"keepOnly"`
	// P2 动作：条目级「打开时自动翻译 / 自动摘要」标记 + 出网 webhook
	Translate  bool   `json:"translate"`
	Summarize  bool   `json:"summarize"`
	Webhook    bool   `json:"webhook"`
	WebhookURL string `json:"webhookUrl,omitempty"`
	// Notify：命中后推一条到手机（Bark 兼容；地址留空 = 跟随设置里的全局推送地址）
	Notify    bool   `json:"notify"`
	NotifyURL string `json:"notifyUrl,omitempty"`
}

type filterWriteRequest struct {
	Name       string                   `json:"name"`
	Enabled    *bool                    `json:"enabled"`
	Position   *int                     `json:"position"`
	Kind       string                   `json:"kind"`
	ScopeType  string                   `json:"scopeType"`
	ScopeID    *string                  `json:"scopeId"`
	Conditions []filterConditionRequest `json:"conditions"`
	Actions    filterActionsPayload     `json:"actions"`
}

type filterResponse struct {
	ID            string                   `json:"id"`
	Name          string                   `json:"name"`
	Enabled       bool                     `json:"enabled"`
	Position      int                      `json:"position"`
	Kind          string                   `json:"kind"`
	ScopeType     string                   `json:"scopeType"`
	ScopeID       *string                  `json:"scopeId,omitempty"`
	Conditions    []filterConditionRequest `json:"conditions"`
	Actions       filterActionsPayload     `json:"actions"`
	MatchCount    int64                    `json:"matchCount"`
	LastMatchedAt *string                  `json:"lastMatchedAt,omitempty"`
	// LastError / LastErrorAt：这条规则最近一次执行失败的原因（webhook 投递失败、AI 判定失败）
	LastError   *string `json:"lastError,omitempty"`
	LastErrorAt *string `json:"lastErrorAt,omitempty"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

type filterListResponse struct {
	Filters []filterResponse `json:"filters"`
}

type filterPreviewItem struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	FeedTitle   string               `json:"feedTitle"`
	PublishedAt *string              `json:"publishedAt,omitempty"`
	Actions     filterActionsPayload `json:"actions"`
}

type filterPreviewResponse struct {
	Scanned       int                 `json:"scanned"`
	MatchedCount  int                 `json:"matchedCount"`
	MuteCount     int                 `json:"muteCount"`
	MarkReadCount int                 `json:"markReadCount"`
	StarCount     int                 `json:"starCount"`
	// AI 条件的预览口径：吃了几条已有判定缓存、多少条因为「没判过/正文太短/到上限」没算数
	AIChecked     int                 `json:"aiChecked"`
	AISkipped     int                 `json:"aiSkipped"`
	AISkipReasons []string            `json:"aiSkipReasons,omitempty"`
	Matched       []filterPreviewItem `json:"matched"`
}

type filterRevertResponse struct {
	Reverted int64 `json:"reverted"`
}

type filterApplyHistoryResponse struct {
	Scanned int `json:"scanned"`
	Applied int `json:"applied"`
}

type filterMatchItem struct {
	ID         string               `json:"id"`
	FilterID   string               `json:"filterId"`
	EntryID    string               `json:"entryId"`
	EntryTitle string               `json:"entryTitle"`
	FeedTitle  string               `json:"feedTitle"`
	Actions    filterActionsPayload `json:"actions"`
	CreatedAt  string               `json:"createdAt"`
}

type filterMatchesResponse struct {
	Matches []filterMatchItem `json:"matches"`
}

type filterDraftRequest struct {
	// Text 用户说的一句人话（「把标题里带赞助的广告都静音」）
	Text string `json:"text"`
}

// filterDraftResponse 自然语言建规则的结果：一份可直接填进编辑器抽屉的草稿（尚未落库）。
type filterDraftResponse struct {
	Name       string                   `json:"name"`
	ScopeType  string                   `json:"scopeType"`
	ScopeID    *string                  `json:"scopeId,omitempty"`
	Conditions []filterConditionRequest `json:"conditions"`
	Actions    filterActionsPayload     `json:"actions"`
	// Notes：模型给出的一句话解释；Warnings：被修正/丢弃的东西（必须显示给用户）
	Notes    string   `json:"notes,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

type filterExceptionRequest struct {
	EntryID string `json:"entryId"`
}

type notifyTestResponse struct {
	Status int `json:"status"`
}

// TestNotify 发一条测试推送（设置页「发送测试推送」按钮）。
//
// 挂在过滤处理器下是因为推送就是**过滤动作的通道**（notify 动作），走的是同一条发送路径——
// 会真出网，所以能一并验证代理与地址是否可用。没配地址明确回 400，投递失败回 502 并带上下游原话。
//
// @Summary Send test notification
// @Description Send a test push via the configured notify channel (Bark)
// @Tags settings
// @Produce json
// @Success 200 {object} notifyTestResponse
// @Router /api/notify/test [post]
func (h *FilterHandler) TestNotify(c echo.Context) error {
	status, err := h.service.TestNotify(c.Request().Context())
	if err != nil {
		if errors.Is(err, service.ErrInvalid) {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "notify url not configured"})
		}
		logger.Warn("test notify failed", "module", "handler", "action", "notify", "resource", "settings", "result", "failed", "error", err)
		return c.JSON(http.StatusBadGateway, errorResponse{Error: err.Error()})
	}
	return c.JSON(http.StatusOK, notifyTestResponse{Status: status})
}

// List returns all filter rules ordered by position.
// @Summary List filter rules
// @Description Get all automation rules ordered by match position (first match wins)
// @Tags filters
// @Produce json
// @Success 200 {object} filterListResponse
// @Router /filters [get]
func (h *FilterHandler) List(c echo.Context) error {
	filters, err := h.service.List(c.Request().Context())
	if err != nil {
		logger.Error("filter list failed", "module", "handler", "action", "list", "resource", "filter", "result", "failed", "error", err)
		return writeServiceError(c, err)
	}

	response := filterListResponse{Filters: make([]filterResponse, len(filters))}
	for i, filter := range filters {
		response.Filters[i] = toFilterResponse(filter)
	}
	return c.JSON(http.StatusOK, response)
}

// Create creates a filter rule.
// @Summary Create filter rule
// @Description Create an automation rule (scope + conditions + actions)
// @Tags filters
// @Accept json
// @Produce json
// @Param request body filterWriteRequest true "Filter rule"
// @Success 201 {object} filterResponse
// @Failure 400 {object} errorResponse
// @Router /filters [post]
func (h *FilterHandler) Create(c echo.Context) error {
	params, err := bindFilterWriteRequest(c)
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
	}

	created, err := h.service.Create(c.Request().Context(), params)
	if err != nil {
		return writeFilterError(c, err)
	}

	logger.Info("filter created", "module", "handler", "action", "create", "resource", "filter", "result", "ok", "filter_id", created.ID)
	return c.JSON(http.StatusCreated, toFilterResponse(created))
}

// Update updates a filter rule.
// @Summary Update filter rule
// @Description Update name, scope, conditions, actions, enabled flag or match position
// @Tags filters
// @Accept json
// @Produce json
// @Param id path int true "Filter ID"
// @Param request body filterWriteRequest true "Filter rule"
// @Success 200 {object} filterResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /filters/{id} [patch]
func (h *FilterHandler) Update(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid id"})
	}
	params, err := bindFilterWriteRequest(c)
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
	}

	updated, err := h.service.Update(c.Request().Context(), id, params)
	if err != nil {
		return writeFilterError(c, err)
	}

	logger.Info("filter updated", "module", "handler", "action", "update", "resource", "filter", "result", "ok", "filter_id", id)
	return c.JSON(http.StatusOK, toFilterResponse(updated))
}

// Delete deletes a filter rule.
// @Summary Delete filter rule
// @Description Delete a rule; pass revert=true to also restore the entries it muted
// @Tags filters
// @Produce json
// @Param id path int true "Filter ID"
// @Param revert query bool false "Restore entries muted by this rule"
// @Success 200 {object} filterRevertResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /filters/{id} [delete]
func (h *FilterHandler) Delete(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid id"})
	}

	reverted, err := h.service.Delete(c.Request().Context(), id, c.QueryParam("revert") == "true")
	if err != nil {
		return writeFilterError(c, err)
	}

	logger.Info("filter deleted", "module", "handler", "action", "delete", "resource", "filter", "result", "ok", "filter_id", id, "reverted", reverted)
	return c.JSON(http.StatusOK, filterRevertResponse{Reverted: reverted})
}

// ViewCounts 数每条保存视图当前命中的条目数（侧栏「收藏 / 视图」的数量角标）。
// @Summary Count entries matched by each saved view
// @Tags filters
// @Produce json
// @Param contentType query string false "Only count this content type (article|picture|notification|social)"
// @Success 200 {object} viewCountsResponse
// @Failure 500 {object} errorResponse
// @Router /filters/view-counts [get]
func (h *FilterHandler) ViewCounts(c echo.Context) error {
	var contentType *string
	if raw := strings.TrimSpace(c.QueryParam("contentType")); raw != "" {
		contentType = &raw
	}
	counts, err := h.service.CountViewMatches(c.Request().Context(), contentType)
	if err != nil {
		return writeServiceError(c, err)
	}
	payload := make(map[string]int, len(counts))
	for id, count := range counts {
		payload[strconv.FormatInt(id, 10)] = count
	}
	return c.JSON(http.StatusOK, viewCountsResponse{Counts: payload})
}

// viewCountsResponse 视图 id（字符串化，对齐其它计数接口）→ 命中条目数。
type viewCountsResponse struct {
	Counts map[string]int `json:"counts"`
}

// Preview dry-runs a rule body without writing anything.
// @Summary Preview filter rule
// @Description Dry-run a rule against the most recent entries in its scope (no writes)
// @Tags filters
// @Accept json
// @Produce json
// @Param limit query int false "How many recent entries to scan (default 200)"
// @Param request body filterWriteRequest true "Filter rule"
// @Success 200 {object} filterPreviewResponse
// @Failure 400 {object} errorResponse
// @Router /filters/preview [post]
func (h *FilterHandler) Preview(c echo.Context) error {
	params, err := bindFilterWriteRequest(c)
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
	}

	limit := 200
	if raw := c.QueryParam("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	result, err := h.service.Preview(c.Request().Context(), params, limit)
	if err != nil {
		return writeFilterError(c, err)
	}

	response := filterPreviewResponse{
		Scanned:       result.Scanned,
		MatchedCount:  result.MatchedCount,
		MuteCount:     result.MuteCount,
		MarkReadCount: result.MarkReadCount,
		StarCount:     result.StarCount,
		AIChecked:     result.AIChecked,
		AISkipped:     result.AISkipped,
		AISkipReasons: result.AISkipReasons,
		Matched:       make([]filterPreviewItem, len(result.Matched)),
	}
	for i, item := range result.Matched {
		entry := filterPreviewItem{
			ID:        idToString(item.ID),
			Title:     item.Title,
			FeedTitle: item.FeedTitle,
			Actions:   toActionsPayload(item.Actions),
		}
		if item.PublishedAt != nil {
			formatted := item.PublishedAt.UTC().Format(time.RFC3339)
			entry.PublishedAt = &formatted
		}
		response.Matched[i] = entry
	}
	return c.JSON(http.StatusOK, response)
}

// ApplyToHistory re-runs the rule chain over historical entries in the rule's scope.
// @Summary Apply rule to history
// @Description Backfill: run the rule chain (first match wins, idempotent) over the most recent entries in this rule's scope
// @Tags filters
// @Produce json
// @Param id path int true "Filter ID"
// @Param limit query int false "How many recent entries to scan (default 500, max 2000)"
// @Success 200 {object} filterApplyHistoryResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /filters/{id}/apply [post]
func (h *FilterHandler) ApplyToHistory(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid id"})
	}

	limit := 500
	if raw := c.QueryParam("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	scanned, applied, err := h.service.ApplyToHistory(c.Request().Context(), id, limit)
	if err != nil {
		return writeFilterError(c, err)
	}

	logger.Info("filter applied to history", "module", "handler", "action", "apply", "resource", "filter", "result", "ok", "filter_id", id, "scanned", scanned, "applied", applied)
	return c.JSON(http.StatusOK, filterApplyHistoryResponse{Scanned: scanned, Applied: applied})
}

// Revert restores the entries muted by a rule.
// @Summary Revert filter rule
// @Description Clear the marks written by this rule (muted off, muted entries back to unread)
// @Tags filters
// @Produce json
// @Param id path int true "Filter ID"
// @Success 200 {object} filterRevertResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /filters/{id}/revert [post]
func (h *FilterHandler) Revert(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid id"})
	}

	reverted, err := h.service.Revert(c.Request().Context(), id)
	if err != nil {
		return writeFilterError(c, err)
	}

	logger.Info("filter reverted", "module", "handler", "action", "revert", "resource", "filter", "result", "ok", "filter_id", id, "reverted", reverted)
	return c.JSON(http.StatusOK, filterRevertResponse{Reverted: reverted})
}

// ListMatches returns the recent match log of a rule.
// @Summary List filter matches
// @Description Get the recent entries this rule matched (audit log for "why is this hidden")
// @Tags filters
// @Produce json
// @Param id path int true "Filter ID"
// @Param limit query int false "Max records (default 50)"
// @Success 200 {object} filterMatchesResponse
// @Failure 400 {object} errorResponse
// @Router /filters/{id}/matches [get]
func (h *FilterHandler) ListMatches(c echo.Context) error {
	id, err := parseIDParam(c, "id")
	if err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid id"})
	}

	limit := 50
	if raw := c.QueryParam("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	matches, err := h.service.ListMatches(c.Request().Context(), id, limit)
	if err != nil {
		return writeFilterError(c, err)
	}

	response := filterMatchesResponse{Matches: make([]filterMatchItem, len(matches))}
	for i, match := range matches {
		response.Matches[i] = filterMatchItem{
			ID:         idToString(match.ID),
			FilterID:   idToString(match.FilterID),
			EntryID:    idToString(match.EntryID),
			EntryTitle: match.EntryTitle,
			FeedTitle:  match.FeedTitle,
			Actions:    toActionsPayload(match.Actions),
			CreatedAt:  match.CreatedAt.UTC().Format(time.RFC3339),
		}
	}
	return c.JSON(http.StatusOK, response)
}

// ParseNaturalLanguage turns a plain-language request into a rule draft (nothing is saved).
// @Summary Parse natural-language rule
// @Description Ask the configured AI provider to turn a sentence into a rule draft; the client confirms it in the editor
// @Tags filters
// @Accept json
// @Produce json
// @Param request body filterDraftRequest true "Natural language request"
// @Success 200 {object} filterDraftResponse
// @Failure 400 {object} errorResponse
// @Failure 422 {object} errorResponse
// @Router /filters/parse [post]
func (h *FilterHandler) ParseNaturalLanguage(c echo.Context) error {
	var req filterDraftRequest
	if err := c.Bind(&req); err != nil || strings.TrimSpace(req.Text) == "" {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}

	draft, err := h.service.ParseNaturalLanguage(c.Request().Context(), req.Text)
	if err != nil {
		return writeFilterError(c, err)
	}

	response := filterDraftResponse{
		Name:      draft.Name,
		ScopeType: draft.ScopeType,
		Actions:   toActionsPayload(draft.Actions),
		Notes:     draft.Notes,
		Warnings:  draft.Warnings,
	}
	if draft.ScopeID != nil {
		response.ScopeID = idPtrToString(draft.ScopeID)
	}
	response.Conditions = make([]filterConditionRequest, len(draft.Conditions))
	for i, condition := range draft.Conditions {
		response.Conditions[i] = filterConditionRequest{
			Logic:    condition.Logic,
			Negate:   condition.Negate,
			Field:    condition.Field,
			Operator: condition.Operator,
			Value:    condition.Value,
		}
	}

	logger.Info("filter draft parsed", "module", "handler", "action", "parse", "resource", "filter", "result", "ok")
	return c.JSON(http.StatusOK, response)
}

// CreateException turns "this entry was caught by mistake" into an exception rule.
// @Summary Create exception rule for an entry
// @Description Create a front-of-chain rule that only reverts actions (unmute + unread) for this entry's link, and release that entry now
// @Tags filters
// @Accept json
// @Produce json
// @Param request body filterExceptionRequest true "Entry to exempt"
// @Success 201 {object} filterResponse
// @Failure 400 {object} errorResponse
// @Failure 404 {object} errorResponse
// @Router /filters/exception [post]
func (h *FilterHandler) CreateException(c echo.Context) error {
	var req filterExceptionRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	entryID, err := strconv.ParseInt(strings.TrimSpace(req.EntryID), 10, 64)
	if err != nil || entryID <= 0 {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid entryId"})
	}

	created, err := h.service.CreateException(c.Request().Context(), entryID)
	if err != nil {
		return writeFilterError(c, err)
	}

	logger.Info("filter exception created", "module", "handler", "action", "create", "resource", "filter", "result", "ok", "filter_id", created.ID, "entry_id", entryID)
	return c.JSON(http.StatusCreated, toFilterResponse(created))
}

// bindFilterWriteRequest 把请求体翻成 service 入参（scopeId 是 snowflake 字符串）。
func bindFilterWriteRequest(c echo.Context) (service.FilterWriteParams, error) {
	var req filterWriteRequest
	if err := c.Bind(&req); err != nil {
		return service.FilterWriteParams{}, errors.New("invalid request")
	}

	params := service.FilterWriteParams{
		Name:      req.Name,
		Enabled:   req.Enabled,
		Position:  req.Position,
		Kind:      req.Kind,
		ScopeType: req.ScopeType,
		Actions:   toFilterActions(req.Actions),
	}

	if req.ScopeID != nil && *req.ScopeID != "" {
		scopeID, err := strconv.ParseInt(*req.ScopeID, 10, 64)
		if err != nil || scopeID <= 0 {
			return service.FilterWriteParams{}, errors.New("invalid scopeId")
		}
		params.ScopeID = &scopeID
	}

	conditions := make([]model.FilterCondition, len(req.Conditions))
	for i, condition := range req.Conditions {
		conditions[i] = model.FilterCondition{
			Logic:    condition.Logic,
			Negate:   condition.Negate,
			Field:    condition.Field,
			Operator: condition.Operator,
			Value:    condition.Value,
		}
	}
	params.Conditions = conditions

	return params, nil
}

// writeFilterError 把规则相关的业务错误映射成 400/404/422（其余走通用映射）。
func writeFilterError(c echo.Context, err error) error {
	switch {
	case errors.Is(err, service.ErrFilterNotFound), errors.Is(err, service.ErrEntryNotFound):
		return c.JSON(http.StatusNotFound, errorResponse{Error: "not found"})
	case errors.Is(err, service.ErrAIUnavailable):
		// 前端据此提示「先去 设置 → AI 配好 provider / API key / model」
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "ai_not_configured"})
	case errors.Is(err, service.ErrAIDraftInvalid):
		return c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "ai_draft_invalid"})
	case errors.Is(err, service.ErrInvalidFilter):
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid filter"})
	default:
		return writeServiceError(c, err)
	}
}

func toFilterResponse(filter model.Filter) filterResponse {
	kind := filter.Kind
	if kind == "" {
		kind = model.FilterKindRule
	}
	response := filterResponse{
		ID:         idToString(filter.ID),
		Name:       filter.Name,
		Enabled:    filter.Enabled,
		Position:   filter.Position,
		Kind:       kind,
		ScopeType:  filter.ScopeType,
		ScopeID:    idPtrToString(filter.ScopeID),
		Actions:    toActionsPayload(filter.Actions),
		MatchCount: filter.MatchCount,
		CreatedAt:  filter.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:  filter.UpdatedAt.UTC().Format(time.RFC3339),
	}
	response.Conditions = make([]filterConditionRequest, len(filter.Conditions))
	for i, condition := range filter.Conditions {
		response.Conditions[i] = filterConditionRequest{
			Logic:    condition.Logic,
			Negate:   condition.Negate,
			Field:    condition.Field,
			Operator: condition.Operator,
			Value:    condition.Value,
		}
	}
	if filter.LastMatchedAt != nil {
		formatted := filter.LastMatchedAt.UTC().Format(time.RFC3339)
		response.LastMatchedAt = &formatted
	}
	if filter.LastError != nil && *filter.LastError != "" {
		message := *filter.LastError
		response.LastError = &message
	}
	if filter.LastErrorAt != nil {
		formatted := filter.LastErrorAt.UTC().Format(time.RFC3339)
		response.LastErrorAt = &formatted
	}
	return response
}

func toActionsPayload(actions model.FilterActions) filterActionsPayload {
	return filterActionsPayload{
		Mute:       actions.Mute,
		Unmute:     actions.Unmute,
		MarkRead:   actions.MarkRead,
		MarkUnread: actions.MarkUnread,
		Star:       actions.Star,
		Unstar:     actions.Unstar,
		KeepOnly:   actions.KeepOnly,
		Translate:  actions.Translate,
		Summarize:  actions.Summarize,
		Webhook:    actions.Webhook,
		WebhookURL: actions.WebhookURL,
		Notify:     actions.Notify,
		NotifyURL:  actions.NotifyURL,
	}
}

func toFilterActions(payload filterActionsPayload) model.FilterActions {
	return model.FilterActions{
		Mute:       payload.Mute,
		Unmute:     payload.Unmute,
		MarkRead:   payload.MarkRead,
		MarkUnread: payload.MarkUnread,
		Star:       payload.Star,
		Unstar:     payload.Unstar,
		KeepOnly:   payload.KeepOnly,
		Translate:  payload.Translate,
		Summarize:  payload.Summarize,
		Webhook:    payload.Webhook,
		WebhookURL: strings.TrimSpace(payload.WebhookURL),
		Notify:     payload.Notify,
		NotifyURL:  strings.TrimSpace(payload.NotifyURL),
	}
}
