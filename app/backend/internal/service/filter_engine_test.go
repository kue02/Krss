package service_test

import (
	"testing"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/service"

	"github.com/stretchr/testify/require"
)

func timePtr(value time.Time) *time.Time { return &value }

func entryContextFixture() service.EntryContext {
	published := time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)
	return service.EntryContext{
		Title:        "Cloudflare 发布 Workers 新特性",
		Content:      "本周我们还赞助了 sponsored 内容",
		Author:       "Cloudflare Blog",
		URL:          "https://blog.cloudflare.com/workers",
		PublishedAt:  &published,
		FeedTitle:    "Cloudflare Blog",
		FeedURL:      "https://blog.cloudflare.com/rss/",
		FeedType:     "article",
		FolderName:   "技术",
		HasThumbnail: true,
		Read:         false,
		Starred:      false,
	}
}

func TestMatchConditions_EmptyConditionsMatchEverything(t *testing.T) {
	require.True(t, service.MatchConditions(entryContextFixture(), nil, time.Now()))
	require.True(t, service.MatchConditions(entryContextFixture(), []model.FilterCondition{}, time.Now()))
}

func TestMatchConditions_ContainsIsCaseInsensitive(t *testing.T) {
	entry := entryContextFixture()
	conditions := []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "workers"},
	}
	require.True(t, service.MatchConditions(entry, conditions, time.Now()))

	conditions[0].Value = "azure"
	require.False(t, service.MatchConditions(entry, conditions, time.Now()))
}

func TestMatchConditions_ExactAndNegate(t *testing.T) {
	entry := entryContextFixture()
	exact := []model.FilterCondition{
		{Field: model.FilterFieldFeedTitle, Operator: model.FilterOpExact, Value: "cloudflare blog"},
	}
	require.True(t, service.MatchConditions(entry, exact, time.Now()), "exact 忽略大小写与首尾空格")

	negated := []model.FilterCondition{
		{Field: model.FilterFieldFeedTitle, Operator: model.FilterOpExact, Value: "cloudflare blog", Negate: true},
	}
	require.False(t, service.MatchConditions(entry, negated, time.Now()))
}

func TestMatchConditions_RegexAndInvalidRegexFailsClosed(t *testing.T) {
	entry := entryContextFixture()
	valid := []model.FilterCondition{
		{Field: model.FilterFieldContent, Operator: model.FilterOpRegex, Value: `(?i)\b(sponsored|推广)\b`},
	}
	require.True(t, service.MatchConditions(entry, valid, time.Now()))

	invalid := []model.FilterCondition{
		{Field: model.FilterFieldContent, Operator: model.FilterOpRegex, Value: `(?=lookahead)`},
	}
	require.False(t, service.MatchConditions(entry, invalid, time.Now()), "RE2 不支持 lookahead，编译失败按不命中处理")
}

func TestMatchConditions_OrLogicAndDefaultAnd(t *testing.T) {
	entry := entryContextFixture()
	// 第一条命中、第二条 or 命中 → 整体命中
	orMatch := []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "cloudflare"},
		{Logic: "or", Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "azure"},
	}
	require.True(t, service.MatchConditions(entry, orMatch, time.Now()))

	// 第一条命中、第二条 and 不命中 → 整体不命中
	andMiss := []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "cloudflare"},
		{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "azure"},
	}
	require.False(t, service.MatchConditions(entry, andMiss, time.Now()))

	// 首条不命中、第二条 or 命中 → 整体命中（or 可以救回来）
	secondOrWins := []model.FilterCondition{
		{Field: model.FilterFieldAuthor, Operator: model.FilterOpContains, Value: "某人"},
		{Logic: "or", Field: model.FilterFieldFeedTitle, Operator: model.FilterOpContains, Value: "cloudflare"},
	}
	require.True(t, service.MatchConditions(entry, secondOrWins, time.Now()))
}

func TestMatchConditions_DateOperators(t *testing.T) {
	entry := entryContextFixture()
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)

	olderThan := []model.FilterCondition{
		{Field: model.FilterFieldPublishedAt, Operator: model.FilterOpOlderThan, Value: "7d"},
	}
	require.True(t, service.MatchConditions(entry, olderThan, now))

	olderThan[0].Value = "90d"
	require.False(t, service.MatchConditions(entry, olderThan, now))

	before := []model.FilterCondition{
		{Field: model.FilterFieldPublishedAt, Operator: model.FilterOpBefore, Value: "2026-09-10"},
	}
	require.True(t, service.MatchConditions(entry, before, now))

	after := []model.FilterCondition{
		{Field: model.FilterFieldPublishedAt, Operator: model.FilterOpAfter, Value: "2026-09-10"},
	}
	require.False(t, service.MatchConditions(entry, after, now))

	future := []model.FilterCondition{
		{Field: model.FilterFieldPublishedAt, Operator: model.FilterOpIsFuture},
	}
	require.False(t, service.MatchConditions(entry, future, now))

	missingDate := entry
	missingDate.PublishedAt = nil
	require.False(t, service.MatchConditions(missingDate, before, now), "没有发布时间时日期条件一律不命中")
}

func TestMatchConditions_BooleanAndEmptyOperators(t *testing.T) {
	entry := entryContextFixture()

	starred := []model.FilterCondition{
		{Field: model.FilterFieldIsStarred, Operator: model.FilterOpContains, Value: "true"},
	}
	require.False(t, service.MatchConditions(entry, starred, time.Now()))

	notStarred := []model.FilterCondition{
		{Field: model.FilterFieldIsStarred, Operator: model.FilterOpContains, Value: "false"},
	}
	require.True(t, service.MatchConditions(entry, notStarred, time.Now()))

	emptyTitle := entry
	emptyTitle.Title = "   "
	require.True(t, service.MatchConditions(emptyTitle, []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpIsEmpty},
	}, time.Now()))
	require.False(t, service.MatchConditions(entry, []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpIsEmpty},
	}, time.Now()))
}

func TestResolveActions_MatchedAndUnmatched(t *testing.T) {
	// 命中：动作原样生效，keepOnly 只是「条件没命中才用得上」的开关
	actions, applies := service.ResolveActions(true, model.FilterActions{Mute: true, KeepOnly: true})
	require.True(t, applies)
	require.True(t, actions.Mute)
	require.False(t, actions.KeepOnly)

	// 命中但没有任何动作 → 不生效
	_, applies = service.ResolveActions(true, model.FilterActions{})
	require.False(t, applies)

	// 条件没命中 + keepOnly → 退化为静音（只保留匹配）
	actions, applies = service.ResolveActions(false, model.FilterActions{KeepOnly: true})
	require.True(t, applies)
	require.True(t, actions.Mute)
	require.True(t, actions.AffectsMute())

	// 条件没命中且没有 keepOnly → 什么都不做
	_, applies = service.ResolveActions(false, model.FilterActions{Mute: true})
	require.False(t, applies)
}

func TestScopeMatches(t *testing.T) {
	folderID := int64(7)
	feedID := int64(42)
	feed := model.Feed{ID: feedID, FolderID: &folderID}

	all := model.Filter{ScopeType: model.FilterScopeAll}
	require.True(t, service.ScopeMatches(all, feed))

	byFeed := model.Filter{ScopeType: model.FilterScopeFeed, ScopeID: &feedID}
	require.True(t, service.ScopeMatches(byFeed, feed))

	otherFeed := int64(43)
	require.False(t, service.ScopeMatches(model.Filter{ScopeType: model.FilterScopeFeed, ScopeID: &otherFeed}, feed))

	require.True(t, service.ScopeMatches(model.Filter{ScopeType: model.FilterScopeFolder, ScopeID: &folderID}, feed))

	otherFolder := int64(8)
	require.False(t, service.ScopeMatches(model.Filter{ScopeType: model.FilterScopeFolder, ScopeID: &otherFolder}, feed))

	// 订阅没有分类时，分类规则不覆盖它
	orphan := model.Feed{ID: 99}
	require.False(t, service.ScopeMatches(model.Filter{ScopeType: model.FilterScopeFolder, ScopeID: &folderID}, orphan))
}

func TestValidateFilterParams(t *testing.T) {
	feedID := int64(42)
	valid := service.FilterWriteParams{
		Name:       "屏蔽推广",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feedID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "推广"}},
		Actions:    model.FilterActions{Mute: true, MarkRead: true},
	}
	require.NoError(t, service.ValidateFilterParams(valid))

	noName := valid
	noName.Name = "   "
	require.ErrorIs(t, service.ValidateFilterParams(noName), service.ErrInvalidFilter)

	tooLong := valid
	tooLong.Name = string(make([]rune, 61))
	require.ErrorIs(t, service.ValidateFilterParams(tooLong), service.ErrInvalidFilter)

	noActions := valid
	noActions.Actions = model.FilterActions{}
	require.ErrorIs(t, service.ValidateFilterParams(noActions), service.ErrInvalidFilter)

	conflict := valid
	conflict.Actions = model.FilterActions{Mute: true, Unmute: true}
	require.ErrorIs(t, service.ValidateFilterParams(conflict), service.ErrInvalidFilter)

	missingScope := valid
	missingScope.ScopeID = nil
	require.ErrorIs(t, service.ValidateFilterParams(missingScope), service.ErrInvalidFilter)

	badScope := valid
	badScope.ScopeType = "tag"
	require.ErrorIs(t, service.ValidateFilterParams(badScope), service.ErrInvalidFilter)

	badField := valid
	badField.Conditions = []model.FilterCondition{{Field: "music", Operator: model.FilterOpContains, Value: "x"}}
	require.ErrorIs(t, service.ValidateFilterParams(badField), service.ErrInvalidFilter)

	badOperator := valid
	badOperator.Conditions = []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: "sounds_like", Value: "x"}}
	require.ErrorIs(t, service.ValidateFilterParams(badOperator), service.ErrInvalidFilter)

	missingValue := valid
	missingValue.Conditions = []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: ""}}
	require.ErrorIs(t, service.ValidateFilterParams(missingValue), service.ErrInvalidFilter)

	invalidRegex := valid
	invalidRegex.Conditions = []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpRegex, Value: "(?=lookahead)"}}
	require.ErrorIs(t, service.ValidateFilterParams(invalidRegex), service.ErrInvalidFilter)

	// 无值操作符不需要 value；keepOnly 单独也算有效动作
	noValueNeeded := service.FilterWriteParams{
		Name:       "只保留命中",
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpIsEmpty}},
		Actions:    model.FilterActions{KeepOnly: true},
	}
	require.NoError(t, service.ValidateFilterParams(noValueNeeded))
}
