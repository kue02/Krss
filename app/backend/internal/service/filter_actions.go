package service

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/service/ai"
	"gist/backend/pkg/logger"
)

// 自然语言建规则：一句人话 → 规则草稿（不落库，交给编辑器确认）。
//
// 两道保险：① prompt 里带上下文（真实存在的订阅/分类 id），② 模型输出一律过一遍
// sanitizeDraft + ValidateFilterParams —— 模型编出来的字段/操作符会被丢掉并在 warnings 里说明。
const (
	filterDraftMaxRunes    = 2000
	filterDraftScopeLimit  = 300
	filterDraftTimeoutMult = 3
)

// ParseNaturalLanguage 用已配置的 AI provider 把一句人话翻成规则草稿。
// 返回的草稿一定能通过 ValidateFilterParams（否则报 ErrAIDraftInvalid），但绝不落库。
func (s *filterService) ParseNaturalLanguage(ctx context.Context, text string) (FilterDraft, error) {
	request := strings.TrimSpace(text)
	if request == "" || len([]rune(request)) > filterDraftMaxRunes {
		return FilterDraft{}, ErrInvalidFilter
	}
	if s.ai == nil {
		return FilterDraft{}, ErrAIUnavailable
	}

	scopeContext, err := s.describeScopes(ctx)
	if err != nil {
		return FilterDraft{}, err
	}

	callCtx, cancel := context.WithTimeout(ctx, aiJudgeTimeout*filterDraftTimeoutMult)
	defer cancel()
	raw, err := s.ai.Complete(callCtx, ai.GetFilterDraftPrompts(request, scopeContext), ai.WrapInput(request))
	if err != nil {
		// 「没配 key / 没配模型」是可预期的用户侧原因，单独报出去，别让它埋在技术错误里
		if strings.Contains(err.Error(), "not configured") {
			return FilterDraft{}, ErrAIUnavailable
		}
		return FilterDraft{}, fmt.Errorf("ai draft completion failed: %w", err)
	}

	draft, err := parseFilterDraft(raw)
	if err != nil {
		return FilterDraft{}, ErrAIDraftInvalid
	}
	if err := s.sanitizeDraft(ctx, &draft); err != nil {
		return FilterDraft{}, err
	}
	if err := ValidateFilterParams(FilterWriteParams{
		Name:       draft.Name,
		Kind:       model.FilterKindRule,
		ScopeType:  draft.ScopeType,
		ScopeID:    draft.ScopeID,
		Conditions: draft.Conditions,
		Actions:    draft.Actions,
	}); err != nil {
		return FilterDraft{}, ErrAIDraftInvalid
	}

	logger.Info("filter draft generated", "module", "service", "action", "parse", "resource", "filter", "result", "ok",
		"conditions", len(draft.Conditions), "warnings", len(draft.Warnings))
	return draft, nil
}

// describeScopes 把当前分类/订阅清单写成给模型看的上下文（真实 id → 名称）。
func (s *filterService) describeScopes(ctx context.Context) (string, error) {
	lines := make([]string, 0, 32)

	if s.folders != nil {
		folders, err := s.folders.List(ctx)
		if err != nil {
			return "", err
		}
		for _, folder := range folders {
			if len(lines) >= filterDraftScopeLimit {
				break
			}
			lines = append(lines, fmt.Sprintf("folder %d → %s", folder.ID, folder.Name))
		}
	}

	feeds, err := s.feeds.List(ctx, nil)
	if err != nil {
		return "", err
	}
	for _, feed := range feeds {
		if len(lines) >= filterDraftScopeLimit {
			break
		}
		label := fmt.Sprintf("feed %d → %s", feed.ID, feed.Title)
		if feed.FolderID != nil {
			label += fmt.Sprintf("（分类 %d）", *feed.FolderID)
		}
		lines = append(lines, label)
	}

	if len(lines) == 0 {
		return "（这个实例还没有任何订阅与分类）", nil
	}
	return strings.Join(lines, "\n"), nil
}

// sanitizeDraft 逐项核对模型输出：能修的就修（并留 warning），整条没救就报 ErrAIDraftInvalid。
// 原则是「宁可少一条条件，也不悄悄替用户改语义」—— 改了什么都会出现在 warnings 里。
func (s *filterService) sanitizeDraft(ctx context.Context, draft *FilterDraft) error {
	// ① 作用域：模型可能编一个不存在的 id，也可能把 all 又填了 id
	switch draft.ScopeType {
	case model.FilterScopeFeed:
		if draft.ScopeID == nil || !s.feedExists(ctx, *draft.ScopeID) {
			draft.Warnings = append(draft.Warnings, fmt.Sprintf("模型给了一个不存在的订阅（%v），已改成「全部」范围", draft.ScopeID))
			draft.ScopeType = model.FilterScopeAll
			draft.ScopeID = nil
		}
	case model.FilterScopeFolder:
		if draft.ScopeID == nil || !s.folderExists(ctx, *draft.ScopeID) {
			draft.Warnings = append(draft.Warnings, fmt.Sprintf("模型给了一个不存在的分类（%v），已改成「全部」范围", draft.ScopeID))
			draft.ScopeType = model.FilterScopeAll
			draft.ScopeID = nil
		}
	default:
		draft.ScopeType = model.FilterScopeAll
		draft.ScopeID = nil
	}

	// ② 条件：字段/操作符不认识、正则编不出来、AI 条件没给主题 —— 一律丢掉并说明
	kept := make([]model.FilterCondition, 0, len(draft.Conditions))
	for _, condition := range draft.Conditions {
		if !containsString(model.FilterConditionFields, condition.Field) {
			draft.Warnings = append(draft.Warnings, fmt.Sprintf("丢弃了一条未知字段的条件（%s）", truncateRunes(condition.Field, 20)))
			continue
		}
		if !containsString(model.FilterConditionOperators, condition.Operator) {
			draft.Warnings = append(draft.Warnings, fmt.Sprintf("丢弃了一条未知操作符的条件（%s）", truncateRunes(condition.Operator, 20)))
			continue
		}
		if condition.Field == model.FilterFieldAIRelevance {
			if condition.Operator != model.FilterOpIsRelevant || strings.TrimSpace(condition.Value) == "" {
				draft.Warnings = append(draft.Warnings, "丢弃了一条不完整的 AI 条件（需要「AI 相关性 + is_relevant + 主题描述」）")
				continue
			}
			condition.Value = truncateRunes(condition.Value, 200)
		} else if condition.Operator == model.FilterOpIsRelevant {
			draft.Warnings = append(draft.Warnings, "丢弃了一条把 is_relevant 用在普通字段上的条件")
			continue
		}
		if requiresValue(condition.Operator) && strings.TrimSpace(condition.Value) == "" {
			draft.Warnings = append(draft.Warnings, "丢弃了一条没填值的条件")
			continue
		}
		if condition.Operator == model.FilterOpRegex {
			if _, err := regexp.Compile(condition.Value); err != nil {
				draft.Warnings = append(draft.Warnings, fmt.Sprintf("丢弃了一条非法正则（%s）", truncateRunes(condition.Value, 20)))
				continue
			}
		}
		if condition.Logic != "or" {
			condition.Logic = "and"
		}
		kept = append(kept, condition)
	}
	draft.Conditions = kept

	// ③ 动作：正反冲突取「正动作」，webhook 缺地址就摘掉这个动作
	actions := draft.Actions
	actions.KeepOnly = actions.KeepOnly && !actions.Mute
	if actions.Mute && actions.Unmute {
		actions.Unmute = false
		draft.Warnings = append(draft.Warnings, "模型同时给了静音与取消静音，已只保留静音")
	}
	if actions.MarkRead && actions.MarkUnread {
		actions.MarkUnread = false
		draft.Warnings = append(draft.Warnings, "模型同时给了标已读与标未读，已只保留标已读")
	}
	if actions.Star && actions.Unstar {
		actions.Unstar = false
		draft.Warnings = append(draft.Warnings, "模型同时给了加星与取消星标，已只保留加星")
	}
	if actions.Webhook && !isValidWebhookURL(actions.WebhookURL) {
		actions.Webhook = false
		actions.WebhookURL = ""
		draft.Warnings = append(draft.Warnings, "模型给的 webhook 地址不合法，已摘掉这个动作")
	}
	if !actions.Webhook {
		actions.WebhookURL = ""
	}
	draft.Actions = actions

	if draft.Actions.IsEmpty() {
		return ErrAIDraftInvalid
	}
	if len(draft.Conditions) == 0 {
		return ErrAIDraftInvalid
	}
	return nil
}

func (s *filterService) feedExists(ctx context.Context, id int64) bool {
	feed, err := s.feeds.GetByID(ctx, id)
	return err == nil && feed.ID == id
}

func (s *filterService) folderExists(ctx context.Context, id int64) bool {
	if s.folders == nil {
		return false
	}
	folder, err := s.folders.GetByID(ctx, id)
	return err == nil && folder.ID == id
}

// —— 条目级「豁免这类内容」 ——

// CreateException 把「这条被误伤了」变成一条可修正的例外规则：
//   - 顺序排到最前（首个命中即停 → 例外优先于所有规则）
//   - 只做反向动作（取消静音 + 退回未读）
//   - 条件默认是「同一个链接」（没有链接就退化成标题精确匹配），用户可以再去编辑器改条件
//
// 建完立刻把这一条放回未读流，并记一次命中（规则表上能看到它干过活）。
func (s *filterService) CreateException(ctx context.Context, entryID int64) (model.Filter, error) {
	entry, err := s.entries.GetByID(ctx, entryID)
	if err != nil {
		return model.Filter{}, ErrEntryNotFound
	}
	feed, err := s.feeds.GetByID(ctx, entry.FeedID)
	if err != nil {
		return model.Filter{}, ErrEntryNotFound
	}

	condition, ok := exceptionCondition(entry)
	if !ok {
		return model.Filter{}, ErrInvalidFilter
	}

	existing, err := s.filters.List(ctx)
	if err != nil {
		return model.Filter{}, err
	}
	position := 0
	if len(existing) > 0 {
		position = existing[0].Position
		for _, item := range existing {
			if item.Position < position {
				position = item.Position
			}
		}
		position--
	}

	created, err := s.filters.Create(ctx, model.Filter{
		Name:       exceptionName(entry, feed),
		Enabled:    true,
		Position:   position,
		Kind:       model.FilterKindRule,
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{condition},
		Actions:    model.FilterActions{Unmute: true, MarkUnread: true},
	})
	if err != nil {
		return model.Filter{}, err
	}

	// 立刻放行这一条：清掉它身上的规则标记（静音 / 已读 / 自动翻译之类）
	if _, err := s.entries.ResetFilterState(ctx, []int64{entryID}, true); err != nil {
		return created, err
	}

	now := time.Now()
	if err := s.filters.RecordMatch(ctx, model.FilterMatch{
		FilterID:  created.ID,
		EntryID:   entryID,
		Actions:   created.Actions,
		CreatedAt: now,
	}); err != nil {
		logger.Warn("record exception match failed", "module", "service", "action", "record", "resource", "filter", "result", "failed", "filter_id", created.ID, "entry_id", entryID, "error", err)
	}
	if err := s.filters.BumpMatchStats(ctx, map[int64]int64{created.ID: 1}, now); err != nil {
		logger.Warn("bump exception stats failed", "module", "service", "action", "update", "resource", "filter", "result", "failed", "filter_id", created.ID, "error", err)
	}

	logger.Info("filter exception created", "module", "service", "action", "create", "resource", "filter", "result", "ok",
		"filter_id", created.ID, "entry_id", entryID, "feed_id", feed.ID)
	return created, nil
}

// exceptionCondition 例外规则的条件：优先「同一个链接」，没有链接就退化成标题精确匹配。
func exceptionCondition(entry model.Entry) (model.FilterCondition, bool) {
	if entry.URL != nil && strings.TrimSpace(*entry.URL) != "" {
		return model.FilterCondition{
			Logic:    "and",
			Field:    model.FilterFieldURL,
			Operator: model.FilterOpExact,
			Value:    strings.TrimSpace(*entry.URL),
		}, true
	}
	if entry.Title != nil && strings.TrimSpace(*entry.Title) != "" {
		return model.FilterCondition{
			Logic:    "and",
			Field:    model.FilterFieldTitle,
			Operator: model.FilterOpExact,
			Value:    strings.TrimSpace(*entry.Title),
		}, true
	}
	return model.FilterCondition{}, false
}

func exceptionName(entry model.Entry, feed model.Feed) string {
	if entry.Title != nil && strings.TrimSpace(*entry.Title) != "" {
		return truncateRunes("豁免："+strings.TrimSpace(*entry.Title), 58)
	}
	return truncateRunes("豁免："+feed.Title, 58)
}
