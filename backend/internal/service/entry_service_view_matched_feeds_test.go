package service_test

import (
	"context"
	"testing"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
	"krss/backend/internal/service"

	"github.com/stretchr/testify/require"
)

// newEntryServiceForViews 复用 filterFixture 的真实 SQLite 仓储，构造一个 EntryService。
func newEntryServiceForViews(fixture *filterFixture) service.EntryService {
	return service.NewEntryService(
		fixture.entries,
		fixture.feeds,
		repository.NewFolderRepository(fixture.db),
		fixture.filters,
	)
}

// 正常聚合：两个以上订阅各有多个命中，count 正确；排序 count 降序、并列按 feedTitle 升序。
func TestEntryService_ListViewMatchedFeeds_AggregatesAndSorts(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feedBeta := fixture.seedFeed(t, "Beta", "article")
	feedZulu := fixture.seedFeed(t, "Zulu", "article")
	feedAlpha := fixture.seedFeed(t, "Alpha", "article")

	// Beta：3 条命中
	fixture.seedEntry(t, feedBeta.ID, "b1", "赞助商：B1", timePtr(time.Now()))
	fixture.seedEntry(t, feedBeta.ID, "b2", "赞助商：B2", timePtr(time.Now()))
	fixture.seedEntry(t, feedBeta.ID, "b3", "赞助商：B3", timePtr(time.Now()))
	// Beta 里再放一条不命中的：不能计入
	fixture.seedEntry(t, feedBeta.ID, "b4", "普通新闻", timePtr(time.Now()))
	// Zulu：2 条命中
	fixture.seedEntry(t, feedZulu.ID, "z1", "赞助商：Z1", timePtr(time.Now()))
	fixture.seedEntry(t, feedZulu.ID, "z2", "赞助商：Z2", timePtr(time.Now()))
	// Alpha：2 条命中（与 Zulu 并列，靠标题升序排在 Zulu 前）
	fixture.seedEntry(t, feedAlpha.ID, "a1", "赞助商：A1", timePtr(time.Now()))
	fixture.seedEntry(t, feedAlpha.ID, "a2", "赞助商：A2", timePtr(time.Now()))

	view := fixture.create(t, service.FilterWriteParams{
		Name:       "含赞助商",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
	})

	svc := newEntryServiceForViews(fixture)
	feeds, err := svc.ListViewMatchedFeeds(ctx, view.ID, nil)
	require.NoError(t, err)
	require.Len(t, feeds, 3)

	// count 降序：Beta(3) 第一
	require.Equal(t, feedBeta.ID, feeds[0].FeedID)
	require.Equal(t, "Beta", feeds[0].FeedTitle)
	require.Equal(t, 3, feeds[0].Count)
	// 并列 2 条按 feedTitle 升序：Alpha 在 Zulu 前
	require.Equal(t, feedAlpha.ID, feeds[1].FeedID)
	require.Equal(t, "Alpha", feeds[1].FeedTitle)
	require.Equal(t, 2, feeds[1].Count)
	require.Equal(t, feedZulu.ID, feeds[2].FeedID)
	require.Equal(t, "Zulu", feeds[2].FeedTitle)
	require.Equal(t, 2, feeds[2].Count)
}

// 没有命中内容的订阅（有内容但不命中 / 根本没内容）都不能出现在列表里。
func TestEntryService_ListViewMatchedFeeds_ExcludesFeedsWithoutMatches(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	withHit := fixture.seedFeed(t, "有命中", "article")
	noHit := fixture.seedFeed(t, "无命中", "article")
	empty := fixture.seedFeed(t, "空订阅", "article")

	fixture.seedEntry(t, withHit.ID, "h1", "赞助商的推荐", timePtr(time.Now()))
	// 有内容但标题不含关键词：不命中
	fixture.seedEntry(t, noHit.ID, "n1", "普通文章一条", timePtr(time.Now()))
	// empty 一条内容都没有

	view := fixture.create(t, service.FilterWriteParams{
		Name:       "含赞助商",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
	})

	svc := newEntryServiceForViews(fixture)
	feeds, err := svc.ListViewMatchedFeeds(ctx, view.ID, nil)
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	require.Equal(t, withHit.ID, feeds[0].FeedID)
	require.Equal(t, 1, feeds[0].Count)

	ids := make([]int64, 0, len(feeds))
	for _, f := range feeds {
		ids = append(ids, f.FeedID)
	}
	require.NotContains(t, ids, noHit.ID)
	require.NotContains(t, ids, empty.ID)
}

// 视图不存在 / kind != view → ErrNotFound。
func TestEntryService_ListViewMatchedFeeds_NotFound(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()
	svc := newEntryServiceForViews(fixture)

	// 不存在的视图 id
	_, err := svc.ListViewMatchedFeeds(ctx, 999999, nil)
	require.ErrorIs(t, err, service.ErrNotFound)

	// 存在但是规则（kind = rule），不是视图
	rule := fixture.create(t, service.FilterWriteParams{
		Name:       "这是规则不是视图",
		Kind:       model.FilterKindRule,
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
		Actions:    model.FilterActions{Mute: true},
	})
	_, err = svc.ListViewMatchedFeeds(ctx, rule.ID, nil)
	require.ErrorIs(t, err, service.ErrNotFound)
}

// contentType 传入时收窄候选条目：只统计该类型下的订阅。
func TestEntryService_ListViewMatchedFeeds_ContentTypeNarrowing(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	articleFeed := fixture.seedFeed(t, "文章订阅", "article")
	socialFeed := fixture.seedFeed(t, "社交订阅", "social")
	fixture.seedEntry(t, articleFeed.ID, "ar-1", "赞助商：文章版", timePtr(time.Now()))
	fixture.seedEntry(t, socialFeed.ID, "so-1", "赞助商：社交版", timePtr(time.Now()))

	view := fixture.create(t, service.FilterWriteParams{
		Name:       "含赞助商",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
	})

	svc := newEntryServiceForViews(fixture)

	all, err := svc.ListViewMatchedFeeds(ctx, view.ID, nil)
	require.NoError(t, err)
	require.Len(t, all, 2)

	article := "article"
	narrowed, err := svc.ListViewMatchedFeeds(ctx, view.ID, &article)
	require.NoError(t, err)
	require.Len(t, narrowed, 1)
	require.Equal(t, articleFeed.ID, narrowed[0].FeedID)
	require.Equal(t, 1, narrowed[0].Count)
}

// seedFeedInFolder 造一条属于指定文件夹的订阅。
func (f *filterFixture) seedFeedInFolder(t *testing.T, title, feedType string, folderID int64) model.Feed {
	t.Helper()
	feed := model.Feed{
		Title:    title,
		URL:      "https://example.com/" + title + ".xml",
		Type:     feedType,
		FolderID: &folderID,
	}
	feed.ID = testutil.SeedFeed(t, f.db, feed)
	return feed
}

// scope=folder：只聚合该文件夹内的订阅，别的文件夹命中不算。
func TestEntryService_ListViewMatchedFeeds_FolderScope(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	folderA := testutil.SeedFolder(t, fixture.db, "文件夹A", nil, "article")
	folderB := testutil.SeedFolder(t, fixture.db, "文件夹B", nil, "article")

	feedA := fixture.seedFeedInFolder(t, "A源", "article", folderA)
	feedB := fixture.seedFeedInFolder(t, "B源", "article", folderB)
	fixture.seedEntry(t, feedA.ID, "fa-1", "赞助商：A", timePtr(time.Now()))
	fixture.seedEntry(t, feedB.ID, "fb-1", "赞助商：B", timePtr(time.Now()))

	view := fixture.create(t, service.FilterWriteParams{
		Name:       "A文件夹含赞助商",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeFolder,
		ScopeID:    &folderA,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
	})

	svc := newEntryServiceForViews(fixture)
	feeds, err := svc.ListViewMatchedFeeds(ctx, view.ID, nil)
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	require.Equal(t, feedA.ID, feeds[0].FeedID)
	require.Equal(t, 1, feeds[0].Count)
}

// scope=feed 且 ScopeIDs 多选：只统计多选里的订阅，未选中的同关键词订阅不算。
func TestEntryService_ListViewMatchedFeeds_FeedScopeMulti(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	in1 := fixture.seedFeed(t, "选一", "article")
	in2 := fixture.seedFeed(t, "选二", "article")
	out := fixture.seedFeed(t, "未选", "article")
	fixture.seedEntry(t, in1.ID, "i1", "赞助商：1", timePtr(time.Now()))
	fixture.seedEntry(t, in2.ID, "i2", "赞助商：2", timePtr(time.Now()))
	fixture.seedEntry(t, out.ID, "o1", "赞助商：3", timePtr(time.Now()))

	view := fixture.create(t, service.FilterWriteParams{
		Name:       "多选订阅含赞助商",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeFeed,
		ScopeIDs:   []int64{in1.ID, in2.ID},
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
	})

	svc := newEntryServiceForViews(fixture)
	feeds, err := svc.ListViewMatchedFeeds(ctx, view.ID, nil)
	require.NoError(t, err)
	require.Len(t, feeds, 2)
	ids := []int64{feeds[0].FeedID, feeds[1].FeedID}
	require.ElementsMatch(t, []int64{in1.ID, in2.ID}, ids)
	require.NotContains(t, ids, out.ID)
}

// scope=feed 且单 ScopeID：只统计该订阅。
func TestEntryService_ListViewMatchedFeeds_FeedScopeSingle(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	target := fixture.seedFeed(t, "目标源", "article")
	other := fixture.seedFeed(t, "别人", "article")
	fixture.seedEntry(t, target.ID, "t1", "赞助商：目标", timePtr(time.Now()))
	// 已读的命中不算进子项未读角标（用户 2026-11-23：和「订阅」一样按未读计数）
	readTitle := "赞助商：已读"
	testutil.SeedEntry(t, fixture.db, model.Entry{FeedID: target.ID, Hash: "t2", Title: &readTitle, Read: true})
	fixture.seedEntry(t, other.ID, "x1", "赞助商：别人", timePtr(time.Now()))

	view := fixture.create(t, service.FilterWriteParams{
		Name:       "单订阅含赞助商",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeFeed,
		ScopeID:    &target.ID,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
	})

	svc := newEntryServiceForViews(fixture)
	feeds, err := svc.ListViewMatchedFeeds(ctx, view.ID, nil)
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	require.Equal(t, target.ID, feeds[0].FeedID)
	require.Equal(t, 1, feeds[0].Count, "只数未读命中，已读的那条不计入")
}

// 被静音的命中条目默认不计入（与 listByView 默认隐藏静音一致）。
func TestEntryService_ListViewMatchedFeeds_ExcludesMuted(t *testing.T) {
	fixture := newFilterFixture(t)
	ctx := context.Background()

	feed := fixture.seedFeed(t, "混音源", "article")
	fixture.seedEntry(t, feed.ID, "m-1", "赞助商：可见", timePtr(time.Now()))

	mutedTitle := "赞助商：已静音"
	muted := model.Entry{FeedID: feed.ID, Hash: "m-2", Title: &mutedTitle, Muted: true}
	testutil.SeedEntry(t, fixture.db, muted)

	view := fixture.create(t, service.FilterWriteParams{
		Name:       "含赞助商",
		Kind:       model.FilterKindView,
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助商"}},
	})

	svc := newEntryServiceForViews(fixture)
	feeds, err := svc.ListViewMatchedFeeds(ctx, view.ID, nil)
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	require.Equal(t, feed.ID, feeds[0].FeedID)
	require.Equal(t, 1, feeds[0].Count, "静音条目不应计入")
}
