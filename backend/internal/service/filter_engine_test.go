package service_test

import (
	"testing"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/service"

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
	require.True(t, service.MatchConditions(entryContextFixture(), nil, time.Now(), nil))
	require.True(t, service.MatchConditions(entryContextFixture(), []model.FilterCondition{}, time.Now(), nil))
}

func TestMatchConditions_ContainsIsCaseInsensitive(t *testing.T) {
	entry := entryContextFixture()
	conditions := []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "workers"},
	}
	require.True(t, service.MatchConditions(entry, conditions, time.Now(), nil))

	conditions[0].Value = "azure"
	require.False(t, service.MatchConditions(entry, conditions, time.Now(), nil))
}

func TestMatchConditions_ExactAndNegate(t *testing.T) {
	entry := entryContextFixture()
	exact := []model.FilterCondition{
		{Field: model.FilterFieldFeedTitle, Operator: model.FilterOpExact, Value: "cloudflare blog"},
	}
	require.True(t, service.MatchConditions(entry, exact, time.Now(), nil), "exact 忽略大小写与首尾空格")

	negated := []model.FilterCondition{
		{Field: model.FilterFieldFeedTitle, Operator: model.FilterOpExact, Value: "cloudflare blog", Negate: true},
	}
	require.False(t, service.MatchConditions(entry, negated, time.Now(), nil))
}

func TestMatchConditions_RegexAndInvalidRegexFailsClosed(t *testing.T) {
	entry := entryContextFixture()
	valid := []model.FilterCondition{
		{Field: model.FilterFieldContent, Operator: model.FilterOpRegex, Value: `(?i)\b(sponsored|推广)\b`},
	}
	require.True(t, service.MatchConditions(entry, valid, time.Now(), nil))

	invalid := []model.FilterCondition{
		{Field: model.FilterFieldContent, Operator: model.FilterOpRegex, Value: `(?=lookahead)`},
	}
	require.False(t, service.MatchConditions(entry, invalid, time.Now(), nil), "RE2 不支持 lookahead，编译失败按不命中处理")
}

func TestMatchConditions_OrLogicAndDefaultAnd(t *testing.T) {
	entry := entryContextFixture()
	// 第一条命中、第二条 or 命中 → 整体命中
	orMatch := []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "cloudflare"},
		{Logic: "or", Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "azure"},
	}
	require.True(t, service.MatchConditions(entry, orMatch, time.Now(), nil))

	// 第一条命中、第二条 and 不命中 → 整体不命中
	andMiss := []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "cloudflare"},
		{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "azure"},
	}
	require.False(t, service.MatchConditions(entry, andMiss, time.Now(), nil))

	// 首条不命中、第二条 or 命中 → 整体命中（or 可以救回来）
	secondOrWins := []model.FilterCondition{
		{Field: model.FilterFieldAuthor, Operator: model.FilterOpContains, Value: "某人"},
		{Logic: "or", Field: model.FilterFieldFeedTitle, Operator: model.FilterOpContains, Value: "cloudflare"},
	}
	require.True(t, service.MatchConditions(entry, secondOrWins, time.Now(), nil))
}

func TestMatchConditions_DateOperators(t *testing.T) {
	entry := entryContextFixture()
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)

	olderThan := []model.FilterCondition{
		{Field: model.FilterFieldPublishedAt, Operator: model.FilterOpOlderThan, Value: "7d"},
	}
	require.True(t, service.MatchConditions(entry, olderThan, now, nil))

	olderThan[0].Value = "90d"
	require.False(t, service.MatchConditions(entry, olderThan, now, nil))

	before := []model.FilterCondition{
		{Field: model.FilterFieldPublishedAt, Operator: model.FilterOpBefore, Value: "2026-09-10"},
	}
	require.True(t, service.MatchConditions(entry, before, now, nil))

	after := []model.FilterCondition{
		{Field: model.FilterFieldPublishedAt, Operator: model.FilterOpAfter, Value: "2026-09-10"},
	}
	require.False(t, service.MatchConditions(entry, after, now, nil))

	future := []model.FilterCondition{
		{Field: model.FilterFieldPublishedAt, Operator: model.FilterOpIsFuture},
	}
	require.False(t, service.MatchConditions(entry, future, now, nil))

	missingDate := entry
	missingDate.PublishedAt = nil
	require.False(t, service.MatchConditions(missingDate, before, now, nil), "没有发布时间时日期条件一律不命中")
}

func TestMatchConditions_BooleanAndEmptyOperators(t *testing.T) {
	entry := entryContextFixture()

	starred := []model.FilterCondition{
		{Field: model.FilterFieldIsStarred, Operator: model.FilterOpContains, Value: "true"},
	}
	require.False(t, service.MatchConditions(entry, starred, time.Now(), nil))

	notStarred := []model.FilterCondition{
		{Field: model.FilterFieldIsStarred, Operator: model.FilterOpContains, Value: "false"},
	}
	require.True(t, service.MatchConditions(entry, notStarred, time.Now(), nil))

	emptyTitle := entry
	emptyTitle.Title = "   "
	require.True(t, service.MatchConditions(emptyTitle, []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpIsEmpty},
	}, time.Now(), nil))
	require.False(t, service.MatchConditions(entry, []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpIsEmpty},
	}, time.Now(), nil))
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

	// mute + keepOnly 等于「整片静音」，UI 已互斥、API 也必须拦
	muteWithKeepOnly := valid
	muteWithKeepOnly.Actions = model.FilterActions{Mute: true, KeepOnly: true}
	require.ErrorIs(t, service.ValidateFilterParams(muteWithKeepOnly), service.ErrInvalidFilter)

	// keepOnly 配上别的动作仍然合法（它只表示「不命中的那些静音」）
	keepOnlyWithRead := valid
	keepOnlyWithRead.Actions = model.FilterActions{KeepOnly: true, MarkRead: true}
	require.NoError(t, service.ValidateFilterParams(keepOnlyWithRead))
}

// 47-4（用户 2026-10-12）：带空格 / 跨标签的文本条件要能命中。
//
// 报障条目（`t.me/zhetengsha/7200`）的正文尾部原文是
// `<tg-emoji …><span class="emoji">🥰</span></tg-emoji> <a href="…?q=%23…">#机场</a> <a href="…">#推广</a>`，
// 渲染出来是「🥰 #机场 #推广」，但两个标签之间夹着 `</a> <a href="…">` ⇒ 原来 contains 恒为 0。
func TestMatchConditions_PlainTextFallbackForTagsAcrossMarkup(t *testing.T) {
	entry := entryContextFixture()
	entry.Content = `<p>尾巴</p><tg-emoji emoji-id="6327836885552991740"><span class="emoji">🥰</span></tg-emoji> ` +
		`<a href="https://t.me/zhetengsha/7200?q=%23%E6%9C%BA%E5%9C%BA">#机场</a> ` +
		`<a href="https://t.me/zhetengsha/7200?q=%23%E6%8E%A8%E5%B9%BF">#推广</a>`

	now := time.Now()
	contains := func(value string) bool {
		return service.MatchConditions(entry, []model.FilterCondition{
			{Field: model.FilterFieldContent, Operator: model.FilterOpContains, Value: value},
		}, now, nil)
	}

	// 原话里那两种写法都要能命中
	require.True(t, contains("🥰 #机场 #推广"), "emoji 与两个标签之间有标签包裹，纯文本应命中")
	require.True(t, contains("#机场 #推广"), "两个标签之间夹着 </a> <a href>，纯文本应命中")
	require.True(t, contains("#机场"), "单个标签照旧命中（原始 HTML 里就有）")

	// 源里多一个空格 / 标签间夹换行也要命中（空白压成单空格后再比）
	entrySpaced := entry
	entrySpaced.Content = "<p>🥰</p><p>#机场</p><p>#推广</p>"
	require.True(t, service.MatchConditions(entrySpaced, []model.FilterCondition{
		{Field: model.FilterFieldContent, Operator: model.FilterOpContains, Value: "🥰 #机场 #推广"},
	}, now, nil))

	// 反证：纯文本里确实没有的内容仍然不命中（没把判据整体放松）
	require.False(t, contains("#推广 #机场"), "顺序不同不算命中")
	require.False(t, contains("不存在的词"))
}

// 纯文本那一路只加不换：原来靠 HTML 命中的规则行为必须一字不变
func TestMatchConditions_RawHTMLMatchingStillWorks(t *testing.T) {
	entry := entryContextFixture()
	entry.Content = `<p>现价：<b>¥0.00</b></p><img src="https://x.com/a.jpg">`

	now := time.Now()
	htmlOnly := []model.FilterCondition{
		{Field: model.FilterFieldContent, Operator: model.FilterOpContains, Value: `<img src=`},
	}
	require.True(t, service.MatchConditions(entry, htmlOnly, now, nil), "按 HTML 标记匹配的老规则不受影响")

	plainAndHTML := []model.FilterCondition{
		{Field: model.FilterFieldContent, Operator: model.FilterOpContains, Value: "现价：¥0.00"},
	}
	require.True(t, service.MatchConditions(entry, plainAndHTML, now, nil), "跨 <b> 标签的纯文本也能命中")

	exactPlain := []model.FilterCondition{
		{Field: model.FilterFieldContent, Operator: model.FilterOpExact, Value: "现价：¥0.00"},
	}
	require.True(t, service.MatchConditions(entry, exactPlain, now, nil), "exact 也走纯文本那一路")

	regexPlain := []model.FilterCondition{
		{Field: model.FilterFieldContent, Operator: model.FilterOpRegex, Value: `^现价：`},
	}
	require.True(t, service.MatchConditions(entry, regexPlain, now, nil), "正则能对上纯文本开头")

	// is_empty 仍只看原始值（不因纯文本为空而翻案）
	emptyHTML := entry
	emptyHTML.Content = "<p></p>"
	require.False(t, service.MatchConditions(emptyHTML, []model.FilterCondition{
		{Field: model.FilterFieldContent, Operator: model.FilterOpIsEmpty},
	}, now, nil))
}
