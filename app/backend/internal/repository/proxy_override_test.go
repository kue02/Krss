package repository_test

import (
	"context"
	"database/sql"
	"testing"

	"github.com/stretchr/testify/require"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/internal/repository/testutil"
)

// 14 批（迁移 26）：feeds / folders 各加 proxy_mode + proxy_config，
// 解析顺序「订阅 → 文件夹父级链 → 全局」，第一个非 NULL 说了算。

// 新列全 NULL ⇒ 老数据行为零变化：新建的订阅/文件夹默认就是「跟随」。
func TestMigration26_NewRowsDefaultToInherit(t *testing.T) {
	db := testutil.NewTestDB(t)
	ctx := context.Background()
	feedRepo := repository.NewFeedRepository(db)
	folderRepo := repository.NewFolderRepository(db)

	folderID := testutil.SeedFolder(t, db, "技术", nil, "article")
	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "GitHub Trending", URL: "https://example.com/feed", FolderID: &folderID})

	folder, err := folderRepo.GetByID(ctx, folderID)
	require.NoError(t, err)
	require.Nil(t, folder.ProxyMode, "文件夹默认跟随上级（NULL）")
	require.Nil(t, folder.ProxyConfig)

	feed, err := feedRepo.GetByID(ctx, feedID)
	require.NoError(t, err)
	require.Nil(t, feed.ProxyMode, "订阅默认跟随上级（NULL）")
	require.Nil(t, feed.ProxyConfig)

	// 库里确实是 NULL（不是 0）
	var mode sql.NullInt64
	var cfg sql.NullString
	require.NoError(t, db.QueryRow(`SELECT proxy_mode, proxy_config FROM feeds WHERE id = ?`, feedID).Scan(&mode, &cfg))
	require.False(t, mode.Valid)
	require.False(t, cfg.Valid)
}

func TestFeedRepository_UpdateProxyOverride(t *testing.T) {
	db := testutil.NewTestDB(t)
	ctx := context.Background()
	repo := repository.NewFeedRepository(db)
	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "少数派", URL: "https://example.com/a"})

	// 走代理 + 单独指定一套
	proxyMode := model.ProxyModeProxy
	cfg := &model.ProxyOverrideConfig{Type: "socks5", Host: "127.0.0.1", Port: 1080, Username: "u", Password: "p"}
	require.NoError(t, repo.UpdateProxyOverride(ctx, feedID, &proxyMode, cfg))

	feed, err := repo.GetByID(ctx, feedID)
	require.NoError(t, err)
	require.NotNil(t, feed.ProxyMode)
	require.Equal(t, model.ProxyModeProxy, *feed.ProxyMode)
	require.NotNil(t, feed.ProxyConfig)
	require.Equal(t, "socks5", feed.ProxyConfig.Type)
	require.Equal(t, "127.0.0.1", feed.ProxyConfig.Host)
	require.Equal(t, 1080, feed.ProxyConfig.Port)
	require.Equal(t, "p", feed.ProxyConfig.Password)

	// 直连（不带单独配置）
	direct := model.ProxyModeDirect
	require.NoError(t, repo.UpdateProxyOverride(ctx, feedID, &direct, nil))
	feed, err = repo.GetByID(ctx, feedID)
	require.NoError(t, err)
	require.NotNil(t, feed.ProxyMode)
	require.Equal(t, model.ProxyModeDirect, *feed.ProxyMode)
	require.Nil(t, feed.ProxyConfig)

	// 改回「跟随」
	require.NoError(t, repo.UpdateProxyOverride(ctx, feedID, nil, nil))
	feed, err = repo.GetByID(ctx, feedID)
	require.NoError(t, err)
	require.Nil(t, feed.ProxyMode)
}

// Update()（改标题/改地址/改 AI 覆盖都走它）不能把代理覆盖冲掉。
func TestFeedRepository_UpdateKeepsProxyOverride(t *testing.T) {
	db := testutil.NewTestDB(t)
	ctx := context.Background()
	repo := repository.NewFeedRepository(db)
	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "原名", URL: "https://example.com/b"})

	proxyMode := model.ProxyModeDirect
	require.NoError(t, repo.UpdateProxyOverride(ctx, feedID, &proxyMode, nil))

	feed, err := repo.GetByID(ctx, feedID)
	require.NoError(t, err)
	feed.Title = "改名了"
	_, err = repo.Update(ctx, feed)
	require.NoError(t, err)

	updated, err := repo.GetByID(ctx, feedID)
	require.NoError(t, err)
	require.Equal(t, "改名了", updated.Title)
	require.NotNil(t, updated.ProxyMode)
	require.Equal(t, model.ProxyModeDirect, *updated.ProxyMode, "改标题不该把代理覆盖冲掉")
}

func TestFolderRepository_UpdateProxyOverride(t *testing.T) {
	db := testutil.NewTestDB(t)
	ctx := context.Background()
	repo := repository.NewFolderRepository(db)
	parentID := testutil.SeedFolder(t, db, "技术", nil, "article")
	folderID := testutil.SeedFolder(t, db, "前端", &parentID, "article")

	proxyMode := model.ProxyModeProxy
	cfg := &model.ProxyOverrideConfig{Type: "http", Host: "10.0.0.2", Port: 7890}
	require.NoError(t, repo.UpdateProxyOverride(ctx, folderID, &proxyMode, cfg))

	folder, err := repo.GetByID(ctx, folderID)
	require.NoError(t, err)
	require.NotNil(t, folder.ProxyMode)
	require.Equal(t, model.ProxyModeProxy, *folder.ProxyMode)
	require.NotNil(t, folder.ProxyConfig)
	require.Equal(t, 7890, folder.ProxyConfig.Port)

	// 列表里也要带上（设置页「按来源覆盖」用 List 拿全量）
	folders, err := repo.List(ctx)
	require.NoError(t, err)
	require.Len(t, folders, 2)
	for _, item := range folders {
		if item.ID == folderID {
			require.NotNil(t, item.ProxyMode)
			require.Equal(t, model.ProxyModeProxy, *item.ProxyMode)
		} else {
			require.Nil(t, item.ProxyMode, "父文件夹没设就该是 NULL")
		}
	}
}

// 坏 JSON 不该让整条订阅读不出来（当没配 → 退回全局）。
func TestFeedRepository_BrokenProxyConfigFallsBackToNil(t *testing.T) {
	db := testutil.NewTestDB(t)
	ctx := context.Background()
	repo := repository.NewFeedRepository(db)
	feedID := testutil.SeedFeed(t, db, model.Feed{Title: "坏 JSON", URL: "https://example.com/c"})

	_, err := db.ExecContext(ctx, `UPDATE feeds SET proxy_mode = 1, proxy_config = ? WHERE id = ?`, "{oops", feedID)
	require.NoError(t, err)

	feed, err := repo.GetByID(ctx, feedID)
	require.NoError(t, err)
	require.NotNil(t, feed.ProxyMode)
	require.Equal(t, model.ProxyModeProxy, *feed.ProxyMode)
	require.Nil(t, feed.ProxyConfig, "坏 JSON 当没配，退回全局那套")
}
