//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/urlutil"
	"gist/backend/pkg/snowflake"
)

type EntryListFilter struct {
	FeedID       *int64
	FolderID     *int64
	ContentType  *string
	UnreadOnly   bool
	StarredOnly  bool
	HasThumbnail bool
	// 默认（两个都为 false）= 隐藏被规则静音的条目
	IncludeMuted bool
	MutedOnly    bool
	Limit        int
	Offset       int
}

// EntryFilterState 过滤规则要写到条目上的标记（nil 表示该位不动）。
type EntryFilterState struct {
	Muted    bool
	Read     *bool
	Starred  *bool
	FilterID int64
	// AutoTranslate / AutoSummary：条目级的「打开时自动翻译 / 摘要」标记（规则动作 translate/summarize）。
	// 只在为 true 时写；撤销规则时由 ResetFilterState 清零。
	AutoTranslate *bool
	AutoSummary   *bool
}

type UnreadCount struct {
	FeedID int64
	Count  int
}

type EntryRepository interface {
	GetByID(ctx context.Context, id int64) (model.Entry, error)
	List(ctx context.Context, filter EntryListFilter) ([]model.Entry, error)
	// Search 用 FTS5 检索条目（标题/正文/作者/链接）
	Search(ctx context.Context, keyword string, limit int) ([]model.Entry, error)
	UpdateReadStatus(ctx context.Context, id int64, read bool) error
	UpdateManyReadStatus(ctx context.Context, ids []int64, read bool) error
	UpdateStarredStatus(ctx context.Context, id int64, starred bool) error
	UpdateReadableContent(ctx context.Context, id int64, content string) error
	MarkAllAsRead(ctx context.Context, feedID *int64, folderID *int64, contentType *string) error
	GetAllUnreadCounts(ctx context.Context) ([]UnreadCount, error)
	GetStarredCount(ctx context.Context) (int, error)
	// FeedEntryStats 某个订阅的条目数与其中星标数（合并订阅时给弹框显示两边各有几条）
	FeedEntryStats(ctx context.Context, feedID int64) (total int64, starred int64, err error)
	// MoveFeedEntries 把 from 订阅的条目改归到 to：先删掉与目标同 hash 的重复项（保留目标那份），再改归属。
	// 返回 (改了归属的条数, 因重复被删掉的条数)。
	MoveFeedEntries(ctx context.Context, fromFeedID, toFeedID int64) (moved int64, deduped int64, err error)
	CreateOrUpdate(ctx context.Context, entry model.Entry) error
	ExistsByHash(ctx context.Context, feedID int64, hash string) (bool, error)
	ExistsByLegacyURL(ctx context.Context, feedID int64, rawURL string, hash string) (bool, error)
	ClearAllReadableContent(ctx context.Context) (int64, error)
	DeleteUnstarred(ctx context.Context) (int64, error)
	// GetIDsByHashes 按 feed 内 hash 批量取条目 ID（规则引擎在入库后定位刚写进去的那批条目）。
	GetIDsByHashes(ctx context.Context, feedID int64, hashes []string) (map[string]int64, error)
	// ApplyFilterState 写入规则标记（muted / filter_id，可选 read / starred）。
	ApplyFilterState(ctx context.Context, id int64, state EntryFilterState) error
	// ResetFilterState 撤销规则标记（muted 清零、filter_id 置空；restoreUnread 时把已读退回未读）。
	ResetFilterState(ctx context.Context, ids []int64, restoreUnread bool) (int64, error)
}

type entryRepository struct {
	db dbtx
}

func NewEntryRepository(db dbtx) EntryRepository {
	return &entryRepository{db: db}
}

func (r *entryRepository) GetByID(ctx context.Context, id int64) (model.Entry, error) {
	row := r.db.QueryRowContext(
		ctx,
		`SELECT id, feed_id, hash, title, url, content, readable_content, thumbnail_url, author, published_at, read, starred, muted, filter_id, auto_translate, auto_summary, created_at, updated_at
		 FROM entries WHERE id = ?`,
		id,
	)
	return scanEntry(row)
}

// Search 关键词检索条目（标题/正文/作者/链接）。
//
// 用 LIKE 子串匹配而不是 FTS5：FTS5 的 unicode61 分词把一整串中文当成一个词，
// 只有「从词首开始」的前缀能命中（搜「黄金」搜不到「今天黄金不错」里的那两个字），
// 中文场景基本不可用；NextFlux 那边也就是标题 includes 一下。条目量级（几千条）下
// LIKE 全表扫是毫秒级，够用且行为可预期。
func (r *entryRepository) Search(ctx context.Context, keyword string, limit int) ([]model.Entry, error) {
	trimmed := strings.TrimSpace(keyword)
	if trimmed == "" {
		return []model.Entry{}, nil
	}

	if limit <= 0 || limit > 200 {
		limit = 30
	}

	pattern := "%" + escapeLikePattern(trimmed) + "%"
	// muted = 0：被规则静音的条目在列表里默认隐藏，搜索口径必须一致（否则「搜得到、点开找不到」）
	query := `
		SELECT e.id, e.feed_id, e.hash, e.title, e.url, e.content, e.readable_content, e.thumbnail_url, e.author,
		       e.published_at, e.read, e.starred, e.muted, e.filter_id, e.auto_translate, e.auto_summary, e.created_at, e.updated_at
		FROM entries e
		WHERE e.muted = 0
		  AND (e.title LIKE ? ESCAPE '\'
		   OR e.content LIKE ? ESCAPE '\'
		   OR e.author LIKE ? ESCAPE '\'
		   OR e.url LIKE ? ESCAPE '\')
		ORDER BY e.published_at DESC
		LIMIT ?
	`

	rows, err := r.db.QueryContext(ctx, query, pattern, pattern, pattern, pattern, limit)
	if err != nil {
		return nil, fmt.Errorf("search entries: %w", err)
	}
	defer rows.Close()

	entries := make([]model.Entry, 0, limit)
	for rows.Next() {
		entry, scanErr := scanEntry(rows)
		if scanErr != nil {
			return nil, fmt.Errorf("scan entry: %w", scanErr)
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate entries: %w", err)
	}

	return entries, nil
}

// escapeLikePattern 转义 LIKE 的通配符，避免用户输入的 % _ 变成「匹配任意」。
func escapeLikePattern(input string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(input)
}

func (r *entryRepository) List(ctx context.Context, filter EntryListFilter) ([]model.Entry, error) {
	var args []interface{}
	query := `
		SELECT e.id, e.feed_id, e.hash, e.title, e.url, e.content, e.readable_content, e.thumbnail_url, e.author,
		       e.published_at, e.read, e.starred, e.muted, e.filter_id, e.auto_translate, e.auto_summary, e.created_at, e.updated_at
		FROM entries e
	`

	var conditions []string
	needFeedsJoin := filter.FolderID != nil || filter.ContentType != nil

	if needFeedsJoin {
		query += " INNER JOIN feeds f ON e.feed_id = f.id"
	}

	if filter.FolderID != nil {
		conditions = append(conditions, "f.folder_id = ?")
		args = append(args, *filter.FolderID)
	}

	if filter.ContentType != nil {
		conditions = append(conditions, "f.type = ?")
		args = append(args, *filter.ContentType)
	}

	if filter.FeedID != nil {
		conditions = append(conditions, "e.feed_id = ?")
		args = append(args, *filter.FeedID)
	}

	if filter.UnreadOnly {
		conditions = append(conditions, "e.read = 0")
	}

	if filter.StarredOnly {
		conditions = append(conditions, "e.starred = 1")
	}

	if filter.HasThumbnail {
		conditions = append(conditions, "e.thumbnail_url IS NOT NULL AND e.thumbnail_url != ''")
	}

	// 被规则静音的条目默认不出现在列表里；「已静音」视图里才单独看
	if filter.MutedOnly {
		conditions = append(conditions, "e.muted = 1")
	} else if !filter.IncludeMuted {
		conditions = append(conditions, "e.muted = 0")
	}

	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}

	query += " ORDER BY e.published_at DESC, e.id DESC"

	if filter.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, filter.Limit)
	}
	if filter.Offset > 0 {
		query += " OFFSET ?"
		args = append(args, filter.Offset)
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []model.Entry
	for rows.Next() {
		entry, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return entries, nil
}

// GetIDsByHashes 按 feed 内 hash 批量取条目 ID（规则引擎在入库后定位刚写进去的那批条目）。
func (r *entryRepository) GetIDsByHashes(ctx context.Context, feedID int64, hashes []string) (map[string]int64, error) {
	result := make(map[string]int64, len(hashes))
	if len(hashes) == 0 {
		return result, nil
	}

	unique := make([]string, 0, len(hashes))
	seen := make(map[string]struct{}, len(hashes))
	for _, hash := range hashes {
		if hash == "" {
			continue
		}
		if _, ok := seen[hash]; ok {
			continue
		}
		seen[hash] = struct{}{}
		unique = append(unique, hash)
	}
	if len(unique) == 0 {
		return result, nil
	}

	// SQLite 变量数有上限，分批查
	const batchSize = 400
	for start := 0; start < len(unique); start += batchSize {
		end := start + batchSize
		if end > len(unique) {
			end = len(unique)
		}
		chunk := unique[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		args := make([]interface{}, 0, len(chunk)+1)
		args = append(args, feedID)
		for _, hash := range chunk {
			args = append(args, hash)
		}

		rows, err := r.db.QueryContext(ctx,
			`SELECT hash, id FROM entries WHERE feed_id = ? AND hash IN (`+placeholders+`)`, args...)
		if err != nil {
			return result, err
		}
		for rows.Next() {
			var (
				hash string
				id   int64
			)
			if err := rows.Scan(&hash, &id); err != nil {
				rows.Close()
				return result, err
			}
			result[hash] = id
		}
		scanErr := rows.Err()
		rows.Close()
		if scanErr != nil {
			return result, scanErr
		}
	}
	return result, nil
}

// ApplyFilterState 写入规则标记（muted / filter_id，可选 read / starred）。
func (r *entryRepository) ApplyFilterState(ctx context.Context, id int64, state EntryFilterState) error {
	sets := []string{"muted = ?", "filter_id = ?"}
	args := []interface{}{boolToInt(state.Muted), state.FilterID}
	if state.Read != nil {
		sets = append(sets, "read = ?")
		args = append(args, boolToInt(*state.Read))
	}
	if state.Starred != nil {
		sets = append(sets, "starred = ?")
		args = append(args, boolToInt(*state.Starred))
	}
	if state.AutoTranslate != nil {
		sets = append(sets, "auto_translate = ?")
		args = append(args, boolToInt(*state.AutoTranslate))
	}
	if state.AutoSummary != nil {
		sets = append(sets, "auto_summary = ?")
		args = append(args, boolToInt(*state.AutoSummary))
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, formatTime(time.Now()))
	args = append(args, id)

	_, err := r.db.ExecContext(ctx, `UPDATE entries SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	return err
}

// ResetFilterState 撤销规则标记（muted 清零、filter_id 置空；restoreUnread 时把已读退回未读）。
func (r *entryRepository) ResetFilterState(ctx context.Context, ids []int64, restoreUnread bool) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}

	sets := "muted = 0, filter_id = NULL, auto_translate = 0, auto_summary = 0"
	if restoreUnread {
		sets += ", read = 0"
	}
	sets += ", updated_at = ?"
	stamp := formatTime(time.Now())

	var affected int64
	const batchSize = 400
	for start := 0; start < len(ids); start += batchSize {
		end := start + batchSize
		if end > len(ids) {
			end = len(ids)
		}
		chunk := ids[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		args := make([]interface{}, 0, len(chunk)+1)
		args = append(args, stamp)
		for _, id := range chunk {
			args = append(args, id)
		}

		result, err := r.db.ExecContext(ctx,
			`UPDATE entries SET `+sets+` WHERE id IN (`+placeholders+`)`, args...)
		if err != nil {
			return affected, err
		}
		if rows, err := result.RowsAffected(); err == nil {
			affected += rows
		}
	}
	return affected, nil
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (r *entryRepository) UpdateReadStatus(ctx context.Context, id int64, read bool) error {
	readInt := boolToInt(read)

	_, err := r.db.ExecContext(
		ctx,
		`UPDATE entries SET read = ?, updated_at = ? WHERE id = ?`,
		readInt,
		formatTime(time.Now()),
		id,
	)
	return err
}

func (r *entryRepository) UpdateManyReadStatus(ctx context.Context, ids []int64, read bool) error {
	if len(ids) == 0 {
		return nil
	}

	readInt := boolToInt(read)

	args := make([]interface{}, 0, len(ids)+2)
	args = append(args, readInt, formatTime(time.Now()))
	placeholders := make([]string, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args = append(args, id)
	}

	_, err := r.db.ExecContext(
		ctx,
		`UPDATE entries SET read = ?, updated_at = ? WHERE id IN (`+strings.Join(placeholders, ",")+")",
		args...,
	)
	return err
}

func (r *entryRepository) MarkAllAsRead(ctx context.Context, feedID *int64, folderID *int64, contentType *string) error {
	now := formatTime(time.Now())

	if folderID != nil {
		_, err := r.db.ExecContext(
			ctx,
			`UPDATE entries SET read = 1, updated_at = ?
			 WHERE feed_id IN (SELECT id FROM feeds WHERE folder_id = ?) AND read = 0`,
			now,
			*folderID,
		)
		return err
	}

	if feedID != nil {
		_, err := r.db.ExecContext(
			ctx,
			`UPDATE entries SET read = 1, updated_at = ? WHERE feed_id = ? AND read = 0`,
			now,
			*feedID,
		)
		return err
	}

	// Mark all as read with optional content type filter
	if contentType != nil {
		_, err := r.db.ExecContext(
			ctx,
			`UPDATE entries SET read = 1, updated_at = ?
			 WHERE feed_id IN (SELECT id FROM feeds WHERE type = ?) AND read = 0`,
			now,
			*contentType,
		)
		return err
	}

	// Mark all as read without filter
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE entries SET read = 1, updated_at = ? WHERE read = 0`,
		now,
	)
	return err
}

func (r *entryRepository) GetAllUnreadCounts(ctx context.Context) ([]UnreadCount, error) {
	rows, err := r.db.QueryContext(
		ctx,
		`SELECT feed_id, COUNT(*) as count FROM entries WHERE read = 0 GROUP BY feed_id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var counts []UnreadCount
	for rows.Next() {
		var uc UnreadCount
		if err := rows.Scan(&uc.FeedID, &uc.Count); err != nil {
			return nil, err
		}
		counts = append(counts, uc)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return counts, nil
}

// entryScanner is an interface for scanning entry rows.
type entryScanner interface {
	Scan(dest ...interface{}) error
}

func scanEntry(s entryScanner) (model.Entry, error) {
	var e model.Entry
	var publishedAt sql.NullString
	var createdAt, updatedAt string
	var readInt, starredInt, mutedInt, autoTranslateInt, autoSummaryInt int
	var filterID sql.NullInt64

	err := s.Scan(
		&e.ID, &e.FeedID, &e.Hash, &e.Title, &e.URL, &e.Content, &e.ReadableContent, &e.ThumbnailURL, &e.Author,
		&publishedAt, &readInt, &starredInt, &mutedInt, &filterID, &autoTranslateInt, &autoSummaryInt, &createdAt, &updatedAt,
	)
	if err != nil {
		return model.Entry{}, err
	}

	e.Read = readInt == 1
	e.Starred = starredInt == 1
	e.Muted = mutedInt == 1
	e.AutoTranslate = autoTranslateInt == 1
	e.AutoSummary = autoSummaryInt == 1
	if filterID.Valid {
		value := filterID.Int64
		e.FilterID = &value
	}
	if publishedAt.Valid {
		e.PublishedAt = parseTimePtr(publishedAt.String)
	}
	e.CreatedAt, _ = parseTime(createdAt)
	e.UpdatedAt, _ = parseTime(updatedAt)

	return e, nil
}

func parseTimePtr(s string) *time.Time {
	if s == "" {
		return nil
	}
	t, _ := parseTime(s)
	return &t
}

func (r *entryRepository) CreateOrUpdate(ctx context.Context, entry model.Entry) error {
	id := snowflake.NextID()
	now := formatTime(time.Now())

	var publishedAt interface{}
	if entry.PublishedAt != nil {
		publishedAt = formatTime(*entry.PublishedAt)
	}

	// Compatibility path:
	// legacy databases might still carry URL-derived hashes after migration.
	// If we receive the same URL with a new GUID-derived hash, upgrade that row in place
	// so the first refresh after migration doesn't create duplicates.
	if entry.URL != nil && *entry.URL != "" && entry.Hash != "" {
		normalizedURL := urlutil.StripFragment(*entry.URL)
		result, err := r.db.ExecContext(
			ctx,
			`UPDATE entries SET
			   hash = ?,
			   title = ?,
			   url = ?,
			   content = ?,
			   thumbnail_url = ?,
			   author = ?,
			   published_at = COALESCE(entries.published_at, ?),
			   updated_at = ?
			 WHERE id = (
			   SELECT id
			   FROM entries
			   WHERE feed_id = ?
			     AND hash <> ?
			     AND (
			       url = ?
			       OR (CASE WHEN instr(url, '#') > 0 THEN substr(url, 1, instr(url, '#') - 1) ELSE url END) = ?
			     )
			   ORDER BY updated_at DESC, id DESC
			   LIMIT 1
			 )
			   AND NOT EXISTS (
			     SELECT 1
			     FROM entries e2
			     WHERE e2.feed_id = ?
			       AND e2.hash = ?
			       AND e2.id <> entries.id
			   )`,
			entry.Hash,
			entry.Title,
			entry.URL,
			entry.Content,
			entry.ThumbnailURL,
			entry.Author,
			publishedAt,
			now,
			entry.FeedID,
			entry.Hash,
			entry.URL,
			normalizedURL,
			entry.FeedID,
			entry.Hash,
		)
		if err != nil {
			return err
		}
		if affected, err := result.RowsAffected(); err == nil && affected > 0 {
			return nil
		}
	}

	_, err := r.db.ExecContext(
		ctx,
		`INSERT INTO entries (id, feed_id, hash, title, url, content, thumbnail_url, author, published_at, read, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
		 ON CONFLICT(feed_id, hash) DO UPDATE SET
		   title = excluded.title,
		   url = excluded.url,
		   content = excluded.content,
		   thumbnail_url = excluded.thumbnail_url,
		   author = excluded.author,
		   published_at = COALESCE(entries.published_at, excluded.published_at),
		   updated_at = excluded.updated_at`,
		id,
		entry.FeedID,
		entry.Hash,
		entry.Title,
		entry.URL,
		entry.Content,
		entry.ThumbnailURL,
		entry.Author,
		publishedAt,
		now,
		now,
	)
	return err
}

func (r *entryRepository) ExistsByHash(ctx context.Context, feedID int64, hash string) (bool, error) {
	var count int
	err := r.db.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM entries WHERE feed_id = ? AND hash = ?`,
		feedID,
		hash,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (r *entryRepository) ExistsByLegacyURL(ctx context.Context, feedID int64, rawURL string, hash string) (bool, error) {
	trimmedURL := strings.TrimSpace(rawURL)
	if trimmedURL == "" {
		return false, nil
	}
	normalizedURL := urlutil.StripFragment(trimmedURL)

	var count int
	err := r.db.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM entries
		 WHERE feed_id = ?
		   AND hash <> ?
		   AND (
		     url = ?
		     OR (CASE WHEN instr(url, '#') > 0 THEN substr(url, 1, instr(url, '#') - 1) ELSE url END) = ?
		   )`,
		feedID,
		hash,
		trimmedURL,
		normalizedURL,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (r *entryRepository) UpdateReadableContent(ctx context.Context, id int64, content string) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE entries SET readable_content = ?, updated_at = ? WHERE id = ?`,
		content,
		formatTime(time.Now()),
		id,
	)
	return err
}

func (r *entryRepository) UpdateStarredStatus(ctx context.Context, id int64, starred bool) error {
	starredInt := 0
	if starred {
		starredInt = 1
	}

	_, err := r.db.ExecContext(
		ctx,
		`UPDATE entries SET starred = ?, updated_at = ? WHERE id = ?`,
		starredInt,
		formatTime(time.Now()),
		id,
	)
	return err
}

func (r *entryRepository) GetStarredCount(ctx context.Context) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM entries WHERE starred = 1`).Scan(&count)
	return count, err
}

func (r *entryRepository) ClearAllReadableContent(ctx context.Context) (int64, error) {
	result, err := r.db.ExecContext(ctx, `UPDATE entries SET readable_content = NULL, updated_at = ? WHERE readable_content IS NOT NULL`, formatTime(time.Now()))
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (r *entryRepository) DeleteUnstarred(ctx context.Context) (int64, error) {
	result, err := r.db.ExecContext(ctx, `DELETE FROM entries WHERE starred = 0`)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// FeedEntryStats 统计某个订阅的条目数与星标数。
func (r *entryRepository) FeedEntryStats(ctx context.Context, feedID int64) (int64, int64, error) {
	var total, starred int64
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(SUM(CASE WHEN starred THEN 1 ELSE 0 END), 0)
		   FROM entries WHERE feed_id = ?`, feedID).Scan(&total, &starred)
	if err != nil {
		return 0, 0, fmt.Errorf("feed entry stats: %w", err)
	}
	return total, starred, nil
}

// MoveFeedEntries 合并订阅用：把来源订阅的条目改归到目标订阅。
//
// entries 上有唯一索引 (feed_id, hash)，所以必须**先删掉目标已存在的同 hash 条目**再改归属，
// 否则会撞唯一约束。注意 FTS 只有 INSERT/DELETE 触发器（没有 UPDATE），改 feed_id 不碰 FTS。
//
// 刻意不用显式事务：仓储层拿到的 dbtx 只有 Query/Exec（没有 BeginTx）；而两步的顺序本身是安全的 ——
// 第一步删的只是**与目标重复**的条目（保留目标那份），即使第二步失败也只是少一批重复项，不会丢数据。
func (r *entryRepository) MoveFeedEntries(ctx context.Context, fromFeedID, toFeedID int64) (int64, int64, error) {
	del, err := r.db.ExecContext(ctx,
		`DELETE FROM entries
		  WHERE feed_id = ?
		    AND hash IN (SELECT hash FROM entries WHERE feed_id = ?)`,
		fromFeedID, toFeedID)
	if err != nil {
		return 0, 0, fmt.Errorf("delete duplicate entries: %w", err)
	}
	deduped, _ := del.RowsAffected()

	upd, err := r.db.ExecContext(ctx,
		`UPDATE entries SET feed_id = ?, updated_at = ? WHERE feed_id = ?`,
		toFeedID, time.Now().UTC(), fromFeedID)
	if err != nil {
		return 0, 0, fmt.Errorf("move entries: %w", err)
	}
	moved, _ := upd.RowsAffected()

	return moved, deduped, nil
}
