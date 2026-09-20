package db_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"krss/backend/internal/db"

	_ "modernc.org/sqlite"

	"github.com/stretchr/testify/require"
)

// TestMigrate_MCPColumnsAndTable 迁移 27：feeds 加 source_type / mcp_config，新建 mcp_servers。
func TestMigrate_MCPColumnsAndTable(t *testing.T) {
	conn, err := db.Open(":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	require.NoError(t, db.Migrate(conn))

	for _, column := range []string{"source_type", "mcp_config"} {
		var count int
		require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('feeds') WHERE name = ?`, column).Scan(&count))
		require.Equal(t, 1, count, "feeds 缺少 %s 列", column)
	}

	var tableCount int
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'mcp_servers'`).Scan(&tableCount))
	require.Equal(t, 1, tableCount)

	for _, column := range []string{"name", "transport", "url", "headers", "enabled", "is_connected", "last_error", "tool_count", "resource_count", "purposes", "use_global_fetch"} {
		var count int
		require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('mcp_servers') WHERE name = ?`, column).Scan(&count))
		require.Equal(t, 1, count, "mcp_servers 缺少 %s 列", column)
	}
}

// TestMigrate_MCP28OAuthTransportFailure 迁移 28：只新增列（last_transport / oauth_* / last_failure），
// 不碰 27 的任何东西；新增列全可空 ⇒ 老数据零变化。
func TestMigrate_MCP28OAuthTransportFailure(t *testing.T) {
	conn, err := db.Open(":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	require.NoError(t, db.Migrate(conn))

	for _, column := range []string{
		"last_transport", "oauth_client_id", "oauth_client_secret", "oauth_access_token",
		"oauth_refresh_token", "oauth_expires_at", "oauth_token_type",
		"oauth_scope", "oauth_auth_server", "last_failure",
	} {
		var count int
		require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('mcp_servers') WHERE name = ?`, column).Scan(&count))
		require.Equal(t, 1, count, "mcp_servers 缺少 28 列 %s", column)
	}

	// 可空验证：不带 28 列插入一行（模拟 27 时代的老行），再读出来
	_, err = conn.Exec(`INSERT INTO mcp_servers (id, name, transport, url, auth_type, created_at, updated_at)
		VALUES (1, 'old', 'streamable-http', 'http://x/mcp', 'none', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')`)
	require.NoError(t, err)
	var lastTransport, oauthToken, lastFailure sql.NullString
	require.NoError(t, conn.QueryRow(`SELECT last_transport, oauth_access_token, last_failure FROM mcp_servers WHERE id = 1`).Scan(&lastTransport, &oauthToken, &lastFailure))
	require.False(t, lastTransport.Valid)
	require.False(t, oauthToken.Valid)
	require.False(t, lastFailure.Valid)
}

// TestMigrate_MCPDoesNotTouchOldData 老库升级：新列都有默认值 ⇒ 老数据零变化。
// 做法：先造一个「没有 MCP 两列」的老 feeds 表 + 一行老数据，再跑迁移。
func TestMigrate_MCPDoesNotTouchOldData(t *testing.T) {
	conn, err := sql.Open("sqlite", "file:old_data?mode=memory&cache=shared")
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	_, err = conn.Exec(`
		CREATE TABLE feeds (
			id INTEGER PRIMARY KEY,
			folder_id INTEGER,
			title TEXT NOT NULL,
			url TEXT NOT NULL UNIQUE,
			site_url TEXT,
			description TEXT,
			summary_prompt_reminder TEXT,
			etag TEXT,
			last_modified TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`)
	require.NoError(t, err)
	now := time.Now().UTC().Format(time.RFC3339)
	_, err = conn.Exec(`INSERT INTO feeds (id, title, url, created_at, updated_at) VALUES (1, '老订阅', 'https://old.example/feed', ?, ?)`, now, now)
	require.NoError(t, err)

	require.NoError(t, db.Migrate(conn))

	var sourceType string
	var mcpConfig sql.NullString
	require.NoError(t, conn.QueryRow(`SELECT source_type, mcp_config FROM feeds WHERE id = 1`).Scan(&sourceType, &mcpConfig))
	require.Equal(t, "rss", sourceType, "老数据升级后必须是 rss（默认值）")
	require.False(t, mcpConfig.Valid, "老数据的 mcp_config 必须是 NULL")

	// 老数据的其它字段也不能被动过
	var title, url string
	require.NoError(t, conn.QueryRow(`SELECT title, url FROM feeds WHERE id = 1`).Scan(&title, &url))
	require.Equal(t, "老订阅", title)
	require.Equal(t, "https://old.example/feed", url)

	// 迁移可重复执行（幂等）
	require.NoError(t, db.Migrate(conn))
	var rows int
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM feeds`).Scan(&rows))
	require.Equal(t, 1, rows)

	// 未指定 source_type 的新插入走列默认值
	_, err = conn.ExecContext(context.Background(), `INSERT INTO feeds (id, title, url, created_at, updated_at) VALUES (2, '新的', 'https://new.example/feed', ?, ?)`, now, now)
	require.NoError(t, err)
	require.NoError(t, conn.QueryRow(`SELECT source_type FROM feeds WHERE id = 2`).Scan(&sourceType))
	require.Equal(t, "rss", sourceType)
}
