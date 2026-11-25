package repository_test

import (
	"context"
	"krss/backend/internal/repository"
	"testing"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/repository/testutil"

	"github.com/stretchr/testify/require"
)

func TestFeedRepository_CreateAndGet(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	reminder := "聚焦核心论点"
	feed := model.Feed{
		Title:                 "Test Feed",
		URL:                   "https://example.com/feed",
		SummaryPromptReminder: &reminder,
	}

	created, err := repo.Create(ctx, feed)
	require.NoError(t, err)
	require.NotZero(t, created.ID)
	require.Equal(t, feed.Title, created.Title)
	require.Equal(t, "article", created.Type) // Default type

	fetched, err := repo.GetByID(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, created.ID, fetched.ID)
	require.Equal(t, created.Title, fetched.Title)
	require.Equal(t, created.URL, fetched.URL)
	require.NotNil(t, fetched.SummaryPromptReminder)
	require.Equal(t, reminder, *fetched.SummaryPromptReminder)
}

func TestFeedRepository_List(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	folderID := testutil.SeedFolder(t, db, "Test Folder", nil, "article")

	testutil.SeedFeed(t, db, model.Feed{Title: "Feed 1", URL: "url1", FolderID: &folderID})
	testutil.SeedFeed(t, db, model.Feed{Title: "Feed 2", URL: "url2", FolderID: nil})

	// List all
	feeds, err := repo.List(ctx, nil)
	require.NoError(t, err)
	require.Len(t, feeds, 2)

	// List by folder
	feeds, err = repo.List(ctx, &folderID)
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	require.Equal(t, "Feed 1", feeds[0].Title)
}

func TestFeedRepository_Update(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	id := testutil.SeedFeed(t, db, model.Feed{Title: "Old Title", URL: "url"})

	feed, err := repo.GetByID(ctx, id)
	require.NoError(t, err)

	feed.Title = "New Title"
	reminder := "强调数据和证据"
	feed.SummaryPromptReminder = &reminder
	updated, err := repo.Update(ctx, feed)
	require.NoError(t, err)
	require.Equal(t, "New Title", updated.Title)
	require.NotNil(t, updated.SummaryPromptReminder)
	require.Equal(t, reminder, *updated.SummaryPromptReminder)

	fetched, err := repo.GetByID(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "New Title", fetched.Title)
	require.NotNil(t, fetched.SummaryPromptReminder)
	require.Equal(t, reminder, *fetched.SummaryPromptReminder)

	feed.SummaryPromptReminder = nil
	_, err = repo.Update(ctx, feed)
	require.NoError(t, err)

	fetched, err = repo.GetByID(ctx, id)
	require.NoError(t, err)
	require.Nil(t, fetched.SummaryPromptReminder)
}

func TestFeedRepository_Delete(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	id := testutil.SeedFeed(t, db, model.Feed{Title: "To Delete", URL: "url"})

	err := repo.Delete(ctx, id)
	require.NoError(t, err)

	_, err = repo.GetByID(ctx, id)
	require.Error(t, err) // Should return sql.ErrNoRows or similar
}

func TestFeedRepository_DeleteBatch(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	id1 := testutil.SeedFeed(t, db, model.Feed{Title: "F1", URL: "u1"})
	id2 := testutil.SeedFeed(t, db, model.Feed{Title: "F2", URL: "u2"})
	id3 := testutil.SeedFeed(t, db, model.Feed{Title: "F3", URL: "u3"})

	count, err := repo.DeleteBatch(ctx, []int64{id1, id2})
	require.NoError(t, err)
	require.Equal(t, int64(2), count)

	feeds, err := repo.List(ctx, nil)
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	require.Equal(t, id3, feeds[0].ID)
}

func TestFeedRepository_FindByURL(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	testutil.SeedFeed(t, db, model.Feed{Title: "Feed", URL: "https://example.com/rss"})

	found, err := repo.FindByURL(ctx, "https://example.com/rss")
	require.NoError(t, err)
	require.NotNil(t, found)
	require.Equal(t, "Feed", found.Title)
}

func TestFeedRepository_GetByIDs(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	id1 := testutil.SeedFeed(t, db, model.Feed{Title: "Feed 1", URL: "url1"})
	id2 := testutil.SeedFeed(t, db, model.Feed{Title: "Feed 2", URL: "url2"})

	feeds, err := repo.GetByIDs(ctx, []int64{id1, id2})
	require.NoError(t, err)
	require.Len(t, feeds, 2)
}

func TestFeedRepository_ListWithoutIcon(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	icon := "icon.png"
	testutil.SeedFeed(t, db, model.Feed{Title: "With Icon", URL: "u1", IconPath: &icon})
	testutil.SeedFeed(t, db, model.Feed{Title: "No Icon", URL: "u2"})

	feeds, err := repo.ListWithoutIcon(ctx)
	require.NoError(t, err)
	require.Len(t, feeds, 1)
	require.Equal(t, "No Icon", feeds[0].Title)
}

func TestFeedRepository_UpdateIconPath(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	id := testutil.SeedFeed(t, db, model.Feed{Title: "Feed", URL: "u"})

	err := repo.UpdateIconPath(ctx, id, "icon.png")
	require.NoError(t, err)

	feed, _ := repo.GetByID(ctx, id)
	require.NotNil(t, feed.IconPath)
	require.Equal(t, "icon.png", *feed.IconPath)
}

func TestFeedRepository_UpdateSiteURL(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	id := testutil.SeedFeed(t, db, model.Feed{Title: "Feed", URL: "u"})

	err := repo.UpdateSiteURL(ctx, id, "https://example.com")
	require.NoError(t, err)

	feed, _ := repo.GetByID(ctx, id)
	require.NotNil(t, feed.SiteURL)
	require.Equal(t, "https://example.com", *feed.SiteURL)
}

func TestFeedRepository_UpdateErrorMessage(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	id := testutil.SeedFeed(t, db, model.Feed{Title: "Feed", URL: "u"})

	msg := "error"
	err := repo.UpdateErrorMessage(ctx, id, &msg)
	require.NoError(t, err)

	feed, _ := repo.GetByID(ctx, id)
	require.NotNil(t, feed.ErrorMessage)
	require.Equal(t, "error", *feed.ErrorMessage)

	err = repo.UpdateErrorMessage(ctx, id, nil)
	require.NoError(t, err)
	feed, _ = repo.GetByID(ctx, id)
	require.Nil(t, feed.ErrorMessage)
}

func TestFeedRepository_UpdateType(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	id := testutil.SeedFeed(t, db, model.Feed{Title: "Feed", URL: "u"})

	err := repo.UpdateType(ctx, id, "picture")
	require.NoError(t, err)

	feed, _ := repo.GetByID(ctx, id)
	require.Equal(t, "picture", feed.Type)
}

func TestFeedRepository_UpdateTypeByFolderID(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	folderID := testutil.SeedFolder(t, db, "Folder", nil, "article")
	testutil.SeedFeed(t, db, model.Feed{Title: "Feed 1", URL: "u1", FolderID: &folderID, Type: "article"})
	testutil.SeedFeed(t, db, model.Feed{Title: "Feed 2", URL: "u2", FolderID: &folderID, Type: "article"})

	err := repo.UpdateTypeByFolderID(ctx, folderID, "picture")
	require.NoError(t, err)

	feeds, _ := repo.List(ctx, &folderID)
	for _, feed := range feeds {
		require.Equal(t, "picture", feed.Type)
	}
}

func TestFeedRepository_ClearAllIconPaths(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	icon := "icon.png"
	testutil.SeedFeed(t, db, model.Feed{Title: "Feed 1", URL: "u1", IconPath: &icon})
	testutil.SeedFeed(t, db, model.Feed{Title: "Feed 2", URL: "u2", IconPath: &icon})

	count, err := repo.ClearAllIconPaths(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)

	feeds, _ := repo.List(ctx, nil)
	for _, feed := range feeds {
		require.Nil(t, feed.IconPath)
	}
}

func TestFeedRepository_ClearAllConditionalGet(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	etag := "etag"
	lastModified := "last"
	testutil.SeedFeed(t, db, model.Feed{Title: "Feed 1", URL: "u1", ETag: &etag, LastModified: &lastModified})
	testutil.SeedFeed(t, db, model.Feed{Title: "Feed 2", URL: "u2", ETag: &etag, LastModified: &lastModified})

	count, err := repo.ClearAllConditionalGet(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)

	feeds, _ := repo.List(ctx, nil)
	for _, feed := range feeds {
		require.Nil(t, feed.ETag)
		require.Nil(t, feed.LastModified)
	}
}

func TestFeedRepository_RecordFeedFetched(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	id := testutil.SeedFeed(t, db, model.Feed{Title: "Feed", URL: "u"})
	base := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)

	// 分支 1：success + changed → 写 last_fetched_at、no_change_streak 清零
	require.NoError(t, repo.RecordFeedFetched(ctx, id, base, true, true))
	got, err := repo.GetByID(ctx, id)
	require.NoError(t, err)
	require.NotNil(t, got.LastFetchedAt)
	require.True(t, got.LastFetchedAt.Equal(base))
	require.Equal(t, 0, got.NoChangeStreak)

	// 分支 2：success + 无变化 → streak 逐轮 +1
	require.NoError(t, repo.RecordFeedFetched(ctx, id, base.Add(time.Minute), true, false))
	got, _ = repo.GetByID(ctx, id)
	require.Equal(t, 1, got.NoChangeStreak)
	require.True(t, got.LastFetchedAt.Equal(base.Add(time.Minute)))
	require.NoError(t, repo.RecordFeedFetched(ctx, id, base.Add(2*time.Minute), true, false))
	got, _ = repo.GetByID(ctx, id)
	require.Equal(t, 2, got.NoChangeStreak)

	// 分支 3：失败 → 只更新 last_fetched_at，streak 保持不变
	require.NoError(t, repo.RecordFeedFetched(ctx, id, base.Add(3*time.Minute), false, false))
	got, _ = repo.GetByID(ctx, id)
	require.Equal(t, 2, got.NoChangeStreak)
	require.True(t, got.LastFetchedAt.Equal(base.Add(3*time.Minute)))

	// 再次 success + changed → streak 归零
	require.NoError(t, repo.RecordFeedFetched(ctx, id, base.Add(4*time.Minute), true, true))
	got, _ = repo.GetByID(ctx, id)
	require.Equal(t, 0, got.NoChangeStreak)
}
