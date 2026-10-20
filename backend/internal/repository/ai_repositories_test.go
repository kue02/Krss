package repository_test

import (
	"context"
	"krss/backend/internal/repository"
	"testing"

	"krss/backend/internal/model"
	"krss/backend/internal/repository/testutil"

	"github.com/stretchr/testify/require"
)

func TestAISummaryRepository(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewAISummaryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	entryID := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID})

	// Save
	err := repo.Save(ctx, entryID, false, "zh-CN", "summary content")
	require.NoError(t, err)

	// Get
	summary, err := repo.Get(ctx, entryID, false, "zh-CN")
	require.NoError(t, err)
	require.NotNil(t, summary)
	require.Equal(t, "summary content", summary.Summary)

	// Update (Conflict)
	err = repo.Save(ctx, entryID, false, "zh-CN", "updated summary")
	require.NoError(t, err)
	summary, _ = repo.Get(ctx, entryID, false, "zh-CN")
	require.Equal(t, "updated summary", summary.Summary)

	// Delete All
	count, err := repo.DeleteAll(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	// Delete By Entry
	err = repo.DeleteByEntryID(ctx, entryID)
	require.NoError(t, err)
}

func TestAITranslationRepository(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewAITranslationRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	entryID := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID})

	// Save
	err := repo.Save(ctx, entryID, false, "en-US", "translated html")
	require.NoError(t, err)

	// Get
	trans, err := repo.Get(ctx, entryID, false, "en-US")
	require.NoError(t, err)
	require.NotNil(t, trans)
	require.Equal(t, "translated html", trans.Content)

	// Delete By Entry
	err = repo.DeleteByEntryID(ctx, entryID)
	require.NoError(t, err)
	trans, _ = repo.Get(ctx, entryID, false, "en-US")
	require.Nil(t, trans)

	// Delete All
	count, err := repo.DeleteAll(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(0), count)
}

func TestAIListTranslationRepository(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewAIListTranslationRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	entryID := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID})

	// Save
	err := repo.Save(ctx, entryID, "en-US", "Trans Title", "Trans Summary")
	require.NoError(t, err)

	// Get
	trans, err := repo.Get(ctx, entryID, "en-US")
	require.NoError(t, err)
	require.NotNil(t, trans)
	require.Equal(t, "Trans Title", trans.Title)

	// Delete All
	count, err := repo.DeleteAll(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)
}

func TestAIListTranslationRepository_GetBatchAndDelete(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewAIListTranslationRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	entryID1 := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID})
	entryID2 := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID})

	err := repo.Save(ctx, entryID1, "en-US", "Title 1", "Summary 1")
	require.NoError(t, err)
	err = repo.Save(ctx, entryID2, "en-US", "Title 2", "Summary 2")
	require.NoError(t, err)

	batch, err := repo.GetBatch(ctx, []int64{entryID1, entryID2}, "en-US")
	require.NoError(t, err)
	require.Len(t, batch, 2)

	err = repo.DeleteByEntryID(ctx, entryID1)
	require.NoError(t, err)
	remaining, err := repo.GetBatch(ctx, []int64{entryID1, entryID2}, "en-US")
	require.NoError(t, err)
	require.Len(t, remaining, 1)
}

// ── 54-1：整篇译文的批量读 ─────────────────────────────────────────────

func TestAITranslationRepository_GetBatch(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewAITranslationRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "F", URL: "u"})
	e1 := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID})
	e2 := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID})
	e3 := testutil.SeedEntry(t, db, model.Entry{FeedID: feedID})

	require.NoError(t, repo.Save(ctx, e1, false, "zh-CN", "译文一"))
	require.NoError(t, repo.Save(ctx, e2, false, "zh-CN", "译文二"))
	// e3 没缓存 ⇒ 结果里不出现
	// 同一条目的可读模式译文是另一行，不能串到非可读查询里
	require.NoError(t, repo.Save(ctx, e1, true, "zh-CN", "可读模式译文"))
	// 别的语言也不能串进来
	require.NoError(t, repo.Save(ctx, e2, false, "en-US", "english"))

	got, err := repo.GetBatch(ctx, []int64{e1, e2, e3}, false, "zh-CN")
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Equal(t, "译文一", got[e1].Content)
	require.Equal(t, "译文二", got[e2].Content)
	require.NotContains(t, got, e3)

	// 可读模式单独一批
	gotReadable, err := repo.GetBatch(ctx, []int64{e1, e2}, true, "zh-CN")
	require.NoError(t, err)
	require.Len(t, gotReadable, 1)
	require.Equal(t, "可读模式译文", gotReadable[e1].Content)

	// 重复 id 不炸、结果不变
	gotDup, err := repo.GetBatch(ctx, []int64{e1, e1, e2}, false, "zh-CN")
	require.NoError(t, err)
	require.Len(t, gotDup, 2)

	// 空入参返回空 map 且不报错
	gotEmpty, err := repo.GetBatch(ctx, nil, false, "zh-CN")
	require.NoError(t, err)
	require.Empty(t, gotEmpty)
}
