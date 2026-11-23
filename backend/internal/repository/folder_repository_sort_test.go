package repository_test

import (
	"context"
	"krss/backend/internal/repository"
	"testing"

	"krss/backend/internal/repository/testutil"

	"github.com/stretchr/testify/require"
)

// sort_order 全为默认 0 时，List 应回退按 name 排序（保持升级前的视觉顺序）。
func TestFolderRepository_List_DefaultSortOrderFallsBackToName(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewFolderRepository(db)
	ctx := context.Background()

	// 故意打乱创建顺序，确认排序不依赖 id/插入顺序。
	testutil.SeedFolder(t, db, "Gamma", nil, "article")
	testutil.SeedFolder(t, db, "Alpha", nil, "article")
	testutil.SeedFolder(t, db, "Beta", nil, "article")

	folders, err := repo.List(ctx)
	require.NoError(t, err)
	require.Len(t, folders, 3)

	names := make([]string, 0, len(folders))
	for _, f := range folders {
		names = append(names, f.Name)
		require.Equal(t, 0, f.SortOrder, "默认应为 0")
	}
	require.Equal(t, []string{"Alpha", "Beta", "Gamma"}, names)
}

// 设置 sort_order 后，List 应改为按 sort_order 排序。
func TestFolderRepository_UpdateSortOrder_ControlsOrder(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewFolderRepository(db)
	ctx := context.Background()

	alpha := testutil.SeedFolder(t, db, "Alpha", nil, "article")
	beta := testutil.SeedFolder(t, db, "Beta", nil, "article")
	gamma := testutil.SeedFolder(t, db, "Gamma", nil, "article")

	// 期望顺序：Gamma, Alpha, Beta
	require.NoError(t, repo.UpdateSortOrder(ctx, gamma, 0))
	require.NoError(t, repo.UpdateSortOrder(ctx, alpha, 1))
	require.NoError(t, repo.UpdateSortOrder(ctx, beta, 2))

	// UpdateSortOrder 应持久化
	fetched, err := repo.GetByID(ctx, gamma)
	require.NoError(t, err)
	require.Equal(t, 0, fetched.SortOrder)

	folders, err := repo.List(ctx)
	require.NoError(t, err)
	require.Len(t, folders, 3)

	names := make([]string, 0, len(folders))
	for _, f := range folders {
		names = append(names, f.Name)
	}
	require.Equal(t, []string{"Gamma", "Alpha", "Beta"}, names)
}

// sort_order 相同（默认 0）时仍按 name 作为次级排序，保证结果稳定。
func TestFolderRepository_List_SortOrderTieBreaksByName(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewFolderRepository(db)
	ctx := context.Background()

	a := testutil.SeedFolder(t, db, "Zulu", nil, "article")
	b := testutil.SeedFolder(t, db, "Yankee", nil, "article")
	require.NoError(t, repo.UpdateSortOrder(ctx, a, 1))
	require.NoError(t, repo.UpdateSortOrder(ctx, b, 1))

	folders, err := repo.List(ctx)
	require.NoError(t, err)
	require.Len(t, folders, 2)
	require.Equal(t, "Yankee", folders[0].Name)
	require.Equal(t, "Zulu", folders[1].Name)
}
