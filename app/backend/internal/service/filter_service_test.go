package service_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/internal/repository/testutil"
	"gist/backend/internal/service"

	"github.com/stretchr/testify/require"
)

// filterFixture 用真实 SQLite（内存库 + 全量迁移）跑规则引擎，
// 因为「命中即写标记 + 审计 + 撤销」这三件事的语义要靠真库才验得出来。
type filterFixture struct {
	db      *sql.DB
	service service.FilterService
	entries repository.EntryRepository
	feeds   repository.FeedRepository
	filters repository.FilterRepository
}

func newFilterFixture(t *testing.T) *filterFixture {
	t.Helper()
	dbConn := testutil.NewTestDB(t)
	entryRepo := repository.NewEntryRepository(dbConn)
	feedRepo := repository.NewFeedRepository(dbConn)
	folderRepo := repository.NewFolderRepository(dbConn)
	filterRepo := repository.NewFilterRepository(dbConn)

	return &filterFixture{
		db:      dbConn,
		service: service.NewFilterService(service.FilterServiceDeps{
			Filters: filterRepo,
			Entries: entryRepo,
			Feeds:   feedRepo,
			Folders: folderRepo,
		}),
		entries: entryRepo,
		feeds:   feedRepo,
		filters: filterRepo,
	}
}

func (f *filterFixture) seedFeed(t *testing.T, title string, feedType string) model.Feed {
	t.Helper()
	feed := model.Feed{
		Title: title,
		URL:   "https://example.com/" + title + ".xml",
		Type:  feedType,
	}
	id := testutil.SeedFeed(t, f.db, feed)
	feed.ID = id
	return feed
}

func (f *filterFixture) seedEntry(t *testing.T, feedID int64, hash string, title string, publishedAt *time.Time) model.Entry {
	t.Helper()
	entry := model.Entry{
		FeedID:      feedID,
		Hash:        hash,
		Title:       &title,
		URL:         strPtr("https://example.com/" + hash),
		PublishedAt: publishedAt,
	}
	entry.ID = testutil.SeedEntry(t, f.db, entry)
	return entry
}

func (f *filterFixture) reload(t *testing.T, id int64) model.Entry {
	t.Helper()
	entry, err := f.entries.GetByID(context.Background(), id)
	require.NoError(t, err)
	return entry
}

func (f *filterFixture) create(t *testing.T, params service.FilterWriteParams) model.Filter {
	t.Helper()
	created, err := f.service.Create(context.Background(), params)
	require.NoError(t, err)
	return created
}

// 首个命中即停：一条条目只由顺序最靠前的那条规则处理，后面的规则不再插手。
func TestFilterService_ApplyToEntries_FirstMatchWins(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "Cloudflare", "article")
	hardFeed := feed
	title := "Workers 新特性上线"
	news := fixture.seedEntry(t, feed.ID, "hash-news", title, timePtr(time.Now().Add(-2*time.Hour)))
	noise := fixture.seedEntry(t, feed.ID, "hash-noise", "本周赞助商推荐", timePtr(time.Now().Add(-time.Hour)))

	first := fixture.create(t, service.FilterWriteParams{
		Name:       "Workers 加星",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &hardFeed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Workers"}},
		Actions:    model.FilterActions{Star: true},
	})
	second := fixture.create(t, service.FilterWriteParams{
		Name:      "这个源整体静音",
		ScopeType: model.FilterScopeFeed,
		ScopeID:   &hardFeed.ID,
		Actions:   model.FilterActions{Mute: true},
	})
	require.Greater(t, second.Position, first.Position, "新规则默认排在最后")

	applied, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{news, noise})
	require.NoError(t, err)
	require.Equal(t, 2, applied)

	// 命中第一条：加星，未被静音
	starred := fixture.reload(t, news.ID)
	require.True(t, starred.Starred)
	require.False(t, starred.Muted)
	require.False(t, starred.Read)
	require.NotNil(t, starred.FilterID)
	require.Equal(t, first.ID, *starred.FilterID)

	// 命中第二条：静音（入库但已读 + muted）
	muted := fixture.reload(t, noise.ID)
	require.True(t, muted.Muted)
	require.True(t, muted.Read, "静音的语义是入库即已读")
	require.False(t, muted.Starred)
	require.NotNil(t, muted.FilterID)
	require.Equal(t, second.ID, *muted.FilterID)

	// 审计与计数：两条规则各命中一条
	matches, err := fixture.service.ListMatches(ctx, first.ID, 10)
	require.NoError(t, err)
	require.Len(t, matches, 1)
	require.Equal(t, news.ID, matches[0].EntryID)

	updated, err := fixture.filters.GetByID(ctx, second.ID)
	require.NoError(t, err)
	require.EqualValues(t, 1, updated.MatchCount)
	require.NotNil(t, updated.LastMatchedAt)
}

// keepOnly（只保留匹配）：条件没命中的条目退化为静音；命中的条目不动。
func TestFilterService_ApplyToEntries_KeepOnlyMutesUnmatched(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "AI Weekly", "article")
	keep := fixture.seedEntry(t, feed.ID, "hash-keep", "GPT-5 发布了", timePtr(time.Now()))
	drop := fixture.seedEntry(t, feed.ID, "hash-drop", "本周行业八卦", timePtr(time.Now()))

	fixture.create(t, service.FilterWriteParams{
		Name:       "只保留 GPT 相关",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "GPT"}},
		Actions:    model.FilterActions{KeepOnly: true},
	})

	applied, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{keep, drop})
	require.NoError(t, err)
	require.Equal(t, 1, applied, "命中的那条没有动作可做，只有落空的那条被处理")

	kept := fixture.reload(t, keep.ID)
	require.False(t, kept.Muted)
	require.False(t, kept.Read)
	require.Nil(t, kept.FilterID)

	dropped := fixture.reload(t, drop.ID)
	require.True(t, dropped.Muted)
	require.True(t, dropped.Read)
}

// 「顺序 + 反动作」表达例外：更靠前的窄规则 unmute，后面的宽规则 mute。
func TestFilterService_ApplyToEntries_UnmuteException(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "雪球", "article")
	report := fixture.seedEntry(t, feed.ID, "hash-report", "某公司财报点评", timePtr(time.Now()))
	other := fixture.seedEntry(t, feed.ID, "hash-other", "闲聊帖", timePtr(time.Now()))

	exception := fixture.create(t, service.FilterWriteParams{
		Name:      "财报例外",
		ScopeType: model.FilterScopeFeed,
		ScopeID:   &feed.ID,
		Conditions: []model.FilterCondition{
			{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "财报"},
		},
		Actions: model.FilterActions{Unmute: true},
	})
	fixture.create(t, service.FilterWriteParams{
		Name:      "雪球整体静音",
		ScopeType: model.FilterScopeFeed,
		ScopeID:   &feed.ID,
		Actions:   model.FilterActions{Mute: true},
	})

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{report, other})
	require.NoError(t, err)

	exceptionEntry := fixture.reload(t, report.ID)
	require.False(t, exceptionEntry.Muted)
	require.NotNil(t, exceptionEntry.FilterID)
	require.Equal(t, exception.ID, *exceptionEntry.FilterID)

	mutedEntry := fixture.reload(t, other.ID)
	require.True(t, mutedEntry.Muted)
}

// 只有「刚入库的新条目」参与判定：已存在条目不会被追改。
func TestFilterService_ApplyToEntries_SkipsUnknownEntries(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "阮一峰", "article")
	fixture.create(t, service.FilterWriteParams{
		Name:      "全部静音",
		ScopeType: model.FilterScopeFeed,
		ScopeID:   &feed.ID,
		Actions:   model.FilterActions{Mute: true},
	})

	// 库里没有这个 hash（模拟已存在条目走更新分支）→ 引擎不应写任何东西
	unknown := model.Entry{FeedID: feed.ID, Hash: "hash-unknown", Title: strPtr("老文章")}
	applied, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{unknown})
	require.NoError(t, err)
	require.Zero(t, applied)
}

func TestFilterService_Preview_DoesNotWrite(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "Solidot", "article")
	hit := fixture.seedEntry(t, feed.ID, "hash-hit", "赞助商：某云厂商", timePtr(time.Now()))
	miss := fixture.seedEntry(t, feed.ID, "hash-miss", "开源新闻", timePtr(time.Now()))

	result, err := fixture.service.Preview(ctx, service.FilterWriteParams{
		Name:       "预览用规则",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
		Actions:    model.FilterActions{Mute: true},
	}, 100)
	require.NoError(t, err)
	require.EqualValues(t, 2, result.Scanned)
	require.Equal(t, 1, result.MatchedCount)
	require.Equal(t, 1, result.MuteCount)
	require.Len(t, result.Matched, 1)
	require.Equal(t, hit.ID, result.Matched[0].ID)

	// 干跑不落库：两条条目都没被动过，也没写审计
	require.False(t, fixture.reload(t, hit.ID).Muted)
	require.False(t, fixture.reload(t, miss.ID).Muted)
	filters, err := fixture.service.List(ctx)
	require.NoError(t, err)
	require.Empty(t, filters)
}

func TestFilterService_Revert_RestoresUnread(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "InfoQ", "article")
	mutedEntry := fixture.seedEntry(t, feed.ID, "hash-muted", "广告：训练营", timePtr(time.Now()))
	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "静音广告",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "广告"}},
		Actions:    model.FilterActions{Mute: true},
	})

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{mutedEntry})
	require.NoError(t, err)
	require.True(t, fixture.reload(t, mutedEntry.ID).Muted)

	reverted, err := fixture.service.Revert(ctx, rule.ID)
	require.NoError(t, err)
	require.EqualValues(t, 1, reverted)

	restored := fixture.reload(t, mutedEntry.ID)
	require.False(t, restored.Muted)
	require.False(t, restored.Read, "被规则标已读的条目撤销后退回未读")
	require.Nil(t, restored.FilterID)
}

func TestFilterService_CRUD_AndDeleteWithRevert(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "少数派", "article")
	entry := fixture.seedEntry(t, feed.ID, "hash-crud", "限时优惠", timePtr(time.Now()))

	first := fixture.create(t, service.FilterWriteParams{
		Name:      "规则一",
		ScopeType: model.FilterScopeFeed,
		ScopeID:   &feed.ID,
		Actions:   model.FilterActions{Mute: true},
	})
	second := fixture.create(t, service.FilterWriteParams{
		Name:      "规则二",
		ScopeType: model.FilterScopeFeed,
		ScopeID:   &feed.ID,
		Actions:   model.FilterActions{Star: true},
	})
	require.Equal(t, 0, first.Position)
	require.Equal(t, 1, second.Position)

	enabled := false
	updated, err := fixture.service.Update(ctx, second.ID, service.FilterWriteParams{
		Name:      "规则二（改名并停用）",
		Enabled:   &enabled,
		ScopeType: model.FilterScopeFeed,
		ScopeID:   &feed.ID,
		Actions:   model.FilterActions{Star: true},
	})
	require.NoError(t, err)
	require.Equal(t, "规则二（改名并停用）", updated.Name)
	require.False(t, updated.Enabled)

	// 停用的规则不参与判定
	_, err = fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	require.True(t, fixture.reload(t, entry.ID).Muted, "规则一仍然生效")
	require.False(t, fixture.reload(t, entry.ID).Starred, "停用的规则二不生效")

	// 删除并顺带撤销
	reverted, err := fixture.service.Delete(ctx, first.ID, true)
	require.NoError(t, err)
	require.EqualValues(t, 1, reverted)
	require.False(t, fixture.reload(t, entry.ID).Muted)

	filters, err := fixture.service.List(ctx)
	require.NoError(t, err)
	require.Len(t, filters, 1)

	_, err = fixture.service.Update(ctx, first.ID, service.FilterWriteParams{
		Name:      "不存在的规则",
		ScopeType: model.FilterScopeAll,
		Actions:   model.FilterActions{Mute: true},
	})
	require.ErrorIs(t, err, service.ErrFilterNotFound)
}

// 条目侧反悔：静音的条目可以被单独取消静音并回到未读流。
func TestEntryService_Unmute_Integration(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "少数派", "article")
	entry := fixture.seedEntry(t, feed.ID, "hash-unmute", "限时优惠：某训练营", timePtr(time.Now()))
	fixture.create(t, service.FilterWriteParams{
		Name:       "静音优惠",
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "优惠"}},
		Actions:    model.FilterActions{Mute: true},
	})

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)
	require.True(t, fixture.reload(t, entry.ID).Muted)

	entryService := service.NewEntryService(fixture.entries, fixture.feeds, repository.NewFolderRepository(fixture.db), fixture.filters)
	require.NoError(t, entryService.Unmute(ctx, entry.ID))

	restored := fixture.reload(t, entry.ID)
	require.False(t, restored.Muted)
	require.False(t, restored.Read)
	require.Nil(t, restored.FilterID)

	// 重复调用是幂等的
	require.NoError(t, entryService.Unmute(ctx, entry.ID))
}

// 命中日志要给人看：查询时把条目标题与来源名一起带出来。
func TestFilterService_ListMatches_CarriesEntryAndFeedTitles(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "Solidot", "article")
	entry := fixture.seedEntry(t, feed.ID, "hash-log", "赞助商投稿：某云厂商", timePtr(time.Now()))
	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "静音赞助",
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
		Actions:    model.FilterActions{Mute: true},
	})

	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{entry})
	require.NoError(t, err)

	matches, err := fixture.service.ListMatches(ctx, rule.ID, 10)
	require.NoError(t, err)
	require.Len(t, matches, 1)
	require.Equal(t, entry.ID, matches[0].EntryID)
	require.Equal(t, "赞助商投稿：某云厂商", matches[0].EntryTitle)
	require.Equal(t, "Solidot", matches[0].FeedTitle)
	require.True(t, matches[0].Actions.Mute)

	// 条目被删掉后日志还在，只是标题为空（LEFT JOIN，不该整行消失）
	_, err = fixture.db.ExecContext(ctx, `DELETE FROM entries WHERE id = ?`, entry.ID)
	require.NoError(t, err)
	matches, err = fixture.service.ListMatches(ctx, rule.ID, 10)
	require.NoError(t, err)
	require.Len(t, matches, 1)
	require.Empty(t, matches[0].EntryTitle)
}

// 手动回溯：把规则链补跑到历史条目上（首个命中即停 + 幂等）。
func TestFilterService_ApplyToHistory(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "Solidot", "article")
	sponsor := fixture.seedEntry(t, feed.ID, "hash-sponsor", "赞助商投稿：某云厂商", timePtr(time.Now()))
	gossip := fixture.seedEntry(t, feed.ID, "hash-gossip", "行业八卦：赞助商跑路", timePtr(time.Now()))
	plain := fixture.seedEntry(t, feed.ID, "hash-plain", "Linux 6.12 发布", timePtr(time.Now()))

	// 靠前的窄规则先命中（回溯也要遵守顺序）
	narrow := fixture.create(t, service.FilterWriteParams{
		Name:       "静音八卦",
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "八卦"}},
		Actions:    model.FilterActions{Mute: true},
	})
	wide := fixture.create(t, service.FilterWriteParams{
		Name:       "静音赞助商",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
		Actions:    model.FilterActions{Star: true},
	})

	scanned, applied, err := fixture.service.ApplyToHistory(ctx, wide.ID, 500)
	require.NoError(t, err)
	require.Equal(t, 3, scanned, "扫描该规则作用域内的历史条目")
	require.Equal(t, 2, applied, "「八卦」那条归属靠前规则，「赞助商」那条归属本规则")

	sponsorEntry := fixture.reload(t, sponsor.ID)
	require.True(t, sponsorEntry.Starred)
	require.NotNil(t, sponsorEntry.FilterID)
	require.Equal(t, wide.ID, *sponsorEntry.FilterID)

	gossipEntry := fixture.reload(t, gossip.ID)
	require.True(t, gossipEntry.Muted, "首个命中即停：靠前规则赢了")
	require.Equal(t, narrow.ID, *gossipEntry.FilterID)

	plainEntry := fixture.reload(t, plain.ID)
	require.False(t, plainEntry.Muted)
	require.False(t, plainEntry.Starred)
	require.Nil(t, plainEntry.FilterID, "没命中的条目不该被打标记")

	// 幂等：再点一次不重复写、不重复计数
	scanned2, applied2, err := fixture.service.ApplyToHistory(ctx, wide.ID, 500)
	require.NoError(t, err)
	require.Equal(t, 3, scanned2)
	require.Equal(t, 0, applied2)

	// 命中日志也记下了
	matches, err := fixture.service.ListMatches(ctx, wide.ID, 10)
	require.NoError(t, err)
	require.Len(t, matches, 1)
	require.Equal(t, sponsor.ID, matches[0].EntryID)

	// 不存在的规则 → ErrFilterNotFound
	_, _, err = fixture.service.ApplyToHistory(ctx, 999999, 500)
	require.ErrorIs(t, err, service.ErrFilterNotFound)
}

// 被静音的条目默认不出现在列表里，只有 mutedOnly 才单独看得到。
func TestFilterService_MutedEntriesHiddenFromList(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "知乎日报", "article")
	mutedEntry := fixture.seedEntry(t, feed.ID, "hash-hidden", "被静音的条目", timePtr(time.Now()))
	visible := fixture.seedEntry(t, feed.ID, "hash-visible", "正常条目", timePtr(time.Now()))

	fixture.create(t, service.FilterWriteParams{
		Name:       "只静音第一条",
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &feed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "被静音"}},
		Actions:    model.FilterActions{Mute: true},
	})
	_, err := fixture.service.ApplyToEntries(ctx, feed, []model.Entry{mutedEntry, visible})
	require.NoError(t, err)

	feedID := feed.ID
	defaultList, err := fixture.entries.List(ctx, repository.EntryListFilter{FeedID: &feedID, Limit: 10})
	require.NoError(t, err)
	require.Len(t, defaultList, 1)
	require.Equal(t, visible.ID, defaultList[0].ID)

	mutedList, err := fixture.entries.List(ctx, repository.EntryListFilter{FeedID: &feedID, Limit: 10, MutedOnly: true})
	require.NoError(t, err)
	require.Len(t, mutedList, 1)
	require.Equal(t, mutedEntry.ID, mutedList[0].ID)

	allList, err := fixture.entries.List(ctx, repository.EntryListFilter{FeedID: &feedID, Limit: 10, IncludeMuted: true})
	require.NoError(t, err)
	require.Len(t, allList, 2)

	// 静音条目标成已读 → 不进未读计数
	counts, err := fixture.entries.GetAllUnreadCounts(ctx)
	require.NoError(t, err)
	unread := 0
	for _, count := range counts {
		if count.FeedID == feed.ID {
			unread = count.Count
		}
	}
	require.Equal(t, 1, unread)
}

// 侧栏「收藏 / 视图」数量角标要的数：每条视图当前命中多少条。
// 语义与「按视图取列表」对齐 —— 作用域生效、AI 条件不花钱、规则（kind=rule）不参与。
func TestFilterService_CountViewMatches(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	articleFeed := fixture.seedFeed(t, "Solidot", "article")
	socialFeed := fixture.seedFeed(t, "Twitter", "social")
	fixture.seedEntry(t, articleFeed.ID, "h1", "赞助商：某云厂商", timePtr(time.Now()))
	fixture.seedEntry(t, articleFeed.ID, "h2", "开源新闻", timePtr(time.Now()))
	fixture.seedEntry(t, socialFeed.ID, "h3", "赞助商：社交里的", timePtr(time.Now()))

	// 视图一：全库 + 标题含「赞助商」 → 2 条（跨内容类型）
	viewAll, err := fixture.service.Create(ctx, service.FilterWriteParams{
		Name:       "含赞助商",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
	})
	require.NoError(t, err)

	// 视图二：只在文章那个订阅里找「开源」 → 1 条
	viewFeed, err := fixture.service.Create(ctx, service.FilterWriteParams{
		Name:       "订阅内找开源",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &articleFeed.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "开源"}},
	})
	require.NoError(t, err)

	// 同样条件的规则不该出现在计数里（侧栏只列视图）
	_, err = fixture.service.Create(ctx, service.FilterWriteParams{
		Name:       "一条规则",
		Kind:       model.FilterKindRule,
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
		Actions:    model.FilterActions{Mute: true},
	})
	require.NoError(t, err)

	// 再来一条一条都命中不了的视图：它必须出现在结果里且为 0（不是「查不到这条」）
	viewNone, err := fixture.service.Create(ctx, service.FilterWriteParams{
		Name:       "谁也匹配不上",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "不存在的词"}},
	})
	require.NoError(t, err)

	counts, err := fixture.service.CountViewMatches(ctx, nil)
	require.NoError(t, err)
	require.Len(t, counts, 3)
	require.Equal(t, 2, counts[viewAll.ID])
	require.Equal(t, 1, counts[viewFeed.ID])
	require.Equal(t, 0, counts[viewNone.ID])

	// 跟进当前内容类型：article 下「赞助商」只剩 1 条（社交那条不算）
	article := "article"
	byType, err := fixture.service.CountViewMatches(ctx, &article)
	require.NoError(t, err)
	require.Equal(t, 1, byType[viewAll.ID])
	require.Equal(t, 1, byType[viewFeed.ID])
	require.Equal(t, 0, byType[viewNone.ID])
}
