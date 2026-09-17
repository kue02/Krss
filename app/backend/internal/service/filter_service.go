//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/pkg/logger"
	"gist/backend/pkg/network"
)

// 规则的 last_error 用前缀区分来源：只清掉「上一次属于自己」的那条，别互相覆盖。
const (
	webhookErrorPrefix = "webhook 投递失败："
	notifyErrorPrefix  = "推送失败："
	aiErrorPrefix      = "AI 判定："
)

var (
	ErrFilterNotFound = errors.New("filter not found")
	ErrInvalidFilter  = errors.New("invalid filter")
	// ErrAIUnavailable：AI 未配置（自然语言建规则要用）；ErrAIDraftInvalid：模型输出没法用。
	ErrAIUnavailable  = errors.New("ai unavailable")
	ErrAIDraftInvalid = errors.New("ai draft invalid")
	ErrEntryNotFound  = errors.New("entry not found")
)

// 命中审计只保留最近这么多条（防止超大实例把审计表养肥）
const filterMatchRetention = 5000

// FilterWriteParams 新建/编辑规则的入参（Handler 校验后进来）。
type FilterWriteParams struct {
	Name       string                  `json:"name"`
	Enabled    *bool                   `json:"enabled"`
	Position   *int                    `json:"position"`
	Kind       string                  `json:"kind"`
	ScopeType string `json:"scopeType"`
	ScopeID   *int64 `json:"scopeId"`
	// ScopeIDs 多选订阅（scope_type=feed；空 = 用 ScopeID 的单个）。用户 11-16：规则范围里订阅可多选。
	ScopeIDs []int64 `json:"scopeIds"`
	// ContentTypes 视图只在哪些内容类型下显示（空 = 都显示）。用户 11-5。
	ContentTypes []string `json:"contentTypes"`
	// Icon 视图自定义图标：`builtin:<key>` / `emoji:<字符>` / `data:image/...`（用户 11-5）。
	Icon string `json:"icon"`
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
	// AIChecked / AISkipped：这次预览里 AI 条件是「吃了缓存判定」还是「没判成」（预览绝不新发起模型调用）
	AIChecked     int                 `json:"aiChecked"`
	AISkipped     int                 `json:"aiSkipped"`
	AISkipReasons []string            `json:"aiSkipReasons"`
	Matched       []FilterPreviewItem `json:"matched"`
}

// EntryContext 一条条目在求值时可用的全部事实。
type EntryContext struct {
	// ID 条目 id（AI 条件按它做判定缓存）
	ID           int64
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

// AIVerdictFunc 由调用方注入的 AI 判定：返回 (是否相关, 这次到底判没判成)。
// nil 或 ok=false 都按「不命中」处理 —— 引擎不猜。
type AIVerdictFunc func(entry EntryContext, question string) (bool, bool)

type FilterService interface {
	List(ctx context.Context) ([]model.Filter, error)
	Create(ctx context.Context, params FilterWriteParams) (model.Filter, error)
	Update(ctx context.Context, id int64, params FilterWriteParams) (model.Filter, error)
	Delete(ctx context.Context, id int64, revert bool) (int64, error)
	Preview(ctx context.Context, params FilterWriteParams, limit int) (FilterPreviewResult, error)
	// CountViewMatches 数每条「视图」（filters.kind = view）当前命中的条目数 —— 侧栏「收藏 / 视图」的数量角标用。
	// contentType 非 nil 时只数该内容类型（与列表跟进当前内容类型的行为一致）。
	CountViewMatches(ctx context.Context, contentType *string) (map[int64]int, error)
	// ApplyToEntries 对「本次刚入库的新条目」执行规则：首个命中即停，命中即写标记 + 审计 + 计数。
	ApplyToEntries(ctx context.Context, feed model.Feed, entries []model.Entry) (int, error)
	// ApplyToHistory 手动回溯：把规则链补跑到某条规则作用域内的历史条目上（幂等）。
	ApplyToHistory(ctx context.Context, filterID int64, limit int) (scanned int, applied int, err error)
	// Revert 把某条规则静音过的条目恢复（muted 清掉，被它标已读的退回未读）。
	Revert(ctx context.Context, filterID int64) (int64, error)
	ListMatches(ctx context.Context, filterID int64, limit int) ([]model.FilterMatch, error)
	// ParseNaturalLanguage 用 AI 把一句人话翻成规则草稿（不落库；由编辑器确认后再保存）。
	ParseNaturalLanguage(ctx context.Context, text string) (FilterDraft, error)
	// TestNotify 按当前设置发一条测试推送（设置页「发送测试推送」用），走的是与规则同一条通道，
	// 所以它通了就说明地址、代理、出网都对。
	TestNotify(ctx context.Context) (int, error)
	// CreateException 条目级「豁免这类内容」：建一条顺序最靠前、只做反向动作的例外规则，
	// 并把这一条立刻放回未读流。
	CreateException(ctx context.Context, entryID int64) (model.Filter, error)
}

type filterService struct {
	filters  repository.FilterRepository
	entries  repository.EntryRepository
	feeds    repository.FeedRepository
	folders  repository.FolderRepository
	ai       AICompleter
	webhook  FilterWebhookSender
	notify   NotifyService
	governor *aiJudgeGovernor
}

// FilterServiceDeps 依赖（AI 与 webhook 可为 nil：没有就分别是「AI 条件判不成」与「webhook 不可用」）。
type FilterServiceDeps struct {
	Filters repository.FilterRepository
	Entries repository.EntryRepository
	Feeds   repository.FeedRepository
	Folders repository.FolderRepository
	AI      AICompleter
	Webhook FilterWebhookSender
	// Notify 推送通道（Bark）：nil = 推送不可用（规则会明确报错，不会静默成功）
	Notify NotifyService
}

func NewFilterService(deps FilterServiceDeps) FilterService {
	return &filterService{
		filters:  deps.Filters,
		entries:  deps.Entries,
		feeds:    deps.Feeds,
		folders:  deps.Folders,
		ai:       deps.AI,
		webhook:  deps.Webhook,
		notify:   deps.Notify,
		governor: &aiJudgeGovernor{},
	}
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
		Kind:       normalizeKind(params.Kind),
		ScopeType:  params.ScopeType,
		ScopeID:    params.ScopeID,
		ScopeIDs:     normalizeScopeIDs(params.ScopeIDs),
		ContentTypes: normalizeViewContentTypes(params.ContentTypes),
		Icon:         normalizeViewIcon(params.Kind, params.Icon),
		Conditions:   params.Conditions,
		Actions:    effectiveActions(params.Kind, params.Actions),
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
	current.Kind = normalizeKind(params.Kind)
	current.ScopeType = params.ScopeType
	if current.ScopeType == "" {
		current.ScopeType = model.FilterScopeAll
	}
	current.ScopeID = params.ScopeID
	current.ScopeIDs = normalizeScopeIDs(params.ScopeIDs)
	current.ContentTypes = normalizeViewContentTypes(params.ContentTypes)
	current.Icon = normalizeViewIcon(params.Kind, params.Icon)
	current.Conditions = params.Conditions
	current.Actions = effectiveActions(params.Kind, params.Actions)
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

// contentTypeWhitelist 视图能绑的内容类型（与 handler 的参数白名单同一套语义）。
var contentTypeWhitelist = map[string]struct{}{
	"article": {}, "picture": {}, "notification": {}, "social": {},
}

// normalizeViewContentTypes 视图的「只在哪些内容类型下显示」：只留白名单内、去重；空 = 都显示。
func normalizeViewContentTypes(types []string) []string {
	if len(types) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(types))
	out := make([]string, 0, len(types))
	for _, item := range types {
		value := strings.TrimSpace(item)
		if _, ok := contentTypeWhitelist[value]; !ok {
			continue
		}
		if _, dup := seen[value]; dup {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// normalizeViewIcon 图标只在视图上有意义（规则行不显示图标）；
// 只认三种前缀，别把任意字符串塞进库里当图标——前端渲染不认识就白板。
func normalizeViewIcon(kind string, icon string) string {
	if normalizeKind(kind) != model.FilterKindView {
		return ""
	}
	value := strings.TrimSpace(icon)
	switch {
	case value == "":
		return ""
	case strings.HasPrefix(value, "builtin:"), strings.HasPrefix(value, "emoji:"):
		return value
	case strings.HasPrefix(value, "data:image/"):
		// 上传图标：与头像同一套（前端 128px 缩放后的 data URL），限长防超大数据入库
		if len(value) > 200_000 {
			return ""
		}
		return value
	default:
		return ""
	}
}

// normalizeScopeIDs 多选订阅集合：去重、丢掉非法值；空集合 = 「没多选」（回落到单个 scope_id）。
func normalizeScopeIDs(ids []int64) []int64 {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[int64]struct{}, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// normalizeKind 空值按 rule 处理（老数据与不带 kind 的调用都当规则）。
func normalizeKind(kind string) string {
	if kind == model.FilterKindView {
		return model.FilterKindView
	}
	return model.FilterKindRule
}

// effectiveActions 视图不执行任何动作（它只筛条目），存库前一律清空 —— 免得看着像会写数据。
func effectiveActions(kind string, actions model.FilterActions) model.FilterActions {
	if normalizeKind(kind) == model.FilterKindView {
		return model.FilterActions{}
	}
	return actions
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
// CountViewMatches 数每条「视图」当前命中的条目数（侧栏数量角标）。
//
// 语义刻意与「按视图取列表」（entryService.listByView）**逐条对齐**，否则数字和点进去看到的条数会对不上：
// 候选条目同样按内容类型过滤、默认隐藏被静音的条目、上限 viewCountScanLimit；
// 判定同样用 ScopeMatches + MatchConditions（AI 条件不注入求值函数 = 判不成，浏览侧不花钱）。
// 视图是个位数，所以一次把所有候选读出来再逐条对每个视图判定，比「每个视图各查一遍」省掉多次全量扫描。
func (s *filterService) CountViewMatches(ctx context.Context, contentType *string) (map[int64]int, error) {
	all, err := s.filters.List(ctx)
	if err != nil {
		return nil, err
	}
	views := make([]model.Filter, 0, len(all))
	for _, filter := range all {
		if filter.Kind == model.FilterKindView {
			views = append(views, filter)
		}
	}
	counts := make(map[int64]int, len(views))
	for _, view := range views {
		// 0 命中的视图也要出现在结果里：前端把它当「没有数字」渲染，
		// 但契约上「查不到这条视图」与「命中 0 条」是两回事，别让调用方猜。
		counts[view.ID] = 0
	}
	if len(views) == 0 {
		return counts, nil
	}

	feedByID, folderNames, err := s.loadFeedContext(ctx)
	if err != nil {
		return nil, err
	}

	candidates, err := s.entries.List(ctx, repository.EntryListFilter{
		ContentType: contentType,
		Limit:       viewCountScanLimit,
	})
	if err != nil {
		return nil, err
	}

	now := time.Now()
	for _, entry := range candidates {
		feed, ok := feedByID[entry.FeedID]
		if !ok {
			continue
		}
		entryCtx := buildEntryContext(entry, feed, folderNames)
		for _, view := range views {
			if !ScopeMatches(view, feed) {
				continue
			}
			if MatchConditions(entryCtx, view.Conditions, now, nil) {
				counts[view.ID]++
			}
		}
	}

	logger.Debug("filter view counts", "module", "service", "action", "count", "resource", "filter", "result", "ok",
		"views", len(views), "scanned", len(candidates))
	return counts, nil
}

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

	// 预览绝不新发起模型调用：AI 条件只吃已有判定缓存（否则按一下预览就花一笔钱）。
	aiRun := s.newAIJudgeRun(ctx, nil, true)

	for _, entry := range entries {
		feed := feedByID[entry.FeedID]
		if !scopeMatches(params.ScopeType, params.ScopeID, params.ScopeIDs, feed) {
			continue
		}
		result.Scanned++
		entryCtx := buildEntryContext(entry, feed, folderNames)
		conditionsMatched := MatchConditions(entryCtx, params.Conditions, now, aiRun.verdict)

		// 视图没有动作（存库前就被 effectiveActions 清空了），判定只能看条件本身 ——
		// 否则「预览」一个视图永远显示 0 命中（实测：条件在全库命中 628 条，预览却回 matchedCount: 0）。
		if normalizeKind(params.Kind) == model.FilterKindView {
			if !conditionsMatched {
				continue
			}
			result.MatchedCount++
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
				})
			}
			continue
		}

		effective, applies := ResolveActions(conditionsMatched, params.Actions)
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

	// AI 条件的预览口径：吃了几条缓存、多少条没判成（原因照抄给界面）
	result.AIChecked = len(result.Matched)
	if aiRun.short+aiRun.limited > 0 {
		result.AISkipped = aiRun.short + aiRun.limited
		if message := aiRun.message(); message != "" {
			result.AISkipReasons = []string{message}
		}
	}

	return result, nil
}

// ApplyToHistory 手动回溯：把规则链补跑到某条规则作用域内的历史条目上。
//
// 语义与增量执行一致 —— 按 position 顺序、首个命中即停；已经归命中的那条规则管的条目跳过
// （幂等，重复点不会重复计数）。上限 limit 取该作用域内最近的若干条，避免一次拖垮实例。
func (s *filterService) ApplyToHistory(ctx context.Context, filterID int64, limit int) (scanned int, applied int, err error) {
	rule, err := s.filters.GetByID(ctx, filterID)
	if err != nil {
		return 0, 0, ErrFilterNotFound
	}
	if limit <= 0 || limit > 2000 {
		limit = 500
	}

	all, err := s.filters.List(ctx)
	if err != nil {
		return 0, 0, err
	}
	candidates := make([]model.Filter, 0, len(all))
	for _, filter := range all {
		// 视图只筛条目、不执行动作：引擎完全跳过它
		if filter.Kind == model.FilterKindView {
			continue
		}
		if !filter.Enabled || len(filter.Conditions) == 0 && filter.Actions.IsEmpty() {
			continue
		}
		candidates = append(candidates, filter)
	}
	if len(candidates) == 0 {
		return 0, 0, nil
	}

	// 扫描范围 = 这条规则的作用域（分类 / 订阅 / 全部），含已静音条目（它们也要能被回溯修正）
	scope := repository.EntryListFilter{Limit: limit, IncludeMuted: true}
	switch rule.ScopeType {
	case model.FilterScopeFeed:
		scope.FeedID = rule.ScopeID
	case model.FilterScopeFolder:
		scope.FolderID = rule.ScopeID
	}
	entries, err := s.entries.List(ctx, scope)
	if err != nil {
		return 0, 0, err
	}

	feedByID, folderNames, err := s.loadFeedContext(ctx)
	if err != nil {
		return 0, 0, err
	}

	now := time.Now()
	stats := make(map[int64]int64, len(candidates))
	// AI 判定的额度整次运行共享；跳过与失败按规则分开记（原因要写回真正带 AI 条件的那条规则）
	budget := newAIJudgeBudget()
	runs := make(map[int64]*aiJudgeRun, len(candidates))
	for _, filter := range candidates {
		if hasAICondition(filter.Conditions) {
			runs[filter.ID] = s.newAIJudgeRun(ctx, budget, false)
		}
	}

	for _, entry := range entries {
		feed, ok := feedByID[entry.FeedID]
		if !ok {
			continue
		}
		scanned++
		entryCtx := buildEntryContext(entry, feed, folderNames)
		for _, filter := range candidates {
			if !scopeMatches(filter.ScopeType, filter.ScopeID, filter.ScopeIDs, feed) {
				continue
			}
			var judge AIVerdictFunc
			if run := runs[filter.ID]; run != nil {
				judge = run.verdict
			}
			effective, applies := ResolveActions(MatchConditions(entryCtx, filter.Conditions, now, judge), filter.Actions)
			if !applies {
				continue
			}
			// 幂等：已经归这条规则管的条目不再重复写（重复点回溯不该重复计数）
			if entry.FilterID != nil && *entry.FilterID == filter.ID {
				break
			}
			if err := s.entries.ApplyFilterState(ctx, entry.ID, buildFilterState(effective, filter.ID)); err != nil {
				logger.Warn("apply filter state failed", "module", "service", "action", "apply", "resource", "filter", "result", "failed", "filter_id", filter.ID, "entry_id", entry.ID, "error", err)
				break
			}
			if err := s.filters.RecordMatch(ctx, model.FilterMatch{
				FilterID:  filter.ID,
				EntryID:   entry.ID,
				Actions:   effective,
				CreatedAt: now,
			}); err != nil {
				logger.Warn("record filter match failed", "module", "service", "action", "record", "resource", "filter", "result", "failed", "filter_id", filter.ID, "entry_id", entry.ID, "error", err)
			}
			s.dispatchWebhook(ctx, filter, feed, entry, effective, now)
			// 推送同样是「要出网」的动作：异步发出，结果写回规则的 last_error
			s.dispatchNotify(ctx, filter, feed, entry, effective, now)
			stats[filter.ID]++
			applied++
			break
		}
	}

	if err := s.filters.BumpMatchStats(ctx, stats, now); err != nil {
		logger.Warn("bump filter stats failed", "module", "service", "action", "update", "resource", "filter", "result", "failed", "error", err)
	}
	// 这一轮回溯里参与过求值的规则（含被回溯的那条）都收到自己的 AI 判定情况：
	// 带 AI 条件的写回原因，判得成的清掉上一次的 AI 报错。
	for _, filter := range candidates {
		if run := runs[filter.ID]; run != nil {
			s.recordAIRunOutcome(ctx, filter, run)
		}
	}
	if applied > 0 {
		if err := s.filters.PruneMatches(ctx, filterMatchRetention); err != nil {
			logger.Warn("prune filter matches failed", "module", "service", "action", "prune", "resource", "filter", "result", "failed", "error", err)
		}
	}
	logger.Info("filter applied to history", "module", "service", "action", "apply", "resource", "filter", "result", "ok", "filter_id", filterID, "scanned", scanned, "applied", applied)
	return scanned, applied, nil
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
		// 视图只筛条目、不执行动作：引擎完全跳过它
		if filter.Kind == model.FilterKindView {
			continue
		}
		if !filter.Enabled || len(filter.Conditions) == 0 && filter.Actions.IsEmpty() {
			continue
		}
		if !scopeMatches(filter.ScopeType, filter.ScopeID, filter.ScopeIDs, feed) {
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
	// 入库路径同样：额度共享、原因按规则分开记
	budget := newAIJudgeBudget()
	runs := make(map[int64]*aiJudgeRun, len(candidates))
	for _, filter := range candidates {
		if hasAICondition(filter.Conditions) {
			runs[filter.ID] = s.newAIJudgeRun(ctx, budget, false)
		}
	}

	for _, entry := range entries {
		entryID, ok := idsByHash[entry.Hash]
		if !ok {
			continue
		}
		entryCtx := buildEntryContext(entry, feed, folderNames)
		for _, filter := range candidates {
			var judge AIVerdictFunc
			if run := runs[filter.ID]; run != nil {
				judge = run.verdict
			}
			effective, applies := ResolveActions(MatchConditions(entryCtx, filter.Conditions, now, judge), filter.Actions)
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
			// webhook / 推送是「要出网」的动作：异步投递，结果写回规则的 last_error
			entry.ID = entryID
			s.dispatchWebhook(ctx, filter, feed, entry, effective, now)
			s.dispatchNotify(ctx, filter, feed, entry, effective, now)
			stats[filter.ID]++
			applied++
			// 首个命中即停：一条条目只由顺序最靠前的那条规则处理
			break
		}
	}

	if err := s.filters.BumpMatchStats(ctx, stats, now); err != nil {
		logger.Warn("bump filter stats failed", "module", "service", "action", "update", "resource", "filter", "result", "failed", "error", err)
	}
	// 把这一轮的 AI 判定情况写回带 AI 条件的规则（成功就清掉上一次的 AI 报错）
	for _, filter := range candidates {
		run := runs[filter.ID]
		if run == nil {
			continue
		}
		s.recordAIRunOutcome(ctx, filter, run)
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
	return scopeMatches(filter.ScopeType, filter.ScopeID, filter.ScopeIDs, feed)
}

func scopeMatches(scopeType string, scopeID *int64, scopeIDs []int64, feed model.Feed) bool {
	switch scopeType {
	case model.FilterScopeFeed:
		// 多选订阅优先：集合里命中即可（用户 11-16）；没多选时沿用单个 scope_id
		if len(scopeIDs) > 0 {
			for _, id := range scopeIDs {
				if id == feed.ID {
					return true
				}
			}
			return false
		}
		return scopeID != nil && *scopeID == feed.ID
	case model.FilterScopeFolder:
		return scopeID != nil && feed.FolderID != nil && *scopeID == *feed.FolderID
	default:
		return true
	}
}

// MatchConditions 求值条件链：条件之间按各自的 logic（and/or）折叠，空条件视为命中。
// ai 为 nil 时 AI 条件一律不命中（AI 条件判不成就不猜）。
func MatchConditions(entry EntryContext, conditions []model.FilterCondition, now time.Time, ai AIVerdictFunc) bool {
	if len(conditions) == 0 {
		return true
	}
	result := false
	for index, condition := range conditions {
		value := evaluateCondition(entry, condition, now, ai)
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

func evaluateCondition(entry EntryContext, condition model.FilterCondition, now time.Time, ai AIVerdictFunc) bool {
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
	case model.FilterFieldAIRelevance:
		matched = matchAIRelevance(entry, condition, ai)
	default:
		matched = false
	}
	if condition.Negate {
		return !matched
	}
	return matched
}

// matchAIRelevance AI 条件：把 value 当作主题描述交给注入的判定函数。
// 判定没做成（ok=false）按「不命中」处理 —— 原因由调用方记录到规则的 last_error，不在这里造噪音。
func matchAIRelevance(entry EntryContext, condition model.FilterCondition, ai AIVerdictFunc) bool {
	question := strings.TrimSpace(condition.Value)
	if question == "" || ai == nil {
		return false
	}
	verdict, ok := ai(entry, question)
	if !ok {
		return false
	}
	return verdict
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
		ID:        entry.ID,
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

	// translate / summarize：只打「打开时自动翻译 / 自动摘要」的条目标记，此刻不花 AI token
	if actions.Translate {
		value := true
		state.AutoTranslate = &value
	}
	if actions.Summarize {
		value := true
		state.AutoSummary = &value
	}

	return state
}

// hasAICondition 这条规则里有没有 AI 条件（决定要不要把 AI 判定结果写回它）。
func hasAICondition(conditions []model.FilterCondition) bool {
	for _, condition := range conditions {
		if condition.Field == model.FilterFieldAIRelevance {
			return true
		}
	}
	return false
}

// recordAIRunOutcome 把这一轮 AI 判定的情况写回规则：
// 有因没判成（未配置 / 调用失败 / 正文过短 / 到上限）就记下原因，全判成了就清掉上一次的 AI 报错。
func (s *filterService) recordAIRunOutcome(ctx context.Context, filter model.Filter, run *aiJudgeRun) {
	if run == nil {
		return
	}
	if message := run.message(); message != "" {
		if err := s.filters.SetLastError(ctx, filter.ID, aiErrorPrefix+message, time.Now()); err != nil {
			logger.Warn("set filter ai error failed", "module", "service", "action", "update", "resource", "filter", "result", "failed", "filter_id", filter.ID, "error", err)
		}
		return
	}
	if filter.LastError != nil && strings.HasPrefix(*filter.LastError, aiErrorPrefix) {
		if err := s.filters.ClearLastError(ctx, filter.ID); err != nil {
			logger.Warn("clear filter ai error failed", "module", "service", "action", "update", "resource", "filter", "result", "failed", "filter_id", filter.ID, "error", err)
		}
	}
}

// dispatchWebhook 把一次命中投递给规则配的地址：异步发出、不拖慢入库。
// 成功会清掉上一次的 webhook 报错；失败把原因写回规则的 last_error（规则表上直接看得到）。
func (s *filterService) dispatchWebhook(ctx context.Context, filter model.Filter, feed model.Feed, entry model.Entry, actions model.FilterActions, at time.Time) {
	if !actions.Webhook {
		return
	}
	target := strings.TrimSpace(actions.WebhookURL)
	if target == "" {
		s.markWebhookFailure(ctx, filter, "规则没有填 webhook 地址", at)
		return
	}
	if s.webhook == nil {
		s.markWebhookFailure(ctx, filter, "服务未启用 webhook 发送器", at)
		return
	}

	payload, err := json.Marshal(FilterWebhookPayload{
		Event:     "filter.matched",
		Filter:    newWebhookRule(filter),
		Entry:     newWebhookEntry(entry, feed),
		Actions:   actions,
		MatchedAt: at.UTC().Format(time.RFC3339),
	})
	if err != nil {
		s.markWebhookFailure(ctx, filter, "构造报文失败："+err.Error(), at)
		return
	}

	// 响应一返回 ctx 就被取消，所以后台投递要脱离它（配合超时自己管生命周期）
	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), filterWebhookTimeout)
	go func() {
		defer cancel()
		status, sendErr := s.webhook.Send(sendCtx, target, payload)
		if sendErr != nil {
			s.markWebhookFailure(sendCtx, filter, fmt.Sprintf("%s（HTTP %d，目标 %s）", sendErr.Error(), status, network.ExtractHost(target)), time.Now())
			return
		}
		s.clearWebhookFailure(sendCtx, filter)
	}()
}

func (s *filterService) markWebhookFailure(ctx context.Context, filter model.Filter, reason string, at time.Time) {
	if err := s.filters.SetLastError(ctx, filter.ID, webhookErrorPrefix+reason, at); err != nil {
		logger.Warn("set filter webhook error failed", "module", "service", "action", "update", "resource", "filter", "result", "failed", "filter_id", filter.ID, "error", err)
	}
	logger.Warn("filter webhook delivery failed", "module", "service", "action", "webhook", "resource", "filter", "result", "failed", "filter_id", filter.ID, "reason", reason)
}

// dispatchNotify 把一次命中推给手机（Bark 兼容）：异步发出、不拖慢入库。
// 地址取「规则里填的」优先，留空则跟随设置里的全局推送地址；失败把原因写回规则的 last_error。
func (s *filterService) dispatchNotify(ctx context.Context, filter model.Filter, feed model.Feed, entry model.Entry, actions model.FilterActions, at time.Time) {
	if !actions.Notify {
		return
	}
	if s.notify == nil {
		s.markNotifyFailure(ctx, filter, "服务未启用推送通道", at)
		return
	}
	target := strings.TrimSpace(actions.NotifyURL)
	if target == "" {
		target = s.notify.GlobalURL(ctx)
	}
	if target == "" {
		s.markNotifyFailure(ctx, filter, "规则没填推送地址，设置里也没有全局推送地址", at)
		return
	}

	payload, err := MarshalFilterNotify(BuildFilterNotifyPayload(filter, feed, entry))
	if err != nil {
		s.markNotifyFailure(ctx, filter, "构造推送内容失败："+err.Error(), at)
		return
	}

	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), filterNotifyTimeout)
	go func() {
		defer cancel()
		status, sendErr := s.notify.Send(sendCtx, target, payload)
		if sendErr != nil {
			s.markNotifyFailure(sendCtx, filter, fmt.Sprintf("%s（HTTP %d，目标 %s）", redactNotifyTarget(sendErr.Error(), target), status, network.ExtractHost(target)), time.Now())
			return
		}
		s.clearNotifyFailure(sendCtx, filter)
	}()
}

// redactNotifyTarget 把错误里出现的推送地址换成主机名 —— 推送地址里带设备 key（凭证），
// 而这条原因会写进 last_error、也会进日志，不能把 key 带出去。
func redactNotifyTarget(message, target string) string {
	if target == "" || !strings.Contains(message, target) {
		return message
	}
	return strings.ReplaceAll(message, target, network.ExtractHost(target))
}

func (s *filterService) markNotifyFailure(ctx context.Context, filter model.Filter, reason string, at time.Time) {
	if err := s.filters.SetLastError(ctx, filter.ID, notifyErrorPrefix+reason, at); err != nil {
		logger.Warn("set filter notify error failed", "module", "service", "action", "update", "resource", "filter", "result", "failed", "filter_id", filter.ID, "error", err)
	}
	logger.Warn("filter notify failed", "module", "service", "action", "notify", "resource", "filter", "result", "failed", "filter_id", filter.ID, "reason", reason)
}

// clearNotifyFailure 只清掉「上一次是推送报的错」，不碰 AI / webhook 留下的原因。
func (s *filterService) clearNotifyFailure(ctx context.Context, filter model.Filter) {
	if filter.LastError == nil || !strings.HasPrefix(*filter.LastError, notifyErrorPrefix) {
		return
	}
	if err := s.filters.ClearLastError(ctx, filter.ID); err != nil {
		logger.Warn("clear filter notify error failed", "module", "service", "action", "update", "resource", "filter", "result", "failed", "filter_id", filter.ID, "error", err)
	}
}

// TestNotify 发一条测试推送（设置 → 自动化页那个按钮）。没有地址就返回 ErrInvalid，
// 投递失败把下游的话带回去（失败要给可见原因，不能只报「没成功」）。
func (s *filterService) TestNotify(ctx context.Context) (int, error) {
	if s.notify == nil {
		return 0, errNotifySenderDisabled
	}
	target := s.notify.GlobalURL(ctx)
	if target == "" {
		return 0, ErrInvalid
	}
	payload, err := MarshalFilterNotify(FilterNotifyPayload{
		Title: "Gist 测试推送",
		Body:  "能看到这条，说明推送通道已经通了",
		Group: "Gist 自动化",
	})
	if err != nil {
		return 0, fmt.Errorf("build test notify: %w", err)
	}

	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), filterNotifyTimeout)
	defer cancel()
	status, sendErr := s.notify.Send(sendCtx, target, payload)
	if sendErr != nil {
		return status, errors.New(redactNotifyTarget(sendErr.Error(), target))
	}
	return status, nil
}

// clearWebhookFailure 只清掉「上一次是 webhook 报的错」，不碰 AI 判定留下的原因。
func (s *filterService) clearWebhookFailure(ctx context.Context, filter model.Filter) {
	if filter.LastError == nil || !strings.HasPrefix(*filter.LastError, webhookErrorPrefix) {
		return
	}
	if err := s.filters.ClearLastError(ctx, filter.ID); err != nil {
		logger.Warn("clear filter webhook error failed", "module", "service", "action", "update", "resource", "filter", "result", "failed", "filter_id", filter.ID, "error", err)
	}
}

func newWebhookRule(filter model.Filter) FilterWebhookRule {
	rule := FilterWebhookRule{
		ID:        strconv.FormatInt(filter.ID, 10),
		Name:      filter.Name,
		ScopeType: filter.ScopeType,
	}
	if filter.ScopeID != nil {
		rule.ScopeID = strconv.FormatInt(*filter.ScopeID, 10)
	}
	return rule
}

func newWebhookEntry(entry model.Entry, feed model.Feed) FilterWebhookEntry {
	payload := FilterWebhookEntry{
		ID:        strconv.FormatInt(entry.ID, 10),
		FeedID:    strconv.FormatInt(feed.ID, 10),
		FeedTitle: feed.Title,
	}
	if entry.Title != nil {
		payload.Title = *entry.Title
	}
	if entry.URL != nil {
		payload.URL = *entry.URL
	}
	if entry.Author != nil {
		payload.Author = *entry.Author
	}
	if entry.PublishedAt != nil {
		payload.PublishedAt = entry.PublishedAt.UTC().Format(time.RFC3339)
	}
	return payload
}

// scopeListFilter 预览时按作用范围取最近 N 条（包含已静音条目，便于看清规则全貌）。
// viewCountScanLimit 数视图命中数时最多扫多少条候选（与列表的 viewScanLimit 同理，防一次拖垮实例）。
// 超过这个数时角标显示的是「至少这么多」，不是精确值 —— 本机库（几千条）远在上面。
const viewCountScanLimit = 5000

func scopeListFilter(params FilterWriteParams, limit int) repository.EntryListFilter {
	filter := repository.EntryListFilter{Limit: limit, IncludeMuted: true}
	switch params.ScopeType {
	case model.FilterScopeFeed:
		if len(params.ScopeIDs) > 0 {
			filter.FeedIDs = params.ScopeIDs
		} else {
			filter.FeedID = params.ScopeID
		}
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
	kind := params.Kind
	if kind != "" && kind != model.FilterKindRule && kind != model.FilterKindView {
		return ErrInvalidFilter
	}
	switch params.ScopeType {
	case "", model.FilterScopeAll:
	case model.FilterScopeFolder:
		if params.ScopeID == nil || *params.ScopeID == 0 {
			return ErrInvalidFilter
		}
	case model.FilterScopeFeed:
		// 订阅范围：单个 scope_id 或多个 scope_ids 都行，但不能一个都没有
		if len(normalizeScopeIDs(params.ScopeIDs)) == 0 && (params.ScopeID == nil || *params.ScopeID == 0) {
			return ErrInvalidFilter
		}
	default:
		return ErrInvalidFilter
	}
	if normalizeKind(params.Kind) == model.FilterKindView {
		// 视图不执行动作、只筛条目：动作必须为空（存库时也会被清掉），但必须至少有一个条件
		if params.Actions != (model.FilterActions{}) {
			return ErrInvalidFilter
		}
		if len(params.Conditions) == 0 {
			return ErrInvalidFilter
		}
	} else {
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
		// keepOnly 已经把「不匹配的」全静音了，再叠 mute 等于整片静音（UI 互斥，API 也要拦）
		if params.Actions.Mute && params.Actions.KeepOnly {
			return ErrInvalidFilter
		}
		if params.Actions.Webhook {
			if !isValidWebhookURL(params.Actions.WebhookURL) {
				return ErrInvalidFilter
			}
		}
	}
	for _, condition := range params.Conditions {
		if !containsString(model.FilterConditionFields, condition.Field) {
			return ErrInvalidFilter
		}
		if !containsString(model.FilterConditionOperators, condition.Operator) {
			return ErrInvalidFilter
		}
		// ai_relevance 只配 is_relevant（要「不相关」用取反），其余字段不许用 is_relevant
		if condition.Field == model.FilterFieldAIRelevance {
			if condition.Operator != model.FilterOpIsRelevant {
				return ErrInvalidFilter
			}
			if len([]rune(strings.TrimSpace(condition.Value))) > 200 {
				return ErrInvalidFilter
			}
		} else if condition.Operator == model.FilterOpIsRelevant {
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

// isValidWebhookURL 只放行 http/https 的绝对地址（挡掉 file:// / 空主机这类会被当 SSRF 用的写法）。
func isValidWebhookURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	return parsed.Host != ""
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
