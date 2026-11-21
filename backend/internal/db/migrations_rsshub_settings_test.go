package db_test

import (
	"testing"

	"krss/backend/internal/db"

	_ "modernc.org/sqlite"

	"github.com/stretchr/testify/require"
)

// TestMigrate_RSSHubSettingsToPlugin 迁移 33：RSSHub 实例设置从本体通用设置搬进 rsshub 插件。
//
//	旧：general.rsshub_base_url / general.rsshub_access_key
//	新：plugin.rsshub.base_url / plugin.rsshub.access_key（旧键留着不删，回滚还用得着）
//
// 边界：没配过就什么都不写（别造空键）；重复跑幂等。
func TestMigrate_RSSHubSettingsToPlugin(t *testing.T) {
	conn, err := db.Open(":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	_, err = conn.Exec(`INSERT INTO settings (key, value, updated_at) VALUES
		('general.rsshub_base_url','https://rsshub.example.com','2026-01-01T00:00:00Z'),
		('general.rsshub_access_key','KEY33','2026-01-01T00:00:00Z')`)
	require.NoError(t, err)

	// db.Open 已经跑过一次全量迁移；这里再跑 ⇒ 33 重跑，顺带验一次幂等。
	require.NoError(t, db.Migrate(conn))

	var baseURL string
	require.NoError(t, conn.QueryRow(`SELECT value FROM settings WHERE key = 'plugin.rsshub.base_url'`).Scan(&baseURL))
	require.Equal(t, "https://rsshub.example.com", baseURL, "旧实例地址复制到插件键（用户不用重填）")

	var accessKey string
	require.NoError(t, conn.QueryRow(`SELECT value FROM settings WHERE key = 'plugin.rsshub.access_key'`).Scan(&accessKey))
	require.Equal(t, "KEY33", accessKey)

	// 旧键不删。
	var oldValue string
	require.NoError(t, conn.QueryRow(`SELECT value FROM settings WHERE key = 'general.rsshub_base_url'`).Scan(&oldValue))
	require.Equal(t, "https://rsshub.example.com", oldValue)

	// 幂等：再跑一次不改值、不报错。
	require.NoError(t, db.Migrate(conn))
	require.NoError(t, conn.QueryRow(`SELECT value FROM settings WHERE key = 'plugin.rsshub.base_url'`).Scan(&baseURL))
	require.Equal(t, "https://rsshub.example.com", baseURL)
}

// 没配过实例（全新实例 / 从来没用过 RSSHub）：不许造出空值的插件键，
// 否则设置页会显示「已保存」的空串，用户以为被覆盖过。
func TestMigrate_RSSHubSettingsToPlugin_NoOldKeysWritesNothing(t *testing.T) {
	conn, err := db.Open(":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	require.NoError(t, db.Migrate(conn))

	var count int
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM settings WHERE key LIKE 'plugin.rsshub.%'`).Scan(&count))
	require.Zero(t, count)
}
