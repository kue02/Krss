package repository_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
)

// 合并订阅（RSSHub 换链接撞地址 → 用户选「合并到一个源」）时把来源条目改归目标。
// entries 上有唯一索引 (feed_id, hash)，所以「目标已有的同 hash 条目」必须先删掉来源那份，
// 否则 UPDATE feed_id 会撞唯一约束直接失败。
func TestMoveFeedEntries_DedupesAndReassigns(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	from := testutil.SeedFeed(t, db, model.Feed{Title: "From", URL: "https://rsshub.app/a"})
	to := testutil.SeedFeed(t, db, model.Feed{Title: "To", URL: "https://rsshub.example/a"})

	dupTitle := "两边都有"
	onlyTitle := "只有来源有"
	starredTitle := "来源的星标条目"

	// 目标已有 hash=dup
	testutil.SeedEntry(t, db, model.Entry{FeedID: to, Hash: "dup", Title: &dupTitle})
	// 来源：一条与目标重复、两条独有（其中一条带星标，合并后星标要跟着过去）
	testutil.SeedEntry(t, db, model.Entry{FeedID: from, Hash: "dup", Title: &dupTitle})
	testutil.SeedEntry(t, db, model.Entry{FeedID: from, Hash: "only", Title: &onlyTitle})
	testutil.SeedEntry(t, db, model.Entry{FeedID: from, Hash: "star", Title: &starredTitle, Starred: true})

	moved, deduped, err := repo.MoveFeedEntries(ctx, from, to)
	require.NoError(t, err)
	require.EqualValues(t, 2, moved, "两条独有的条目要改归目标")
	require.EqualValues(t, 1, deduped, "与目标重复的那条要删掉（保留目标那份）")

	// 来源清空
	fromTotal, fromStarred, err := repo.FeedEntryStats(ctx, from)
	require.NoError(t, err)
	require.EqualValues(t, 0, fromTotal)
	require.EqualValues(t, 0, fromStarred)

	// 目标：1(原有) + 2(并入) = 3 条，其中 1 条星标
	total, starred, err := repo.FeedEntryStats(ctx, to)
	require.NoError(t, err)
	require.EqualValues(t, 3, total)
	require.EqualValues(t, 1, starred, "星标状态随条目一起过去")

	// 题目不该出现重复题目的两条（唯一索引生效）
	var dupCount int
	require.NoError(t, db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM entries WHERE feed_id = ? AND hash = 'dup'`, to).Scan(&dupCount))
	require.Equal(t, 1, dupCount)
}

// 没有重复时就是单纯搬家
func TestMoveFeedEntries_NoDuplicates(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	from := testutil.SeedFeed(t, db, model.Feed{Title: "From", URL: "https://a"})
	to := testutil.SeedFeed(t, db, model.Feed{Title: "To", URL: "https://b"})
	title := "x"
	testutil.SeedEntry(t, db, model.Entry{FeedID: from, Hash: "h1", Title: &title})
	testutil.SeedEntry(t, db, model.Entry{FeedID: from, Hash: "h2", Title: &title})

	moved, deduped, err := repo.MoveFeedEntries(ctx, from, to)
	require.NoError(t, err)
	require.EqualValues(t, 2, moved)
	require.EqualValues(t, 0, deduped)
}
