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
		VALUES ('demo', 'kv', 'hello', '"world"', 1700000000)`)
	require.NoError(t, err)

	// db.Open 已经跑过一次全量迁移；再跑一次 ⇒ 34 重跑。
	require.NoError(t, db.Migrate(conn))

	var value string
	require.NoError(t, conn.QueryRow(
		`SELECT value FROM plugin_data WHERE plugin_id = 'demo' AND collection = 'kv' AND key = 'hello'`,
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
