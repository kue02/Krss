package db_test

import (
	"database/sql"
	"testing"

	"krss/backend/internal/db"

	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

// 迁移 40 的回填必须保持升级前的视觉顺序：folders 按 parent_id 分区、按 name 排；
// feeds 按 folder_id 分区、按 title 排；NULL 分区（根目录 / 未归类）各自独立成组。
func TestMigrate_SortOrderBackfill_PreservesVisualOrder(t *testing.T) {
	database, err := sql.Open("sqlite", "file:sortbackfill?mode=memory&cache=shared&_pragma=foreign_keys(1)")
	require.NoError(t, err)
	defer database.Close()

	// 仅建迁移 40 之前的旧结构（无 sort_order 列）。
	_, err = database.Exec(`
		CREATE TABLE folders (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			parent_id INTEGER,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE feeds (
			id INTEGER PRIMARY KEY,
			folder_id INTEGER,
			title TEXT NOT NULL,
			url TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`)
	require.NoError(t, err)

	// folders：根分区（parent NULL）三个人名乱序；parent=2 分区两个孩子乱序。
	_, err = database.Exec(`
		INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES
		(1, 'Beta',  NULL, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
		(2, 'Alpha', NULL, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
		(5, 'Gamma', NULL, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
		(3, 'y', 2, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
		(4, 'x', 2, '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')
	`)
	require.NoError(t, err)

	// feeds：folder 1 内乱序；folder 2 单条；NULL 分区单条。
	_, err = database.Exec(`
		INSERT INTO feeds (id, folder_id, title, url, created_at, updated_at) VALUES
		(100, 1,    'Zebra',  'https://e/100', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
		(101, 1,    'Apple',  'https://e/101', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
		(102, 2,    'Mango',  'https://e/102', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'),
		(103, NULL, 'Banana', 'https://e/103', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')
	`)
	require.NoError(t, err)

	require.NoError(t, db.Migrate(database))

	sortOrder := func(table string, id int64) int {
		var v int
		require.NoError(t, database.QueryRow(`SELECT sort_order FROM `+table+` WHERE id = ?`, id).Scan(&v))
		return v
	}

	// 根分区（parent NULL）按 name：Alpha(2)=0, Beta(1)=1, Gamma(5)=2
	require.Equal(t, 0, sortOrder("folders", 2))
	require.Equal(t, 1, sortOrder("folders", 1))
	require.Equal(t, 2, sortOrder("folders", 5))
	// parent=2 分区按 name：x(4)=0, y(3)=1
	require.Equal(t, 0, sortOrder("folders", 4))
	require.Equal(t, 1, sortOrder("folders", 3))

	// folder 1 分区按 title：Apple(101)=0, Zebra(100)=1
	require.Equal(t, 0, sortOrder("feeds", 101))
	require.Equal(t, 1, sortOrder("feeds", 100))
	// folder 2 与 NULL 分区各从 0 开始
	require.Equal(t, 0, sortOrder("feeds", 102))
	require.Equal(t, 0, sortOrder("feeds", 103))

	// 再次 Migrate 不应重复回填（用户拖拽后的顺序不能被启动覆盖）。
	_, err = database.Exec(`UPDATE folders SET sort_order = 42 WHERE id = 2`)
	require.NoError(t, err)
	require.NoError(t, db.Migrate(database))
	require.Equal(t, 42, sortOrder("folders", 2))
}
