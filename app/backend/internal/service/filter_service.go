//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/pkg/logger"
)

var (
	ErrFilterNotFound = errors.New("filter not found")
	ErrInvalidFilter  = errors.New("invalid filter")
)

// 命中审计只保留最近这么多条（防止超大实例把审计表养肥）
const filterMatchRetention = 5000

// FilterWriteParams 新建/编辑规则的入参（Handler 校验后进来）。
type FilterWriteParams struct {
	Name       string                  `json:"name"`
	Enabled    *bool                   `json:"enabled"`
	Position   *int                    `json:"position"`
	ScopeType  string                  `json:"scopeType"`
	ScopeID    *int64                  `json:"scopeId"`
	Conditions []model.FilterCondition `json:"conditions"`
	Actions    model.FilterActions     `json:"actions"`
}

// FilterPreviewItem 预览里的一条命中。
type FilterPreviewItem struct {
	ID          int64               `json:"id"`
	Title       string              `json:"title"`
	FeedTitle   string              `json:"feedTitle"`
	PublishedAt *time.Time          `json:"publishedAt"`
	Actions     model.FilterActions `json:"actions"`
}

// FilterPreviewResult 干跑结果：扫了多少条、命中哪些、各动作会影响多少条。
type FilterPreviewResult struct {
	Scanned       int                 `json:"scanned"`
	MatchedCount  int                 `json:"matchedCount"`
	MuteCount     int                 `json:"muteCount"`
	MarkReadCount int                 `json:"markReadCount"`
	StarCount     int                 `json:"starCount"`
	Matched       []FilterPreviewItem `json:"matched"`
}

// EntryContext 一条条目在求值时可用的全部事实。
type EntryContext struct {
	Title        string
	Content      string
	Author       string
	URL          string
	PublishedAt  *time.Time
	FeedTitle    string
	FeedURL      string
	FeedType     string
	FolderName   string
	HasThumbnail bool
	Read         bool
	Starred      bool
}

type FilterService interface {
	List(ctx context.Context) ([]model.Filter, error)
	Create(ctx context.Context, params FilterWriteParams) (model.Filter, error)
	Update(ctx context.Context, id int64, params FilterWriteParams) (model.Filter, error)
	Delete(ctx context.Context, id int64, revert bool) (int64, error)
	Preview(ctx context.Context, params FilterWriteParams, limit int) (FilterPreviewResult, error)
	// ApplyToEntries 对「本次刚入库的新条目」执行规则：首个命中即停，命中即写标记 + 审计 + 计数。
	ApplyToEntries(ctx context.Context, feed model.Feed, entries []model.Entry) (int, error)
	// Revert 把某条规则静音过的条目恢复（muted 清掉，被它标已读的退回未读）。
	Revert(ctx context.Context, filterID int64) (int64, error)
	ListMatches(ctx context.Context, filterID int64, limit int) ([]model.FilterMatch, error)
}

type filterService struct {
	filters repository.FilterRepository
	entries repository.EntryRepository
	feeds   repository.FeedRepository
	folders repository.FolderRepository
}

func NewFilterService(
	filters repository.FilterRepository,
	entries repository.EntryRepository,
	feeds repository.FeedRepository,
	folders repository.FolderRepository,
) FilterService {
	return &filterService{filters: filters, entries: entries, feeds: feeds, folders: folders}
}

func (s *filterService) List(ctx context.Context) ([]model.Filter, error) {
	return s.filters.List(ctx)
}

func (s *filterService) Create(ctx context.Context, params FilterWriteParams) (model.Filter, error) {
	if err := ValidateFilterParams(params); err != nil {
		return model.Filter{}, err
	}
	filter := model.Filter{
		Name:       strings.TrimSpace(params.Name),
		Enabled:    true,
		Position:   0,
		ScopeType:  params.ScopeType,
		ScopeID:    params.ScopeID,
		Conditions: params.Conditions,
		Actions:    params.Actions,
	}
	if filter.ScopeType == "" {
		filter.ScopeType = model.FilterScopeAll
	}
	if params.Enabled != nil {
		filter.Enabled = *params.Enabled
	}
	if params.Position != nil {
		filter.Position = *params.Position
	} else {
		// 新规则排在最后（首个命中即停 → 越靠前优先级越高）
		existing, err := s.filters.List(ctx)
		if err == nil {
			filter.Position = len(existing)
		}
	}
	created, err := s.filters.Create(ctx, filter)
	if err != nil {
		return model.Filter{}, err
	}
	logger.Info("filter created", "module", "service", "action", "create", "resource", "filter", "result", "ok", "filter_id", created.ID)
	return created, nil
}

func (s *filterService) Update(ctx context.Context, id int64, params FilterWriteParams) (model.Filter, error) {
	if err := ValidateFilterParams(params); err != nil {
		return model.Filter{}, err
	}
	current, err := s.filters.GetByID(ctx, id)
	if err != nil {
		return model.Filter{}, ErrFilterNotFound
	}
	current.Name = strings.TrimSpace(params.Name)
	current.ScopeType = params.ScopeType
	if current.ScopeType == "" {
		current.ScopeType = model.FilterScopeAll
	}
	current.ScopeID = params.ScopeID
	current.Conditions = params.Conditions
	current.Actions = params.Actions
	if params.Enabled != nil {
		current.Enabled = *params.Enabled
	}
	if params.Position != nil {
		current.Position = *params.Position
	}
	if err := s.filters.Update(ctx, current); err != nil {
		return model.Filter{}, err
	}
	logger.Info("filter updated", "module", "service", "action", "update", "resource", "filter", "result", "ok", "filter_id", id)
	return s.filters.GetByID(ctx, id)
}

// Delete 删除规则。revert=true 时顺带把这条规则静音的条目恢复未读。
func (s *filterService) Delete(ctx context.Context, id int64, revert bool) (int64, error) {
	if _, err := s.filters.GetByID(ctx, id); err != nil {
		return 0, ErrFilterNotFound
	}
	var reverted int64
	if revert {
		var err error
		reverted, err = s.Revert(ctx, id)
		if err != nil {
			return 0, err
		}
	}
	if err := s.filters.Delete(ctx, id); err != nil {
		return 0, err
	}
	logger.Info("filter deleted", "module", "service", "action", "delete", "resource", "filter", "result", "ok", "filter_id", id, "reverted", reverted)
	return reverted, nil
}

// Preview 干跑：不写任何数据，只回答「这条规则会命中哪些、会影响多少条」。
func (s *filterService) Preview(ctx context.Context, params FilterWriteParams, limit int) (FilterPreviewResult, error) {
	if err := ValidateFilterParams(params); err != nil {
		return FilterPreviewResult{}, err
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}

	now := time.Now()
	result := FilterPreviewResult{Matched: make([]FilterPreviewItem, 0)}

	feedByID, folderNames, err := s.loadFeedContext(ctx)
	if err != nil {
		return FilterPreviewResult{}, err
	}

	entries, err := s.entries.List(ctx, scopeListFilter(params, limit))
	if err != nil {
		return FilterPreviewResult{}, err
	}

	for _, entry := range entries {
		feed := feedByID[entry.FeedID]
		if !scopeMatches(params.ScopeType, params.ScopeID, feed) {
			continue
		}
		result.Scanned++
		entryCtx := buildEntryContext(entry, feed, folderNames)
		effective, applies := ResolveActions(MatchConditions(entryCtx, params.Conditions, now), params.Actions)
		if !applies {
			continue
		}
		result.MatchedCount++
		if effective.AffectsMute() {
			result.MuteCount++
		}
		if effective.MarkRead {
			result.MarkReadCount++
		}
		if effective.Star {
			result.StarCount++
		}
		if len(result.Matched) < 50 {
			title := ""
			if entry.Title != nil {
				title = *entry.Title
			}
			result.Matched = append(result.Matched, FilterPreviewItem{
				ID:          entry.ID,
				Title:       title,
				FeedTitle:   feed.Title,
				PublishedAt: entry.PublishedAt,
				Actions:     effective,
			})
		}
	}

	return result, nil
}

// ApplyToEntries 规则引擎的执行入口（在 saveEntries 之后、只对刚入库的新条目调用）。
func (s *filterService) ApplyToEntries(ctx context.Context, feed model.Feed, entries []model.Entry) (int, error) {
	if len(entries) == 0 {
		return 0, nil
	}

	all, err := s.filters.List(ctx)
	if err != nil {
		return 0, err
	}

	candidates := make([]model.Filter, 0, len(all))
	for _, filter := range all {
		if !filter.Enabled || len(filter.Conditions) == 0 && filter.Actions.IsEmpty() {
			continue
		}
		if !scopeMatches(filter.ScopeType, filter.ScopeID, feed) {
			continue
		}
		candidates = append(candidates, filter)
	}
	if len(candidates) == 0 {
		return 0, nil
	}

	hashes := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Hash != "" {
			hashes = append(hashes, entry.Hash)
		}
	}
	idsByHash, err := s.entries.GetIDsByHashes(ctx, feed.ID, hashes)
	if err != nil {
		return 0, err
	}

	_, folderNames, err := s.loadFeedContext(ctx)
	if err != nil {
		return 0, err
	}

	now := time.Now()
	applied := 0
	stats := make(map[int64]int64, len(candidates))

	for _, entry := range entries {
		entryID, ok := idsByHash[entry.Hash]
		if !ok {
			continue
		}
		entryCtx := buildEntryContext(entry, feed, folderNames)
		for _, filter := range candidates {
			effective, applies := ResolveActions(MatchConditions(entryCtx, filter.Conditions, now), filter.Actions)
			if !applies {
				continue
			}
			if err := s.entries.ApplyFilterState(ctx, entryID, buildFilterState(effective, filter.ID)); err != nil {
				logger.Warn("apply filter state failed", "module", "service", "action", "apply", "resource", "filter", "result", "failed", "filter_id", filter.ID, "entry_id", entryID, "error", err)
				continue
			}
			if err := s.filters.RecordMatch(ctx, model.FilterMatch{
				FilterID:  filter.ID,
				EntryID:   entryID,
				Actions:   effective,
				CreatedAt: now,
			}); err != nil {
				logger.Warn("record filter match failed", "module", "service", "action", "record", "resource", "filter", "result", "failed", "filter_id", filter.ID, "entry_id", entryID, "error", err)
			}
			stats[filter.ID]++
			applied++
			// 首个命中即停：一条条目只由顺序最靠前的那条规则处理
			break
		}
	}

	if err := s.filters.BumpMatchStats(ctx, stats, now); err != nil {
		logger.Warn("bump filter stats failed", "module", "service", "action", "update", "resource", "filter", "result", "failed", "error", err)
	}
	if applied > 0 {
		if err := s.filters.PruneMatches(ctx, filterMatchRetention); err != nil {
			logger.Warn("prune filter matches failed", "module", "service", "action", "prune", "resource", "filter", "result", "failed", "error", err)
		}
		logger.Info("filter applied", "module", "service", "action", "apply", "resource", "filter", "result", "ok", "feed_id", feed.ID, "applied", applied)
	}
	return applied, nil
}

// Revert 撤销某条规则写入的标记（只影响「当前仍归这条规则」的条目）。
func (s *filterService) Revert(ctx context.Context, filterID int64) (int64, error) {
	matched, err := s.filters.ListMatchedEntryIDs(ctx, filterID, 10000)
	if err != nil {
		return 0, err
	}
	if len(matched) == 0 {
		return 0, nil
	}

	restoreUnread := make([]int64, 0, len(matched))
	keepRead := make([]int64, 0, len(matched))
	for _, item := range matched {
		// 规则当初把条目标成已读/静音 → 撤销时要退回未读；只加星之类的不动已读位
		if item.Actions.AffectsMute() || item.Actions.MarkRead {
			restoreUnread = append(restoreUnread, item.EntryID)
			continue
		}
		keepRead = append(keepRead, item.EntryID)
	}

	var reverted int64
	if len(restoreUnread) > 0 {
		count, err := s.entries.ResetFilterState(ctx, restoreUnread, true)
		if err != nil {
			return reverted, err
		}
		reverted += count
	}
	if len(keepRead) > 0 {
		count, err := s.entries.ResetFilterState(ctx, keepRead, false)
		if err != nil {
			return reverted, err
		}
		reverted += count
	}
	logger.Info("filter reverted", "module", "service", "action", "revert", "resource", "filter", "result", "ok", "filter_id", filterID, "reverted", reverted)
	return reverted, nil
}

func (s *filterService) ListMatches(ctx context.Context, filterID int64, limit int) ([]model.FilterMatch, error) {
	return s.filters.ListMatches(ctx, filterID, limit)
}

// loadFeedContext 取订阅元数据与分类名（条件里要用 feed 标题/类型/分类名）。
func (s *filterService) loadFeedContext(ctx context.Context) (map[int64]model.Feed, map[int64]string, error) {
	feeds, err := s.feeds.List(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	feedByID := make(map[int64]model.Feed, len(feeds))
	for _, feed := range feeds {
		feedByID[feed.ID] = feed
	}

	folderNames := make(map[int64]string)
	if s.folders != nil {
		if folders, err := s.folders.List(ctx); err == nil {
			for _, folder := range folders {
				folderNames[folder.ID] = folder.Name
			}
		}
	}
	return feedByID, folderNames, nil
}

// —— 纯函数部分（可单测） ——

// ScopeMatches 判断规则的作用范围是否覆盖这个订阅。
func ScopeMatches(filter model.Filter, feed model.Feed) bool {
	return scopeMatches(filter.ScopeType, filter.ScopeID, feed)
}

func scopeMatches(scopeType string, scopeID *int64, feed model.Feed) bool {
	switch scopeType {
	case model.FilterScopeFeed:
		return scopeID != nil && *scopeID == feed.ID
	case model.FilterScopeFolder:
		return scopeID != nil && feed.FolderID != nil && *scopeID == *feed.FolderID
	default:
		return true
	}
}

// MatchConditions 求值条件链：条件之间按各自的 logic（and/or）折叠，空条件视为命中。
func MatchConditions(entry EntryContext, conditions []model.FilterCondition, now time.Time) bool {
	if len(conditions) == 0 {
		return true
	}
	result := false
	for index, condition := range conditions {
		value := evaluateCondition(entry, condition, now)
		if index == 0 || condition.Logic == "" || condition.Logic == "and" {
			if index == 0 {
				result = value
			} else {
				result = result && value
			}
			continue
		}
		if condition.Logic == "or" {
			result = result || value
			continue
		}
		result = result && value
	}
	return result
}

// ResolveActions 给出这条规则对当前条目的「实际动作」，以及是否真的生效。
// keepOnly（只保留匹配）在不命中时退化为静音 —— 这是它唯一的分支。
func ResolveActions(matched bool, actions model.FilterActions) (model.FilterActions, bool) {
	if matched {
		effective := actions
		effective.KeepOnly = false
		if effective.IsEmpty() {
			return model.FilterActions{}, false
		}
		return effective, true
	}
	if actions.KeepOnly {
		return model.FilterActions{Mute: true}, true
	}
	return model.FilterActions{}, false
}

func evaluateCondition(entry EntryContext, condition model.FilterCondition, now time.Time) bool {
	var matched bool
	switch condition.Field {
	case model.FilterFieldTitle:
		matched = matchText(entry.Title, condition)
	case model.FilterFieldContent:
		matched = matchText(entry.Content, condition)
	case model.FilterFieldAuthor:
		matched = matchText(entry.Author, condition)
	case model.FilterFieldURL:
		matched = matchText(entry.URL, condition)
	case model.FilterFieldFeedTitle:
		matched = matchText(entry.FeedTitle, condition)
	case model.FilterFieldFeedURL:
		matched = matchText(entry.FeedURL, condition)
	case model.FilterFieldFeedType:
		matched = matchText(entry.FeedType, condition)
	case model.FilterFieldFolder:
		matched = matchText(entry.FolderName, condition)
	case model.FilterFieldPublishedAt:
		matched = matchDate(entry.PublishedAt, condition, now)
	case model.FilterFieldHasThumbnail:
		matched = matchBool(entry.HasThumbnail, condition)
	case model.FilterFieldIsRead:
		matched = matchBool(entry.Read, condition)
	case model.FilterFieldIsStarred:
		matched = matchBool(entry.Starred, condition)
	default:
		matched = false
	}
	if condition.Negate {
		return !matched
	}
	return matched
}

func matchText(value string, condition model.FilterCondition) bool {
	switch condition.Operator {
	case model.FilterOpIsEmpty:
		return strings.TrimSpace(value) == ""
	case model.FilterOpIsNotEmpty:
		return strings.TrimSpace(value) != ""
	case model.FilterOpRegex:
		pattern, err := regexp.Compile(condition.Value)
		if err != nil {
			return false
		}
		return pattern.MatchString(value)
	case model.FilterOpExact:
		return strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(condition.Value))
	default: // contains
		return strings.Contains(strings.ToLower(value), strings.ToLower(condition.Value))
	}
}

func matchDate(published *time.Time, condition model.FilterCondition, now time.Time) bool {
	if published == nil {
		return false
	}
	value := published.UTC()
	switch condition.Operator {
	case model.FilterOpIsFuture:
		return value.After(now)
	case model.FilterOpBefore:
		reference, ok := parseDateValue(condition.Value)
		return ok && value.Before(reference)
	case model.FilterOpAfter:
		reference, ok := parseDateValue(condition.Value)
		return ok && value.After(reference)
	case model.FilterOpOlderThan:
		duration, ok := parseDurationValue(condition.Value)
		return ok && now.Sub(value) > duration
	default:
		return false
	}
}

func matchBool(value bool, condition model.FilterCondition) bool {
	expected, ok := parseBoolValue(condition.Value)
	if !ok {
		return false
	}
	return value == expected
}

func parseBoolValue(raw string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true", "1", "yes", "on", "是":
		return true, true
	case "false", "0", "no", "off", "否":
		return false, true
	default:
		return false, false
	}
}

func parseDateValue(raw string) (time.Time, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{"2006-01-02", time.RFC3339, "2006-01"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

// parseDurationValue 支持 30d / 12h / 90m 这类写法（d 按 24 小时折算）。
func parseDurationValue(raw string) (time.Duration, bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return 0, false
	}
	if strings.HasSuffix(value, "d") {
		days, err := time.ParseDuration(strings.TrimSuffix(value, "d") + "h")
		if err != nil {
			return 0, false
		}
		return days * 24, true
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return 0, false
	}
	return duration, true
}

// buildEntryContext 把条目 + 订阅元数据摊平成求值上下文。
func buildEntryContext(entry model.Entry, feed model.Feed, folderNames map[int64]string) EntryContext {
	context := EntryContext{
		FeedTitle: feed.Title,
		FeedURL:   feed.URL,
		FeedType:  feed.Type,
		Read:      entry.Read,
		Starred:   entry.Starred,
	}
	if entry.Title != nil {
		context.Title = *entry.Title
	}
	if entry.Content != nil {
		context.Content = *entry.Content
	}
	if entry.Author != nil {
		context.Author = *entry.Author
	}
	if entry.URL != nil {
		context.URL = *entry.URL
	}
	context.PublishedAt = entry.PublishedAt
	context.HasThumbnail = entry.ThumbnailURL != nil && *entry.ThumbnailURL != ""
	if feed.FolderID != nil {
		context.FolderName = folderNames[*feed.FolderID]
	}
	return context
}

// buildFilterState 把动作翻成要写到 entries 上的标记。
func buildFilterState(actions model.FilterActions, filterID int64) repository.EntryFilterState {
	state := repository.EntryFilterState{FilterID: filterID}

	switch {
	case actions.Unmute:
		state.Muted = false
	case actions.AffectsMute():
		state.Muted = true
	}

	switch {
	case actions.MarkRead:
		value := true
		state.Read = &value
	case actions.MarkUnread:
		value := false
		state.Read = &value
	case state.Muted:
		// 静音的语义：入库即已读（不进未读计数，但可在「已静音」里回看）
		value := true
		state.Read = &value
	case actions.Unmute:
		// 取消静音：让内容重新回到未读流里
		value := false
		state.Read = &value
	}

	switch {
	case actions.Star:
		value := true
		state.Starred = &value
	case actions.Unstar:
		value := false
		state.Starred = &value
	}

	return state
}

// scopeListFilter 预览时按作用范围取最近 N 条（包含已静音条目，便于看清规则全貌）。
func scopeListFilter(params FilterWriteParams, limit int) repository.EntryListFilter {
	filter := repository.EntryListFilter{Limit: limit, IncludeMuted: true}
	switch params.ScopeType {
	case model.FilterScopeFeed:
		filter.FeedID = params.ScopeID
	case model.FilterScopeFolder:
		filter.FolderID = params.ScopeID
	}
	return filter
}

// ValidateFilterParams 校验规则入参（Handler 与 Service 共用）。
func ValidateFilterParams(params FilterWriteParams) error {
	if strings.TrimSpace(params.Name) == "" {
		return ErrInvalidFilter
	}
	if len([]rune(strings.TrimSpace(params.Name))) > 60 {
		return ErrInvalidFilter
	}
	switch params.ScopeType {
	case "", model.FilterScopeAll:
	case model.FilterScopeFolder, model.FilterScopeFeed:
		if params.ScopeID == nil || *params.ScopeID == 0 {
			return ErrInvalidFilter
		}
	default:
		return ErrInvalidFilter
	}
	if params.Actions.IsEmpty() {
		return ErrInvalidFilter
	}
	if params.Actions.Mute && params.Actions.Unmute {
		return ErrInvalidFilter
	}
	if params.Actions.MarkRead && params.Actions.MarkUnread {
		return ErrInvalidFilter
	}
	if params.Actions.Star && params.Actions.Unstar {
		return ErrInvalidFilter
	}
	for _, condition := range params.Conditions {
		if !containsString(model.FilterConditionFields, condition.Field) {
			return ErrInvalidFilter
		}
		if !containsString(model.FilterConditionOperators, condition.Operator) {
			return ErrInvalidFilter
		}
		if requiresValue(condition.Operator) && strings.TrimSpace(condition.Value) == "" {
			return ErrInvalidFilter
		}
		if condition.Operator == model.FilterOpRegex {
			if _, err := regexp.Compile(condition.Value); err != nil {
				return ErrInvalidFilter
			}
		}
		if condition.Logic != "" && condition.Logic != "and" && condition.Logic != "or" {
			return ErrInvalidFilter
		}
	}
	return nil
}

func requiresValue(operator string) bool {
	switch operator {
	case model.FilterOpIsEmpty, model.FilterOpIsNotEmpty, model.FilterOpIsFuture:
		return false
	default:
		return true
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
