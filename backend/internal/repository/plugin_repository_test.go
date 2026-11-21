package repository_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/repository"
	"krss/backend/internal/repository/testutil"
)

func TestPluginRepository_UpsertAndList(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewPluginRepository(db)
	ctx := context.Background()

	// Upsert demo plugin enabled
	err := repo.Upsert(ctx, "demo", true)
	require.NoError(t, err)

	// Upsert another plugin disabled
	err = repo.Upsert(ctx, "bark", false)
	require.NoError(t, err)

	// List should return both
	states, err := repo.List(ctx)
	require.NoError(t, err)
	require.Len(t, states, 2)

	// Check order (sorted by id)
	require.Equal(t, "bark", states[0].ID)
	require.False(t, states[0].Enabled)
	require.Equal(t, "demo", states[1].ID)
	require.True(t, states[1].Enabled)
}

func TestPluginRepository_EnabledPersistence(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewPluginRepository(db)
	ctx := context.Background()

	// Insert with enabled=false
	err := repo.Upsert(ctx, "test-plugin", false)
	require.NoError(t, err)

	// Verify stored as false
	states, err := repo.List(ctx)
	require.NoError(t, err)
	require.Len(t, states, 1)
	require.Equal(t, "test-plugin", states[0].ID)
	require.False(t, states[0].Enabled)
}

func TestPluginRepository_UpsertIdempotent(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewPluginRepository(db)
	ctx := context.Background()

	// First upsert
	err := repo.Upsert(ctx, "demo", true)
	require.NoError(t, err)

	var firstCount int
	err = db.QueryRow(`SELECT COUNT(*) FROM plugins WHERE id='demo'`).Scan(&firstCount)
	require.NoError(t, err)
	require.Equal(t, 1, firstCount)

	// Second upsert (update)
	err = repo.Upsert(ctx, "demo", false)
	require.NoError(t, err)

	// Should still be one row
	var secondCount int
	err = db.QueryRow(`SELECT COUNT(*) FROM plugins WHERE id='demo'`).Scan(&secondCount)
	require.NoError(t, err)
	require.Equal(t, 1, secondCount)

	// But value changed to false
	states, err := repo.List(ctx)
	require.NoError(t, err)
	require.Len(t, states, 1)
	require.Equal(t, "demo", states[0].ID)
	require.False(t, states[0].Enabled)
}

// TestPluginRepository_Delete 删一个插件行：只删指定 id，别的保留；不存在不报错（卸载幂等）。
func TestPluginRepository_Delete(t *testing.T) {
	db := testutil.NewTestDB(t)
	repo := repository.NewPluginRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.Upsert(ctx, "demo", true))
	require.NoError(t, repo.Upsert(ctx, "bark", false))

	require.NoError(t, repo.Delete(ctx, "demo"))

	states, err := repo.List(ctx)
	require.NoError(t, err)
	require.Len(t, states, 1)
	require.Equal(t, "bark", states[0].ID)

	// 再删一次（已经不在了）也不报错。
	require.NoError(t, repo.Delete(ctx, "demo"))
}
