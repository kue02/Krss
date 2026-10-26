package db_test

import (
	"testing"

	"krss/backend/internal/db"

	_ "modernc.org/sqlite"

	"github.com/stretchr/testify/require"
)

// TestMigrate_NotifyToBarkPlugin 迁移 32：「推送」动作搬进 bark 插件。
//
//	旧：filters.actions.notify=true + notifyUrl → 新：pluginActions[{plugin:bark, action:notify, config:{url}}]
//	旧全局键：notify.bark_url → plugin.bark.url（复制，旧键留着）
//
// 边界：没有 notify 的规则一个字不动；解析不了的老数据跳过（迁移不能把规则搞坏）；重复跑不叠引用。
func TestMigrate_NotifyToBarkPlugin(t *testing.T) {
	conn, err := db.Open(":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	insertFilter := func(id int64, name string, position int, actions string) {
		_, err := conn.Exec(`INSERT INTO filters (id, name, enabled, position, kind, scope_type, conditions, actions, match_count, created_at, updated_at)
			VALUES (?, ?, 1, ?, 'rule', 'all', '[]', ?, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
			id, name, position, actions)
		require.NoError(t, err)
	}

	// 旧数据：一条带 notify 的规则、一条静音规则（不该被碰）、一条 actions 是坏 JSON 的老行（跳过）。
	insertFilter(1, "推送到手机", 0, `{"notify":true,"notifyUrl":"https://api.day.app/RULEKEY"}`)
	insertFilter(2, "静音", 1, `{"mute":true}`)
	insertFilter(3, "坏数据", 2, `not-json-at-all`)
	_, err = conn.Exec(`INSERT INTO settings (key, value, updated_at) VALUES ('notify.bark_url','https://api.day.app/GLOBAL','2026-01-01T00:00:00Z')`)
	require.NoError(t, err)

	// 触发迁移（db.Open 已经跑过一次全量，这里再跑 ⇒ 32 重跑，顺带验一次幂等）。
	require.NoError(t, db.Migrate(conn))

	var actions string
	require.NoError(t, conn.QueryRow(`SELECT actions FROM filters WHERE id = 1`).Scan(&actions))
	require.NotContains(t, actions, `"notify":true`, "旧 notify 标记要摘掉")
	require.NotContains(t, actions, `"notifyUrl"`, "旧地址键要摘掉（地址搬进插件动作 config）")
	require.JSONEq(t, `{
		"mute":false,"unmute":false,"markRead":false,"markUnread":false,
		"star":false,"unstar":false,"keepOnly":false,"translate":false,"summarize":false,
		"webhook":false,"notify":false,
		"pluginActions":[{"plugin":"bark","action":"notify","config":{"url":"https://api.day.app/RULEKEY"}}]
	}`, actions)

	require.NoError(t, conn.QueryRow(`SELECT actions FROM filters WHERE id = 2`).Scan(&actions))
	require.JSONEq(t, `{"mute":true}`, actions, "没有 notify 的规则一个字都不动")

	require.NoError(t, conn.QueryRow(`SELECT actions FROM filters WHERE id = 3`).Scan(&actions))
	require.Equal(t, "not-json-at-all", actions, "解析不了的老数据原样留着")

	var url string
	require.NoError(t, conn.QueryRow(`SELECT value FROM settings WHERE key = 'plugin.bark.url'`).Scan(&url))
	require.Equal(t, "https://api.day.app/GLOBAL", url, "旧全局地址复制到插件键（用户不用重填）")

	// 旧键不删（回滚还用得着）。
	var oldValue string
	require.NoError(t, conn.QueryRow(`SELECT value FROM settings WHERE key = 'notify.bark_url'`).Scan(&oldValue))
	require.Equal(t, "https://api.day.app/GLOBAL", oldValue)

	// 幂等：再跑一次不重复追加 pluginActions。
	require.NoError(t, db.Migrate(conn))
	require.NoError(t, conn.QueryRow(`SELECT actions FROM filters WHERE id = 1`).Scan(&actions))
	require.Equal(t, 1, countSubstring(actions, `"plugin":"bark"`), "重复迁移不许叠加引用")
}

func countSubstring(haystack, needle string) int {
	count := 0
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			count++
		}
	}
	return count
}
