package handler

import (
	"errors"
	"net/http"
	"strconv"
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
	g.PATCH("/filters/:id", h.Update)
	g.DELETE("/filters/:id", h.Delete)
	g.POST("/filters/preview", h.Preview)
	g.POST("/filters/:id/apply", h.ApplyToHistory)
	g.POST("/filters/:id/revert", h.Revert)
	g.GET("/filters/:id/matches", h.ListMatches)
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
}

type filterWriteRequest struct {
	Name       string                   `json:"name"`
	Enabled    *bool                    `json:"enabled"`
	Position   *int                     `json:"position"`
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
	ScopeType     string                   `json:"scopeType"`
	ScopeID       *string                  `json:"scopeId,omitempty"`
	Conditions    []filterConditionRequest `json:"conditions"`
	Actions       filterActionsPayload     `json:"actions"`
	MatchCount    int64                    `json:"matchCount"`
	LastMatchedAt *string                  `json:"lastMatchedAt,omitempty"`
	CreatedAt     string                   `json:"createdAt"`
	UpdatedAt     string                   `json:"updatedAt"`
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

// writeFilterError 把规则相关的业务错误映射成 400/404（其余走通用映射）。
func writeFilterError(c echo.Context, err error) error {
	switch {
	case errors.Is(err, service.ErrFilterNotFound):
		return c.JSON(http.StatusNotFound, errorResponse{Error: "filter not found"})
	case errors.Is(err, service.ErrInvalidFilter):
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid filter"})
	default:
		return writeServiceError(c, err)
	}
}

func toFilterResponse(filter model.Filter) filterResponse {
	response := filterResponse{
		ID:         idToString(filter.ID),
		Name:       filter.Name,
		Enabled:    filter.Enabled,
		Position:   filter.Position,
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
	}
}
