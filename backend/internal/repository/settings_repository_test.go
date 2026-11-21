package repository_test

import (
	"context"
	"krss/backend/internal/repository"
	"testing"

	"krss/backend/internal/repository/testutil"

	"github.com/stretchr/testify/require"
)

func TestSettingsRepository_Set_Insert(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewSettingsRepository(db)
	ctx := context.Background()

	err := repo.Set(ctx, "test.key", "test value")
	require.NoError(t, err)

	// Verify insertion
	setting, err := repo.Get(ctx, "test.key")
	require.NoError(t, err)
	require.NotNil(t, setting)
	require.Equal(t, "test.key", setting.Key)
	require.Equal(t, "test value", setting.Value)
	require.False(t, setting.UpdatedAt.IsZero())
}

func TestSettingsRepository_Set_Update(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewSettingsRepository(db)
	ctx := context.Background()

	// Initial insertion
	testutil.SeedSetting(t, db, "test.key", "initial value")

	// Update the value
	err := repo.Set(ctx, "test.key", "updated value")
	require.NoError(t, err)

	// Verify update
	setting, err := repo.Get(ctx, "test.key")
	require.NoError(t, err)
	require.Equal(t, "updated value", setting.Value)
}

func TestSettingsRepository_Get_Success(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewSettingsRepository(db)
	ctx := context.Background()

	testutil.SeedSetting(t, db, "ai.provider", "openai")

	setting, err := repo.Get(ctx, "ai.provider")
	require.NoError(t, err)
	require.NotNil(t, setting)
	require.Equal(t, "ai.provider", setting.Key)
	require.Equal(t, "openai", setting.Value)
}

func TestSettingsRepository_Get_NotFound(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewSettingsRepository(db)
	ctx := context.Background()

	setting, err := repo.Get(ctx, "nonexistent.key")
	require.NoError(t, err)
	require.Nil(t, setting)
}

func TestSettingsRepository_GetByPrefix_Success(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewSettingsRepository(db)
	ctx := context.Background()

	// Seed multiple settings with different prefixes
	testutil.SeedSetting(t, db, "ai.provider", "openai")
	testutil.SeedSetting(t, db, "ai.api_key", "sk-test123")
	testutil.SeedSetting(t, db, "ai.model", "gpt-4")
	testutil.SeedSetting(t, db, "general.theme", "dark")

	// Get all settings with "ai." prefix
	settings, err := repo.GetByPrefix(ctx, "ai.")
	require.NoError(t, err)
	require.Len(t, settings, 3)

	// Verify all returned keys have the prefix
	for _, s := range settings {
		require.True(t, len(s.Key) >= 3 && s.Key[:3] == "ai.", "expected key with prefix 'ai.', got %s", s.Key)
	}
}

func TestSettingsRepository_Delete_Success(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewSettingsRepository(db)
	ctx := context.Background()

	testutil.SeedSetting(t, db, "test.key", "test value")

	// Delete the setting
	err := repo.Delete(ctx, "test.key")
	require.NoError(t, err)

	// Verify deletion
	setting, err := repo.Get(ctx, "test.key")
	require.NoError(t, err)
	require.Nil(t, setting)
}

func TestSettingsRepository_DeleteByPrefix(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewSettingsRepository(db)
	ctx := context.Background()

	testutil.SeedSetting(t, db, "ai.provider", "openai")
	testutil.SeedSetting(t, db, "ai.model", "gpt-4")
	testutil.SeedSetting(t, db, "other.key", "value")

	count, err := repo.DeleteByPrefix(ctx, "ai.")
	require.NoError(t, err)
	require.Equal(t, int64(2), count)

	setting, err := repo.Get(ctx, "ai.provider")
	require.NoError(t, err)
	require.Nil(t, setting)

	setting, err = repo.Get(ctx, "other.key")
	require.NoError(t, err)
	require.NotNil(t, setting)
}

// 审查 LOW-7：前缀里的 "_" 必须按字面量处理，不能当 LIKE 通配符，否则会误删别的插件设置。
func TestSettingsRepository_PrefixTreatsWildcardsLiterally(t *testing.T) {
	t.Parallel()
	db := testutil.NewTestDB(t)
	repo := repository.NewSettingsRepository(db)
	ctx := context.Background()

	testutil.SeedSetting(t, db, "plugin.my_plugin.url", "https://a.example")
	testutil.SeedSetting(t, db, "plugin.my_plugin.token", "secret")
	testutil.SeedSetting(t, db, "plugin.myXplugin.url", "https://b.example")
	testutil.SeedSetting(t, db, "other.key", "value")

	got, err := repo.GetByPrefix(ctx, "plugin.my_plugin.")
	require.NoError(t, err)
	require.Len(t, got, 2, "只应命中 my_plugin，不能把 myXplugin 也带上")

	count, err := repo.DeleteByPrefix(ctx, "plugin.my_plugin.")
	require.NoError(t, err)
	require.Equal(t, int64(2), count)

	other, err := repo.Get(ctx, "plugin.myXplugin.url")
	require.NoError(t, err)
	require.NotNil(t, other, "相似前缀的其他插件设置不许被误删")
}
