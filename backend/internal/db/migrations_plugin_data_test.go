package db_test

import (
	"testing"

	"krss/backend/internal/db"

	_ "modernc.org/sqlite"

	"github.com/stretchr/testify/require"
)

// TestMigrate_PluginDataTableCreate 迁移 34：plugin_data 表（插件专属数据）建表成功。
//
//	plugin_id / collection / key 三段式主键：一个插件的每个 collection 里放自己的键值，
//	collection 是插件自己起的名字（rsshub 的实例地址、bark 的推送历史之类），
//	本体不认识里面的内容，只保证隔离与幂等覆盖。
func TestMigrate_PluginDataTableCreate(t *testing.T) {
	conn, err := db.Open(":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	var name string
	require.NoError(t, conn.QueryRow(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_data'`,
	).Scan(&name))
	require.Equal(t, "plugin_data", name)

	// 列齐（顺序按建表语句）：plugin_id, collection, key, value, updated_at
	rows, err := conn.Query(`SELECT name FROM pragma_table_info('plugin_data') ORDER BY cid`)
	require.NoError(t, err)
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var col string
		require.NoError(t, rows.Scan(&col))
		cols = append(cols, col)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []string{"plugin_id", "collection", "key", "value", "updated_at"}, cols)

	// 复合主键三段都在位（PRIMARY KEY 越权 = 同键能插两条，覆盖写会变成两行脏数据）。
	var pkCols int
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('plugin_data') WHERE pk > 0`).Scan(&pkCols))
	require.Equal(t, 3, pkCols, "主键必须是 (plugin_id, collection, key) 三段")

	// collection 前缀查（列某个 collection 的全部键）要有索引。
	var idx string
	require.NoError(t, conn.QueryRow(
		`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_plugin_data_collection'`,
	).Scan(&idx))
	require.Equal(t, "idx_plugin_data_collection", idx)
}

// TestMigrate_PluginDataIdempotent 迁移重跑幂等：第二次 Migrate 不报错、不重建、不丢数据。
func TestMigrate_PluginDataIdempotent(t *testing.T) {
	conn, err := db.Open(":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	_, err = conn.Exec(`INSERT INTO plugin_data (plugin_id, collection, key, value, updated_at)
		VALUES ('sample', 'kv', 'hello', '"world"', 1700000000)`)
	require.NoError(t, err)

	// db.Open 已经跑过一次全量迁移；再跑一次 ⇒ 34/35 重跑（35 只清 demo，不许误伤别的插件）。
	require.NoError(t, db.Migrate(conn))

	var value string
	require.NoError(t, conn.QueryRow(
		`SELECT value FROM plugin_data WHERE plugin_id = 'sample' AND collection = 'kv' AND key = 'hello'`,
	).Scan(&value))
	require.Equal(t, `"world"`, value, "重跑迁移不许清数据")
}

// TestMigrate_PluginDataCompositeKey 复合主键：同 (plugin, collection, key) 再写 = 覆盖不是插新行；
// 换 collection 或换插件就是另一行（隔离）。
func TestMigrate_PluginDataCompositeKey(t *testing.T) {
	conn, err := db.Open(":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	_, err = conn.Exec(`INSERT INTO plugin_data (plugin_id, collection, key, value, updated_at)
		VALUES ('demo', 'kv', 'hello', '"one"', 1700000000)`)
	require.NoError(t, err)

	// 同键裸插：复合主键必须挡住（挡住才说明主键真的生效）。
	_, err = conn.Exec(`INSERT INTO plugin_data (plugin_id, collection, key, value, updated_at)
		VALUES ('demo', 'kv', 'hello', '"duplicate"', 1700000001)`)
	require.Error(t, err, "同 (plugin_id, collection, key) 裸插必须冲突")

	// 仓储存法：ON CONFLICT DO UPDATE ⇒ 一行、新值。
	_, err = conn.Exec(`INSERT INTO plugin_data (plugin_id, collection, key, value, updated_at)
		VALUES ('demo', 'kv', 'hello', '"two"', 1700000002)
		ON CONFLICT(plugin_id, collection, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
	require.NoError(t, err)

	var count int
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM plugin_data`).Scan(&count))
	require.Equal(t, 1, count, "覆盖写不许插新行")

	var value string
	var updatedAt int64
	require.NoError(t, conn.QueryRow(
		`SELECT value, updated_at FROM plugin_data WHERE plugin_id = 'demo' AND collection = 'kv' AND key = 'hello'`,
	).Scan(&value, &updatedAt))
	require.Equal(t, `"two"`, value)
	require.Equal(t, int64(1700000002), updatedAt)

	// 换 collection：另一行（同一个键名在别的 collection 里互不影响）。
	_, err = conn.Exec(`INSERT INTO plugin_data (plugin_id, collection, key, value, updated_at)
		VALUES ('demo', 'other', 'hello', '"three"', 1700000003)`)
	require.NoError(t, err)

	// 换插件同理。
	_, err = conn.Exec(`INSERT INTO plugin_data (plugin_id, collection, key, value, updated_at)
		VALUES ('bark', 'kv', 'hello', '"four"', 1700000004)`)
	require.NoError(t, err)

	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM plugin_data`).Scan(&count))
	require.Equal(t, 3, count)
}

// TestMigrate_RemovesDemoPluginResidue 迁移 35：Demo 样板插件从内置清单移除后，
// 老实例库里的 plugins 行 / plugin.demo.* 设置 / plugin_data 都要清干净；
// 别的插件（含名字里带 demo 的）一个字节不碰。
func TestMigrate_RemovesDemoPluginResidue(t *testing.T) {
	conn, err := db.Open(":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	// Open 时迁移 35 已跑过并记了版本；这里模拟「升级前已有 Demo 残留」的老库，重置标记后再造数据。
	_, err = conn.Exec(`DELETE FROM schema_migrations WHERE version = 35`)
	require.NoError(t, err)

	now := "2026-11-21T00:00:00Z"
	_, err = conn.Exec(`INSERT INTO plugins (id, enabled, installed_at, updated_at) VALUES
		('demo', 0, ?, ?), ('demolite', 1, ?, ?)`, now, now, now, now)
	require.NoError(t, err)
	_, err = conn.Exec(`INSERT INTO settings (key, value, updated_at) VALUES
		('plugin.demo.note', '"x"', ?), ('plugin.demolite.note', '"keep"', ?)`, now, now)
	require.NoError(t, err)
	_, err = conn.Exec(`INSERT INTO plugin_data (plugin_id, collection, key, value, updated_at) VALUES
		('demo', 'kv', 'k', '"x"', 1700000000), ('demolite', 'kv', 'k', '"keep"', 1700000000)`)
	require.NoError(t, err)

	require.NoError(t, db.Migrate(conn))

	var count int
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM plugins WHERE id = 'demo'`).Scan(&count))
	require.Zero(t, count, "demo 的 plugins 行要删掉")
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM settings WHERE key = 'plugin.demo.note'`).Scan(&count))
	require.Zero(t, count, "plugin.demo.* 设置要删掉")
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM plugin_data WHERE plugin_id = 'demo'`).Scan(&count))
	require.Zero(t, count, "demo 的插件数据要删掉")

	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM plugins WHERE id = 'demolite'`).Scan(&count))
	require.Equal(t, 1, count, "名字里带 demo 的别的插件不许误伤")
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM settings WHERE key = 'plugin.demolite.note'`).Scan(&count))
	require.Equal(t, 1, count)

	// 迁移 35 只跑一次：之后用户再装外部插件 id="demo" 并写设置/数据，后续 Migrate 不能再清掉。
	_, err = conn.Exec(`INSERT INTO plugins (id, enabled, installed_at, updated_at) VALUES ('demo', 1, ?, ?)`, now, now)
	require.NoError(t, err)
	_, err = conn.Exec(`INSERT INTO settings (key, value, updated_at) VALUES ('plugin.demo.note', '"after-upgrade"', ?)`, now)
	require.NoError(t, err)
	_, err = conn.Exec(`INSERT INTO plugin_data (plugin_id, collection, key, value, updated_at) VALUES ('demo', 'kv', 'k', '"after-upgrade"', 1700000000)`)
	require.NoError(t, err)

	require.NoError(t, db.Migrate(conn))
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM plugins WHERE id = 'demo'`).Scan(&count))
	require.Equal(t, 1, count, "迁移 35 已执行过，不能再删外部 demo 插件")
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM settings WHERE key = 'plugin.demo.note'`).Scan(&count))
	require.Equal(t, 1, count)
	require.NoError(t, conn.QueryRow(`SELECT COUNT(*) FROM plugin_data WHERE plugin_id = 'demo'`).Scan(&count))
	require.Equal(t, 1, count)
}
