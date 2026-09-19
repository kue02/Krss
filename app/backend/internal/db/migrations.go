package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"gist/backend/internal/hashutil"
	"gist/backend/internal/urlutil"
)

// Base schema - uses Snowflake IDs (no AUTOINCREMENT)
const baseSchema = `
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id);

CREATE TABLE IF NOT EXISTS feeds (
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
  updated_at TEXT NOT NULL,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_feeds_folder_id ON feeds(folder_id);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  feed_id INTEGER NOT NULL,
  hash TEXT NOT NULL DEFAULT '',
  title TEXT,
  url TEXT,
  content TEXT,
  author TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entries_feed_id ON entries(feed_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title,
  content,
  author,
  url,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, content, author, url)
  VALUES (new.id, new.title, new.content, new.author, new.url);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  DELETE FROM entries_fts WHERE rowid = old.id;
END;
`

func Migrate(db *sql.DB) error {
	// Run base schema first (without read column)
	if _, err := db.Exec(baseSchema); err != nil {
		return fmt.Errorf("migrate base schema: %w", err)
	}

	// Run incremental migrations
	if err := runMigrations(db); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}

	return nil
}

func runMigrations(db *sql.DB) error {
	// Migration 1: Add read column to entries if not exists
	var count int
	err := db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info('entries') WHERE name = 'read'
	`).Scan(&count)
	if err != nil {
		return fmt.Errorf("check read column: %w", err)
	}

	if count == 0 {
		if _, err := db.Exec(`ALTER TABLE entries ADD COLUMN read INTEGER NOT NULL DEFAULT 0`); err != nil {
			return fmt.Errorf("add read column: %w", err)
		}
	}

	// Create indexes (safe to run even if they exist)
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_entries_read ON entries(read)`); err != nil {
		return fmt.Errorf("create idx_entries_read: %w", err)
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_entries_feed_read ON entries(feed_id, read)`); err != nil {
		return fmt.Errorf("create idx_entries_feed_read: %w", err)
	}

	// Migration 3: Drop the UPDATE trigger (causes issues with FTS5 on read status changes)
	// RSS entries rarely change content after insertion, so we only need INSERT/DELETE triggers
	if _, err := db.Exec(`DROP TRIGGER IF EXISTS entries_au`); err != nil {
		return fmt.Errorf("drop entries_au trigger: %w", err)
	}

	// Migration 4: Add readable_content column to entries for readability-extracted content
	err = db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info('entries') WHERE name = 'readable_content'
	`).Scan(&count)
	if err != nil {
		return fmt.Errorf("check readable_content column: %w", err)
	}

	if count == 0 {
		if _, err := db.Exec(`ALTER TABLE entries ADD COLUMN readable_content TEXT`); err != nil {
			return fmt.Errorf("add readable_content column: %w", err)
		}
	}

	// Migration 5: Add icon_path column to feeds for cached icon file path
	err = db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info('feeds') WHERE name = 'icon_path'
	`).Scan(&count)
	if err != nil {
		return fmt.Errorf("check icon_path column: %w", err)
	}

	if count == 0 {
		if _, err := db.Exec(`ALTER TABLE feeds ADD COLUMN icon_path TEXT`); err != nil {
			return fmt.Errorf("add icon_path column: %w", err)
		}
	}

	// Migration 6: Add thumbnail_url column to entries for article cover image
	err = db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info('entries') WHERE name = 'thumbnail_url'
	`).Scan(&count)
	if err != nil {
		return fmt.Errorf("check thumbnail_url column: %w", err)
	}

	if count == 0 {
		if _, err := db.Exec(`ALTER TABLE entries ADD COLUMN thumbnail_url TEXT`); err != nil {
			return fmt.Errorf("add thumbnail_url column: %w", err)
		}
	}

	// Migration 7: Add starred column to entries for bookmarking
	err = db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info('entries') WHERE name = 'starred'
	`).Scan(&count)
	if err != nil {
		return fmt.Errorf("check starred column: %w", err)
	}

	if count == 0 {
		if _, err := db.Exec(`ALTER TABLE entries ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`); err != nil {
			return fmt.Errorf("add starred column: %w", err)
		}
	}

	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_entries_starred ON entries(starred)`); err != nil {
		return fmt.Errorf("create idx_entries_starred: %w", err)
	}

	// Migration 8: Add error_message column to feeds for tracking fetch/refresh errors
	err = db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info('feeds') WHERE name = 'error_message'
	`).Scan(&count)
	if err != nil {
		return fmt.Errorf("check error_message column: %w", err)
	}

	if count == 0 {
		if _, err := db.Exec(`ALTER TABLE feeds ADD COLUMN error_message TEXT`); err != nil {
			return fmt.Errorf("add error_message column: %w", err)
		}
	}

	// Migration 9: Create settings table for key-value configuration storage
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("create settings table: %w", err)
	}

	// Migration 10: Create ai_summaries table for AI summary cache
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS ai_summaries (
			id INTEGER PRIMARY KEY,
			entry_id INTEGER NOT NULL,
			is_readability INTEGER NOT NULL DEFAULT 0,
			language TEXT NOT NULL,
			summary TEXT NOT NULL,
			created_at TEXT NOT NULL,
			FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
		)
	`); err != nil {
		return fmt.Errorf("create ai_summaries table: %w", err)
	}

	if _, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_summaries_entry_mode ON ai_summaries(entry_id, is_readability, language)`); err != nil {
		return fmt.Errorf("create idx_ai_summaries_entry_mode: %w", err)
	}

	// Migration 11: Create ai_translations table for AI translation cache
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS ai_translations (
			id INTEGER PRIMARY KEY,
			entry_id INTEGER NOT NULL,
			is_readability INTEGER NOT NULL DEFAULT 0,
			language TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL,
			FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
		)
	`); err != nil {
		return fmt.Errorf("create ai_translations table: %w", err)
	}

	if _, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_translations_entry_mode ON ai_translations(entry_id, is_readability, language)`); err != nil {
		return fmt.Errorf("create idx_ai_translations_entry_mode: %w", err)
	}

	// Migration 12: Create ai_list_translations table for title/summary translation cache
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS ai_list_translations (
			id INTEGER PRIMARY KEY,
			entry_id INTEGER NOT NULL,
			language TEXT NOT NULL,
			title TEXT NOT NULL,
			summary TEXT NOT NULL,
			created_at TEXT NOT NULL,
			FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
		)
	`); err != nil {
		return fmt.Errorf("create ai_list_translations table: %w", err)
	}

	if _, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_list_translations_entry_lang ON ai_list_translations(entry_id, language)`); err != nil {
		return fmt.Errorf("create idx_ai_list_translations_entry_lang: %w", err)
	}

	// Migration 13: Add type column to feeds for content type (article/picture/notification)
	err = db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info('feeds') WHERE name = 'type'
	`).Scan(&count)
	if err != nil {
		return fmt.Errorf("check feeds type column: %w", err)
	}

	if count == 0 {
		if _, err := db.Exec(`ALTER TABLE feeds ADD COLUMN type TEXT NOT NULL DEFAULT 'article'`); err != nil {
			return fmt.Errorf("add feeds type column: %w", err)
		}
	}

	// Migration 14: Add type column to folders for content type (article/picture/notification)
	err = db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info('folders') WHERE name = 'type'
	`).Scan(&count)
	if err != nil {
		return fmt.Errorf("check folders type column: %w", err)
	}

	if count == 0 {
		if _, err := db.Exec(`ALTER TABLE folders ADD COLUMN type TEXT NOT NULL DEFAULT 'article'`); err != nil {
			return fmt.Errorf("add folders type column: %w", err)
		}
	}

	// Migration 15: Fix FTS5 delete trigger (modernc.org/sqlite doesn't support the special insert syntax)
	// Recreate the trigger with direct DELETE syntax
	if _, err := db.Exec(`DROP TRIGGER IF EXISTS entries_ad`); err != nil {
		return fmt.Errorf("drop entries_ad trigger: %w", err)
	}
	if _, err := db.Exec(`CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
		DELETE FROM entries_fts WHERE rowid = old.id;
	END`); err != nil {
		return fmt.Errorf("create entries_ad trigger: %w", err)
	}

	// Migration 16: Create domain_rate_limits table for per-host rate limiting
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS domain_rate_limits (
			id INTEGER PRIMARY KEY,
			host TEXT NOT NULL UNIQUE,
			interval_seconds INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("create domain_rate_limits table: %w", err)
	}

	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_domain_rate_limits_host ON domain_rate_limits(host)`); err != nil {
		return fmt.Errorf("create idx_domain_rate_limits_host: %w", err)
	}

	// Migration 17: Switch entry dedup key to hash and merge historical duplicates.
	if err := migrateEntryHashDeduplication(db); err != nil {
		return fmt.Errorf("migrate entry hash deduplication: %w", err)
	}

	// Migration 18: Add summary_prompt_reminder column to feeds for per-feed summarize prompt customization.
	err = db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info('feeds') WHERE name = 'summary_prompt_reminder'
	`).Scan(&count)
	if err != nil {
		return fmt.Errorf("check feeds summary_prompt_reminder column: %w", err)
	}

	if count == 0 {
		if _, err := db.Exec(`ALTER TABLE feeds ADD COLUMN summary_prompt_reminder TEXT`); err != nil {
			return fmt.Errorf("add feeds summary_prompt_reminder column: %w", err)
		}
	}

	// Migration 19/20: 每个订阅可单独覆盖「自动翻译 / 自动摘要 / 正文打开方式」
	// （NULL = 跟随全局设置；reader_mode 1=阅读模式 0=原文）
	for _, column := range []string{"auto_translate", "auto_summary", "reader_mode"} {
		err = db.QueryRow(`
			SELECT COUNT(*) FROM pragma_table_info('feeds') WHERE name = ?
		`, column).Scan(&count)
		if err != nil {
			return fmt.Errorf("check feeds %s column: %w", column, err)
		}
		if count == 0 {
			if _, err := db.Exec(`ALTER TABLE feeds ADD COLUMN ` + column + ` INTEGER`); err != nil {
				return fmt.Errorf("add feeds %s column: %w", column, err)
			}
		}
	}

	// Migration 21: 过滤规则（自动化）
	// filters = 规则本体（conditions/actions 存 JSON），filter_matches = 命中审计（供「为什么看不到这条」与一键反悔）
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS filters (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			position INTEGER NOT NULL DEFAULT 0,
			scope_type TEXT NOT NULL DEFAULT 'all',
			scope_id INTEGER,
			conditions TEXT NOT NULL DEFAULT '[]',
			actions TEXT NOT NULL DEFAULT '{}',
			match_count INTEGER NOT NULL DEFAULT 0,
			last_matched_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("create filters table: %w", err)
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_filters_scope ON filters(scope_type, scope_id)`); err != nil {
		return fmt.Errorf("create filters scope index: %w", err)
	}

	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS filter_matches (
			id INTEGER PRIMARY KEY,
			filter_id INTEGER NOT NULL,
			entry_id INTEGER NOT NULL,
			actions TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("create filter_matches table: %w", err)
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_filter_matches_entry ON filter_matches(entry_id)`); err != nil {
		return fmt.Errorf("create filter_matches entry index: %w", err)
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_filter_matches_filter ON filter_matches(filter_id, id DESC)`); err != nil {
		return fmt.Errorf("create filter_matches filter index: %w", err)
	}

	// muted = 被规则静音（与 read 区分：可回看、可一键反悔）；filter_id = 最后命中的那条规则
	if err := addColumnIfMissing(db, "entries", "muted", `ALTER TABLE entries ADD COLUMN muted INTEGER NOT NULL DEFAULT 0`); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "entries", "filter_id", `ALTER TABLE entries ADD COLUMN filter_id INTEGER`); err != nil {
		return err
	}

	// Migration 22: 动作扩充（P2）与「保存筛选视图」
	//   entries.auto_translate / auto_summary —— 规则命中后打的条目级标记：
	//   打开这条时自动翻译 / 自动摘要（复用既有 SSE 通道，入库时不花 AI token）。
	//   filters.kind —— rule（命中执行动作）/ view（只筛条目、不写数据）。
	//   filters.last_error / last_error_at —— 规则执行失败的可见出口（webhook 投递失败、AI 判定失败）。
	if err := addColumnIfMissing(db, "entries", "auto_translate", `ALTER TABLE entries ADD COLUMN auto_translate INTEGER NOT NULL DEFAULT 0`); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "entries", "auto_summary", `ALTER TABLE entries ADD COLUMN auto_summary INTEGER NOT NULL DEFAULT 0`); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "filters", "kind", `ALTER TABLE filters ADD COLUMN kind TEXT NOT NULL DEFAULT 'rule'`); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "filters", "last_error", `ALTER TABLE filters ADD COLUMN last_error TEXT`); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "filters", "last_error_at", `ALTER TABLE filters ADD COLUMN last_error_at TEXT`); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_filters_kind ON filters(kind)`); err != nil {
		return fmt.Errorf("create filters kind index: %w", err)
	}

	// Migration 23: AI 条件（P3）的判定缓存 —— 同一条目同一个问题只问模型一次。
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS entry_ai_judgements (
			id INTEGER PRIMARY KEY,
			entry_id INTEGER NOT NULL,
			question_hash TEXT NOT NULL,
			verdict INTEGER NOT NULL,
			model TEXT,
			created_at TEXT NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("create entry_ai_judgements table: %w", err)
	}
	if _, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_ai_judgements_unique ON entry_ai_judgements(entry_id, question_hash)`); err != nil {
		return fmt.Errorf("create entry_ai_judgements index: %w", err)
	}

	// Migration 24: 规则/视图的「范围」支持多选订阅（用户 11-16）。
	//   filters.scope_ids —— JSON 数组（订阅 id）；空 = 沿用 scope_id 的单个订阅/分类语义。
	//   所以老数据不用回填：scope_type='feed' 且 scope_ids 有值时按集合判定，否则仍看 scope_id。
	if err := addColumnIfMissing(db, "filters", "scope_ids", `ALTER TABLE filters ADD COLUMN scope_ids TEXT`); err != nil {
		return err
	}

	// Migration 25: 视图的「只在哪些内容类型下显示」与「自定义图标」（用户 11-5）。
	//   filters.content_types —— JSON 数组（article/picture/notification/social）；空 = 所有视图都显示（老行为）。
	//   filters.icon —— 图标：`builtin:<key>` / `emoji:<字符>` / `data:image/...`（上传后 128px 缩放，与头像同一套）。
	if err := addColumnIfMissing(db, "filters", "content_types", `ALTER TABLE filters ADD COLUMN content_types TEXT`); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "filters", "icon", `ALTER TABLE filters ADD COLUMN icon TEXT`); err != nil {
		return err
	}

	// Migration 26: 代理按来源生效（用户 14 批）—— feeds / folders 各加两列：
	//   proxy_mode   NULL = 跟随上级（订阅 → 文件夹父级链 → 全局），1 = 走代理，0 = 直连
	//   proxy_config JSON（可空）= 这一层单独指定的一套代理；空 = 用全局那套
	// 新列全 NULL ⇒ 老数据行为零变化；解析顺序「订阅 → 文件夹（含父级链）→ 全局」，
	// 第一个非 NULL 说了算（见 internal/service/proxy_source_service.go）。
	// 注意：既有 GetProxyURL() 的语义一行没动，按来源取是另开的入口。
	if err := addColumnIfMissing(db, "feeds", "proxy_mode", `ALTER TABLE feeds ADD COLUMN proxy_mode INTEGER`); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "feeds", "proxy_config", `ALTER TABLE feeds ADD COLUMN proxy_config TEXT`); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "folders", "proxy_mode", `ALTER TABLE folders ADD COLUMN proxy_mode INTEGER`); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "folders", "proxy_config", `ALTER TABLE folders ADD COLUMN proxy_config TEXT`); err != nil {
		return err
	}

	// Migration 28: 刷新失败退避（用户 22-4：「连续失败降频」）。
	//   feeds.refresh_fail_count —— 连续失败次数（成功一次就清零）；
	//   feeds.refresh_last_fail_at —— 最近一次失败时间（UTC，RFC3339）。
	//   定时刷新用这两列算「下次允许抓取」的时间点，连续失败的源自动降频，而不是每轮跟着陪跑。
	//   注意编号：26（代理）/ 27（MCP）被并行树占用，新的从 28 起。
	if err := addColumnIfMissing(db, "feeds", "refresh_fail_count", `ALTER TABLE feeds ADD COLUMN refresh_fail_count INTEGER NOT NULL DEFAULT 0`); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "feeds", "refresh_last_fail_at", `ALTER TABLE feeds ADD COLUMN refresh_last_fail_at TEXT`); err != nil {
		return err
	}

	return nil
}

// addColumnIfMissing 幂等地加列（pragma_table_info 守卫），用于增量迁移。
func addColumnIfMissing(db *sql.DB, table string, column string, statement string) error {
	var count int
	if err := db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?
	`, table, column).Scan(&count); err != nil {
		return fmt.Errorf("check %s %s column: %w", table, column, err)
	}
	if count > 0 {
		return nil
	}
	if _, err := db.Exec(statement); err != nil {
		return fmt.Errorf("add %s %s column: %w", table, column, err)
	}
	return nil
}

type dedupeEntry struct {
	id        int64
	feedID    int64
	url       string
	title     string
	content   string
	read      int
	starred   int
	updatedAt time.Time
}

type dedupeGroup struct {
	keep       dedupeEntry
	hasKeep    bool
	readMax    int
	starredMax int
	duplicate  []int64
}

func migrateEntryHashDeduplication(db *sql.DB) error {
	var hashIndexCount int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_entries_feed_hash'`,
	).Scan(&hashIndexCount); err != nil {
		return fmt.Errorf("check idx_entries_feed_hash: %w", err)
	}
	if hashIndexCount > 0 {
		return nil
	}

	exists, err := hasColumn(db, "entries", "hash")
	if err != nil {
		return fmt.Errorf("check hash column: %w", err)
	}
	if !exists {
		if _, err := db.Exec(`ALTER TABLE entries ADD COLUMN hash TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("add hash column: %w", err)
		}
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := mergeHistoricalEntries(tx); err != nil {
		return err
	}
	if err := backfillEntryHash(tx); err != nil {
		return err
	}
	if err := ensureHashUniqueness(tx); err != nil {
		return err
	}
	if _, err := tx.Exec(`DROP INDEX IF EXISTS idx_entries_feed_url`); err != nil {
		return fmt.Errorf("drop idx_entries_feed_url: %w", err)
	}
	if _, err := tx.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_feed_hash ON entries(feed_id, hash)`); err != nil {
		return fmt.Errorf("create idx_entries_feed_hash: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

func hasColumn(db *sql.DB, table string, column string) (bool, error) {
	var count int
	if err := db.QueryRow(
		fmt.Sprintf(`SELECT COUNT(*) FROM pragma_table_info('%s') WHERE name = ?`, table),
		column,
	).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

func mergeHistoricalEntries(tx *sql.Tx) error {
	rows, err := tx.Query(`
		SELECT id, feed_id, url, title, content, read, starred, updated_at
		FROM entries
	`)
	if err != nil {
		return fmt.Errorf("query entries for merge: %w", err)
	}
	defer rows.Close()

	groups := make(map[string]*dedupeGroup)
	for rows.Next() {
		var (
			entry        dedupeEntry
			urlStr       sql.NullString
			titleStr     sql.NullString
			contentStr   sql.NullString
			updatedAtStr string
		)
		if err := rows.Scan(
			&entry.id,
			&entry.feedID,
			&urlStr,
			&titleStr,
			&contentStr,
			&entry.read,
			&entry.starred,
			&updatedAtStr,
		); err != nil {
			return fmt.Errorf("scan entry for merge: %w", err)
		}
		entry.url = strings.TrimSpace(urlStr.String)
		entry.title = strings.TrimSpace(titleStr.String)
		entry.content = strings.TrimSpace(contentStr.String)
		entry.updatedAt, _ = time.Parse(time.RFC3339, updatedAtStr)

		groupKey := fmt.Sprintf("%d|%s", entry.feedID, legacyMergeKey(entry))
		group, ok := groups[groupKey]
		if !ok {
			groups[groupKey] = &dedupeGroup{
				keep:       entry,
				hasKeep:    true,
				readMax:    entry.read,
				starredMax: entry.starred,
			}
			continue
		}

		if entry.read > group.readMax {
			group.readMax = entry.read
		}
		if entry.starred > group.starredMax {
			group.starredMax = entry.starred
		}

		if chooseAsKeep(entry, group.keep) {
			group.duplicate = append(group.duplicate, group.keep.id)
			group.keep = entry
		} else {
			group.duplicate = append(group.duplicate, entry.id)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate entries for merge: %w", err)
	}

	for _, group := range groups {
		if !group.hasKeep || len(group.duplicate) == 0 {
			continue
		}

		if group.keep.read != group.readMax || group.keep.starred != group.starredMax {
			if _, err := tx.Exec(
				`UPDATE entries SET read = ?, starred = ? WHERE id = ?`,
				group.readMax,
				group.starredMax,
				group.keep.id,
			); err != nil {
				return fmt.Errorf("update merged entry state: %w", err)
			}
		}

		for _, duplicateID := range group.duplicate {
			if err := moveEntryCaches(tx, duplicateID, group.keep.id); err != nil {
				return err
			}
		}

		if err := deleteEntriesByID(tx, group.duplicate); err != nil {
			return err
		}
	}

	return nil
}

func moveEntryCaches(tx *sql.Tx, fromID int64, toID int64) error {
	tables := []string{"ai_summaries", "ai_translations", "ai_list_translations"}
	for _, table := range tables {
		updateQuery := fmt.Sprintf(`UPDATE OR IGNORE %s SET entry_id = ? WHERE entry_id = ?`, table)
		if _, err := tx.Exec(updateQuery, toID, fromID); err != nil {
			return fmt.Errorf("update %s entry_id: %w", table, err)
		}

		deleteQuery := fmt.Sprintf(`DELETE FROM %s WHERE entry_id = ?`, table)
		if _, err := tx.Exec(deleteQuery, fromID); err != nil {
			return fmt.Errorf("delete %s duplicate rows: %w", table, err)
		}
	}
	return nil
}

func deleteEntriesByID(tx *sql.Tx, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}

	// Keep each statement below SQLite variable limits.
	const batchSize = 500
	for start := 0; start < len(ids); start += batchSize {
		end := start + batchSize
		if end > len(ids) {
			end = len(ids)
		}

		chunk := ids[start:end]
		args := make([]interface{}, 0, len(chunk))
		placeholders := make([]string, 0, len(chunk))
		for _, id := range chunk {
			args = append(args, id)
			placeholders = append(placeholders, "?")
		}

		query := fmt.Sprintf(`DELETE FROM entries WHERE id IN (%s)`, strings.Join(placeholders, ","))
		if _, err := tx.Exec(query, args...); err != nil {
			return fmt.Errorf("delete duplicate entries: %w", err)
		}
	}
	return nil
}

func backfillEntryHash(tx *sql.Tx) error {
	rows, err := tx.Query(`SELECT id, url, title, content FROM entries WHERE hash = ''`)
	if err != nil {
		return fmt.Errorf("query entries for hash backfill: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id       int64
			urlStr   sql.NullString
			titleStr sql.NullString
			bodyStr  sql.NullString
		)
		if err := rows.Scan(&id, &urlStr, &titleStr, &bodyStr); err != nil {
			return fmt.Errorf("scan entry for hash backfill: %w", err)
		}

		link := strings.TrimSpace(urlStr.String)
		title := strings.TrimSpace(titleStr.String)
		content := strings.TrimSpace(bodyStr.String)

		var hash string
		switch {
		case link != "":
			hash = hashHex(link)
		case title != "" || content != "":
			hash = hashHex(title + content)
		default:
			hash = hashHex(fmt.Sprintf("legacy-entry-id:%d", id))
		}

		if _, err := tx.Exec(`UPDATE entries SET hash = ? WHERE id = ?`, hash, id); err != nil {
			return fmt.Errorf("update entry hash: %w", err)
		}
	}

	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate entries for hash backfill: %w", err)
	}

	return nil
}

func ensureHashUniqueness(tx *sql.Tx) error {
	var duplicateGroups int
	if err := tx.QueryRow(`
		SELECT COUNT(*) FROM (
			SELECT feed_id, hash, COUNT(*) AS c
			FROM entries
			GROUP BY feed_id, hash
			HAVING c > 1
		)
	`).Scan(&duplicateGroups); err != nil {
		return fmt.Errorf("check hash uniqueness: %w", err)
	}
	if duplicateGroups > 0 {
		return fmt.Errorf("found %d duplicate (feed_id, hash) groups after merge", duplicateGroups)
	}
	return nil
}

func legacyMergeKey(entry dedupeEntry) string {
	if entry.url != "" {
		return "url:" + urlutil.StripFragment(entry.url)
	}
	if entry.title != "" || entry.content != "" {
		return "content:" + entry.title + "\n" + entry.content
	}
	return fmt.Sprintf("id:%d", entry.id)
}

func chooseAsKeep(candidate dedupeEntry, current dedupeEntry) bool {
	if candidate.updatedAt.After(current.updatedAt) {
		return true
	}
	if candidate.updatedAt.Equal(current.updatedAt) && candidate.id > current.id {
		return true
	}
	return false
}

func hashHex(input string) string {
	return hashutil.SHA256Hex(input)
}
