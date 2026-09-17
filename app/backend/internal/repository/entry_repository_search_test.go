package repository_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/internal/repository/testutil"
)

// 关键词检索：标题/正文/作者/链接都能命中，大小写不敏感，中文任意位置可搜
func TestEntryRepository_Search(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Feed", URL: "https://example.com/feed"})

	seed := func(title, content, author string) int64 {
		titleVal := title
		contentVal := content
		authorVal := author
		return testutil.SeedEntry(t, db, model.Entry{
			FeedID:  feedID,
			Title:   &titleVal,
			Content: &contentVal,
			Author:  &authorVal,
			URL:     &titleVal,
		})
	}

	steamID := seed("Steam 喜+1", "今天可以免费领取 Space Menace", "小声逼逼")
	seed("比特幣行情", "BTC 今天又跌了", "百萬Eric")

	results, err := repo.Search(ctx, "steam", 20)
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Equal(t, steamID, results[0].ID)

	// 命中正文
	results, err = repo.Search(ctx, "Space Menace", 20)
	require.NoError(t, err)
	require.Len(t, results, 1)

	// 大小写不敏感 + 词中命中
	results, err = repo.Search(ctx, "Stea", 20)
	require.NoError(t, err)
	require.Len(t, results, 1, "大小写不敏感、词中也能命中")

	// 正文里的中文（词中位置）能搜到 —— 这正是 FTS5 unicode61 做不到、改用 LIKE 的原因
	results, err = repo.Search(ctx, "免费领取", 20)
	require.NoError(t, err)
	require.Len(t, results, 1, "正文中文命中")

	// 命中作者
	results, err = repo.Search(ctx, "小声逼逼", 20)
	require.NoError(t, err)
	require.Len(t, results, 1)
}

// 空关键词返回空集（不是全量）
func TestEntryRepository_Search_EmptyKeyword(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)

	results, err := repo.Search(context.Background(), "   ", 20)
	require.NoError(t, err)
	require.Empty(t, results)
}

// LIKE 通配符要转义：用户搜 % 或 _ 时不能变成「匹配任意」
func TestEntryRepository_Search_SpecialCharacters(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Feed", URL: "https://example.com/feed2"})
	title := "A & B \"quoted\" *star*"
	testutil.SeedEntry(t, db, model.Entry{FeedID: feedID, Title: &title, URL: &title})

	results, err := repo.Search(ctx, `A & B "quoted" *star*`, 20)
	require.NoError(t, err)
	require.Len(t, results, 1)

	// % 不该当成通配符（否则会匹配到所有条目）
	results, err = repo.Search(ctx, "%", 20)
	require.NoError(t, err)
	require.Empty(t, results)

	// _ 同理
	results, err = repo.Search(ctx, "_", 20)
	require.NoError(t, err)
	require.Empty(t, results)
}
