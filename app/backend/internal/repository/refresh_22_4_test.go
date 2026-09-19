package repository_test

import (
	"context"
	"testing"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/internal/repository/testutil"

	"github.com/stretchr/testify/require"
)

// 22-4：GetExistingEntry —— hash 精确命中。
func TestEntryRepository_GetExistingEntry_ByHash(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Test Feed", URL: "url"})

	title := "Item 1"
	url := "https://example.com/1"
	content := "Content 1"
	require.NoError(t, repo.CreateOrUpdate(ctx, model.Entry{
		FeedID:  feedID,
		Hash:    hashString("https://example.com/1"),
		Title:   &title,
		URL:     &url,
		Content: &content,
	}))

	got, err := repo.GetExistingEntry(ctx, feedID, hashString("https://example.com/1"), url)
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Equal(t, "Item 1", *got.Title)
	require.Equal(t, "Content 1", *got.Content)

	missing, err := repo.GetExistingEntry(ctx, feedID, hashString("nope"), "https://example.com/nope")
	require.NoError(t, err)
	require.Nil(t, missing)
}

// 22-4：GetExistingEntry —— legacy URL 兜底（GUID 变了但 URL 同一个，基准是升级前的那一行）。
func TestEntryRepository_GetExistingEntry_ByLegacyURL(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewEntryRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Test Feed", URL: "url"})

	title := "Item 1"
	url := "https://www.v2ex.com/t/1193191#reply10"
	require.NoError(t, repo.CreateOrUpdate(ctx, model.Entry{
		FeedID: feedID,
		Hash:   hashString(url),
		Title:  &title,
		URL:    &url,
	}))

	got, err := repo.GetExistingEntry(ctx, feedID, hashString("v2ex-guid-1"), url)
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Equal(t, url, *got.URL)
}

// 22-4：失败计数 +1 / 成功清零（退避状态的读写）。
func TestFeedRepository_RefreshFailureRecordAndReset(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "Fail Feed", URL: "https://fail.example/rss"})

	got, err := repo.GetByID(ctx, feedID)
	require.NoError(t, err)
	require.Equal(t, 0, got.RefreshFailCount)
	require.Nil(t, got.RefreshLastFailAt)

	failedAt := time.Now().UTC()
	require.NoError(t, repo.RecordRefreshFailure(ctx, feedID, failedAt))
	require.NoError(t, repo.RecordRefreshFailure(ctx, feedID, failedAt))

	got, err = repo.GetByID(ctx, feedID)
	require.NoError(t, err)
	require.Equal(t, 2, got.RefreshFailCount)
	require.NotNil(t, got.RefreshLastFailAt)

	require.NoError(t, repo.ResetRefreshFailure(ctx, feedID))
	got, err = repo.GetByID(ctx, feedID)
	require.NoError(t, err)
	require.Equal(t, 0, got.RefreshFailCount)
	require.Nil(t, got.RefreshLastFailAt)
}
