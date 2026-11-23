package repository_test

import (
	"context"
	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"testing"

	"krss/backend/internal/repository/testutil"

	"github.com/stretchr/testify/require"
)

func feedTitles(feeds []model.Feed) []string {
	titles := make([]string, 0, len(feeds))
	for _, f := range feeds {
		titles = append(titles, f.Title)
	}
	return titles
}

// sort_order 全为默认 0 时，List 应回退按 title 排序（带/不带 folderID 两分支）。
func TestFeedRepository_List_DefaultSortOrderFallsBackToTitle(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	folderID := testutil.SeedFolder(t, db, "Folder", nil, "article")
	testutil.SeedFeed(t, db, model.Feed{Title: "Zebra", URL: "url-z", FolderID: &folderID})
	testutil.SeedFeed(t, db, model.Feed{Title: "Apple", URL: "url-a", FolderID: &folderID})
	testutil.SeedFeed(t, db, model.Feed{Title: "Mango", URL: "url-m", FolderID: &folderID})

	byFolder, err := repo.List(ctx, &folderID)
	require.NoError(t, err)
	require.Len(t, byFolder, 3)
	for _, f := range byFolder {
		require.Equal(t, 0, f.SortOrder, "默认应为 0")
	}
	require.Equal(t, []string{"Apple", "Mango", "Zebra"}, feedTitles(byFolder))

	all, err := repo.List(ctx, nil)
	require.NoError(t, err)
	require.Len(t, all, 3)
	require.Equal(t, []string{"Apple", "Mango", "Zebra"}, feedTitles(all))
}

// 设置 sort_order 后，List 应改为按 sort_order 排序（带/不带 folderID 两分支）。
func TestFeedRepository_UpdateSortOrder_ControlsOrder(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	folderID := testutil.SeedFolder(t, db, "Folder", nil, "article")
	zebra := testutil.SeedFeed(t, db, model.Feed{Title: "Zebra", URL: "url-z", FolderID: &folderID})
	apple := testutil.SeedFeed(t, db, model.Feed{Title: "Apple", URL: "url-a", FolderID: &folderID})
	mango := testutil.SeedFeed(t, db, model.Feed{Title: "Mango", URL: "url-m", FolderID: &folderID})

	// 期望顺序：Zebra, Apple, Mango
	require.NoError(t, repo.UpdateSortOrder(ctx, zebra, 0))
	require.NoError(t, repo.UpdateSortOrder(ctx, apple, 1))
	require.NoError(t, repo.UpdateSortOrder(ctx, mango, 2))

	fetched, err := repo.GetByID(ctx, zebra)
	require.NoError(t, err)
	require.Equal(t, 0, fetched.SortOrder)

	byFolder, err := repo.List(ctx, &folderID)
	require.NoError(t, err)
	require.Equal(t, []string{"Zebra", "Apple", "Mango"}, feedTitles(byFolder))

	all, err := repo.List(ctx, nil)
	require.NoError(t, err)
	require.Equal(t, []string{"Zebra", "Apple", "Mango"}, feedTitles(all))
}

// 不同 folder 分区的 sort_order 互不影响，各自分区内按 sort_order 排序。
func TestFeedRepository_UpdateSortOrder_PartitionIndependent(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewFeedRepository(db)
	ctx := context.Background()

	f1 := testutil.SeedFolder(t, db, "Folder1", nil, "article")
	f2 := testutil.SeedFolder(t, db, "Folder2", nil, "article")

	// Folder1：B(0), A(1)；Folder2：C(0), D(1)
	b := testutil.SeedFeed(t, db, model.Feed{Title: "B", URL: "u-b", FolderID: &f1})
	a := testutil.SeedFeed(t, db, model.Feed{Title: "A", URL: "u-a", FolderID: &f1})
	c := testutil.SeedFeed(t, db, model.Feed{Title: "C", URL: "u-c", FolderID: &f2})
	d := testutil.SeedFeed(t, db, model.Feed{Title: "D", URL: "u-d", FolderID: &f2})
	require.NoError(t, repo.UpdateSortOrder(ctx, b, 0))
	require.NoError(t, repo.UpdateSortOrder(ctx, a, 1))
	require.NoError(t, repo.UpdateSortOrder(ctx, c, 0))
	require.NoError(t, repo.UpdateSortOrder(ctx, d, 1))

	got1, err := repo.List(ctx, &f1)
	require.NoError(t, err)
	require.Equal(t, []string{"B", "A"}, feedTitles(got1))

	got2, err := repo.List(ctx, &f2)
	require.NoError(t, err)
	require.Equal(t, []string{"C", "D"}, feedTitles(got2))
}
