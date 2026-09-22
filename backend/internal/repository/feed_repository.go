//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"krss/backend/internal/model"
	"krss/backend/pkg/snowflake"
)

type FeedRepository interface {
	Create(ctx context.Context, feed model.Feed) (model.Feed, error)
	GetByID(ctx context.Context, id int64) (model.Feed, error)
	GetByIDs(ctx context.Context, ids []int64) ([]model.Feed, error)
	FindByURL(ctx context.Context, url string) (*model.Feed, error)
	List(ctx context.Context, folderID *int64) ([]model.Feed, error)
	ListWithoutIcon(ctx context.Context) ([]model.Feed, error)
	Update(ctx context.Context, feed model.Feed) (model.Feed, error)
	UpdateIconPath(ctx context.Context, id int64, iconPath string) error
	UpdateErrorMessage(ctx context.Context, id int64, errorMessage *string) error
	// RecordRefreshFailure 连续失败计数 +1 并打上失败时间（22-4 退避用；SQL 里原子加，不怕并发轮）。
	RecordRefreshFailure(ctx context.Context, id int64, failedAt time.Time) error
	// ResetRefreshFailure 抓取成功一次就清零（22-4）。
	ResetRefreshFailure(ctx context.Context, id int64) error
	UpdateType(ctx context.Context, id int64, feedType string) error
	// UpdateProxyOverride 只写代理覆盖两列（迁移 26）：mode nil = 跟随文件夹链 → 全局。
	UpdateProxyOverride(ctx context.Context, id int64, mode *model.ProxyMode, cfg *model.ProxyOverrideConfig) error
	UpdateTypeByFolderID(ctx context.Context, folderID int64, feedType string) error
	Delete(ctx context.Context, id int64) error
	DeleteBatch(ctx context.Context, ids []int64) (int64, error)
	ClearAllIconPaths(ctx context.Context) (int64, error)
	ClearAllConditionalGet(ctx context.Context) (int64, error)
	UpdateSiteURL(ctx context.Context, id int64, siteURL string) error
}

type feedRepository struct {
	db dbtx
}

func NewFeedRepository(db dbtx) FeedRepository {
	return &feedRepository{db: db}
}

func (r *feedRepository) Create(ctx context.Context, feed model.Feed) (model.Feed, error) {
	feed.ID = snowflake.NextID()
	now := time.Now().UTC()
	if feed.Type == "" {
		feed.Type = "article"
	}
	_, err := r.db.ExecContext(
		ctx,
		`INSERT INTO feeds (id, folder_id, title, url, site_url, description, summary_prompt_reminder, type, etag, last_modified, error_message, created_at, updated_at, source_type, mcp_config)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		feed.ID,
		nullableInt64(feed.FolderID),
		feed.Title,
		feed.URL,
		nullableString(feed.SiteURL),
		nullableString(feed.Description),
		nullableString(feed.SummaryPromptReminder),
		feed.Type,
		nullableString(feed.ETag),
		nullableString(feed.LastModified),
		nullableString(feed.ErrorMessage),
		formatTime(now),
		formatTime(now),
		feedSourceTypeOrDefault(feed),
		nullableString(feed.MCPConfig),
	)
	if err != nil {
		return model.Feed{}, fmt.Errorf("create feed: %w", err)
	}
	feed.CreatedAt = now
	feed.UpdatedAt = now
	return feed, nil
}

func (r *feedRepository) GetByID(ctx context.Context, id int64) (model.Feed, error) {
	row := r.db.QueryRowContext(ctx, `SELECT id, folder_id, title, url, site_url, description, summary_prompt_reminder, icon_path, type, etag, last_modified, error_message, created_at, updated_at, auto_translate, auto_summary, reader_mode, proxy_mode, proxy_config, refresh_fail_count, refresh_last_fail_at, source_type, mcp_config FROM feeds WHERE id = ?`, id)
	return scanFeed(row)
}

func (r *feedRepository) GetByIDs(ctx context.Context, ids []int64) ([]model.Feed, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := strings.Repeat("?,", len(ids)-1) + "?"
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := r.db.QueryContext(ctx, `SELECT id, folder_id, title, url, site_url, description, summary_prompt_reminder, icon_path, type, etag, last_modified, error_message, created_at, updated_at, auto_translate, auto_summary, reader_mode, proxy_mode, proxy_config, refresh_fail_count, refresh_last_fail_at, source_type, mcp_config FROM feeds WHERE id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, fmt.Errorf("get feeds by ids: %w", err)
	}
	defer rows.Close()

	var feeds []model.Feed
	for rows.Next() {
		feed, err := scanFeed(rows)
		if err != nil {
			return nil, err
		}
		feeds = append(feeds, feed)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate feeds: %w", err)
	}
	return feeds, nil
}

func (r *feedRepository) FindByURL(ctx context.Context, url string) (*model.Feed, error) {
	row := r.db.QueryRowContext(ctx, `SELECT id, folder_id, title, url, site_url, description, summary_prompt_reminder, icon_path, type, etag, last_modified, error_message, created_at, updated_at, auto_translate, auto_summary, reader_mode, proxy_mode, proxy_config, refresh_fail_count, refresh_last_fail_at, source_type, mcp_config FROM feeds WHERE url = ?`, url)
	feed, err := scanFeed(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("find feed: %w", err)
	}
	return &feed, nil
}

func (r *feedRepository) List(ctx context.Context, folderID *int64) ([]model.Feed, error) {
	query := `SELECT id, folder_id, title, url, site_url, description, summary_prompt_reminder, icon_path, type, etag, last_modified, error_message, created_at, updated_at, auto_translate, auto_summary, reader_mode, proxy_mode, proxy_config, refresh_fail_count, refresh_last_fail_at, source_type, mcp_config FROM feeds ORDER BY title`
	args := []interface{}{}
	if folderID != nil {
		query = `SELECT id, folder_id, title, url, site_url, description, summary_prompt_reminder, icon_path, type, etag, last_modified, error_message, created_at, updated_at, auto_translate, auto_summary, reader_mode, proxy_mode, proxy_config, refresh_fail_count, refresh_last_fail_at, source_type, mcp_config FROM feeds WHERE folder_id = ? ORDER BY title`
		args = append(args, *folderID)
	}
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list feeds: %w", err)
	}
	defer rows.Close()

	var feeds []model.Feed
	for rows.Next() {
		feed, err := scanFeed(rows)
		if err != nil {
			return nil, err
		}
		feeds = append(feeds, feed)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate feeds: %w", err)
	}

	return feeds, nil
}

func (r *feedRepository) ListWithoutIcon(ctx context.Context) ([]model.Feed, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id, folder_id, title, url, site_url, description, summary_prompt_reminder, icon_path, type, etag, last_modified, error_message, created_at, updated_at, auto_translate, auto_summary, reader_mode, proxy_mode, proxy_config, refresh_fail_count, refresh_last_fail_at, source_type, mcp_config FROM feeds WHERE icon_path IS NULL OR icon_path = ''`)
	if err != nil {
		return nil, fmt.Errorf("list feeds without icon: %w", err)
	}
	defer rows.Close()

	var feeds []model.Feed
	for rows.Next() {
		feed, err := scanFeed(rows)
		if err != nil {
			return nil, err
		}
		feeds = append(feeds, feed)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate feeds: %w", err)
	}

	return feeds, nil
}

func (r *feedRepository) Update(ctx context.Context, feed model.Feed) (model.Feed, error) {
	now := time.Now().UTC()
	proxyConfig, err := marshalProxyConfig(feed.ProxyConfig)
	if err != nil {
		return model.Feed{}, fmt.Errorf("marshal feed proxy config: %w", err)
	}
	_, err = r.db.ExecContext(
		ctx,
		`UPDATE feeds SET folder_id = ?, title = ?, url = ?, site_url = ?, description = ?, summary_prompt_reminder = ?, auto_translate = ?, auto_summary = ?, reader_mode = ?, proxy_mode = ?, proxy_config = ?, etag = ?, last_modified = ?, error_message = ?, source_type = COALESCE(NULLIF(?, ''), source_type), mcp_config = COALESCE(?, mcp_config), updated_at = ? WHERE id = ?`,
		nullableInt64(feed.FolderID),
		feed.Title,
		feed.URL,
		nullableString(feed.SiteURL),
		nullableString(feed.Description),
		nullableString(feed.SummaryPromptReminder),
		nullableBool(feed.AutoTranslate),
		nullableBool(feed.AutoSummary),
		nullableBool(feed.ReaderMode),
		nullableProxyMode(feed.ProxyMode),
		proxyConfig,
		nullableString(feed.ETag),
		nullableString(feed.LastModified),
		nullableString(feed.ErrorMessage),
		feedSourceType(feed),
		nullableString(feed.MCPConfig),
		formatTime(now),
		feed.ID,
	)
	if err != nil {
		return model.Feed{}, fmt.Errorf("update feed: %w", err)
	}
	feed.UpdatedAt = now
	return feed, nil
}

// UpdateProxyOverride 只写代理覆盖两列（订阅级）：mode nil = 跟随上级，config nil = 用全局那套。
func (r *feedRepository) UpdateProxyOverride(ctx context.Context, id int64, mode *model.ProxyMode, cfg *model.ProxyOverrideConfig) error {
	proxyConfig, err := marshalProxyConfig(cfg)
	if err != nil {
		return fmt.Errorf("marshal feed proxy config: %w", err)
	}
	_, err = r.db.ExecContext(
		ctx,
		`UPDATE feeds SET proxy_mode = ?, proxy_config = ?, updated_at = ? WHERE id = ?`,
		nullableProxyMode(mode),
		proxyConfig,
		formatTime(time.Now()),
		id,
	)
	return err
}

func (r *feedRepository) UpdateIconPath(ctx context.Context, id int64, iconPath string) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE feeds SET icon_path = ?, updated_at = ? WHERE id = ?`,
		iconPath,
		formatTime(time.Now()),
		id,
	)
	return err
}

func (r *feedRepository) UpdateSiteURL(ctx context.Context, id int64, siteURL string) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE feeds SET site_url = ?, updated_at = ? WHERE id = ?`,
		siteURL,
		formatTime(time.Now()),
		id,
	)
	return err
}

func (r *feedRepository) UpdateErrorMessage(ctx context.Context, id int64, errorMessage *string) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE feeds SET error_message = ?, updated_at = ? WHERE id = ?`,
		nullableString(errorMessage),
		formatTime(time.Now()),
		id,
	)
	return err
}

func (r *feedRepository) RecordRefreshFailure(ctx context.Context, id int64, failedAt time.Time) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE feeds SET refresh_fail_count = refresh_fail_count + 1, refresh_last_fail_at = ? WHERE id = ?`,
		formatTime(failedAt.UTC()),
		id,
	)
	return err
}

func (r *feedRepository) ResetRefreshFailure(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE feeds SET refresh_fail_count = 0, refresh_last_fail_at = NULL WHERE id = ?`,
		id,
	)
	return err
}

func (r *feedRepository) UpdateType(ctx context.Context, id int64, feedType string) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE feeds SET type = ?, updated_at = ? WHERE id = ?`,
		feedType,
		formatTime(time.Now()),
		id,
	)
	return err
}

func (r *feedRepository) UpdateTypeByFolderID(ctx context.Context, folderID int64, feedType string) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE feeds SET type = ?, updated_at = ? WHERE folder_id = ?`,
		feedType,
		formatTime(time.Now()),
		folderID,
	)
	return err
}

func (r *feedRepository) Delete(ctx context.Context, id int64) error {
	if _, err := r.db.ExecContext(ctx, `DELETE FROM feeds WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete feed: %w", err)
	}
	return nil
}

func (r *feedRepository) DeleteBatch(ctx context.Context, ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	// Build placeholder string: ?,?,?...
	placeholders := strings.Repeat("?,", len(ids)-1) + "?"
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	result, err := r.db.ExecContext(ctx, `DELETE FROM feeds WHERE id IN (`+placeholders+`)`, args...)
	if err != nil {
		return 0, fmt.Errorf("delete feeds batch: %w", err)
	}
	return result.RowsAffected()
}

func (r *feedRepository) ClearAllIconPaths(ctx context.Context) (int64, error) {
	result, err := r.db.ExecContext(ctx, `UPDATE feeds SET icon_path = NULL, updated_at = ? WHERE icon_path IS NOT NULL`, formatTime(time.Now()))
	if err != nil {
		return 0, fmt.Errorf("clear icon paths: %w", err)
	}
	return result.RowsAffected()
}

func (r *feedRepository) ClearAllConditionalGet(ctx context.Context) (int64, error) {
	result, err := r.db.ExecContext(ctx, `UPDATE feeds SET etag = NULL, last_modified = NULL, updated_at = ? WHERE etag IS NOT NULL OR last_modified IS NOT NULL`, formatTime(time.Now()))
	if err != nil {
		return 0, fmt.Errorf("clear conditional get: %w", err)
	}
	return result.RowsAffected()
}

// feedSourceTypeOrDefault 新建行时用：空串落成 rss（列本身 NOT NULL DEFAULT 'rss'，不能显式写 NULL）。
func feedSourceTypeOrDefault(feed model.Feed) interface{} {
	if feed.SourceType == "" {
		return model.FeedSourceRSS
	}
	return feed.SourceType
}

// feedSourceType 更新行时用：空串返回 nil，配合 SQL 里的 COALESCE 保持原值 ——
// 避免老调用方（改名 / 改分类）构造的 Feed 把 MCP 订阅写回 rss。
func feedSourceType(feed model.Feed) interface{} {
	if feed.SourceType == "" {
		return nil
	}
	return feed.SourceType
}

func scanFeed(scanner interface {
	Scan(dest ...interface{}) error
}) (model.Feed, error) {
	var feed model.Feed
	var folderID sql.NullInt64
	var siteURL sql.NullString
	var description sql.NullString
	var summaryPromptReminder sql.NullString
	var iconPath sql.NullString
	var feedType sql.NullString
	var etag sql.NullString
	var lastModified sql.NullString
	var errorMessage sql.NullString
	var createdAt string
	var updatedAt string
	var autoTranslate sql.NullBool
	var autoSummary sql.NullBool
	var readerMode sql.NullBool
	var proxyMode sql.NullInt64
	var proxyConfig sql.NullString
	var refreshFailCount int
	var refreshLastFailAt sql.NullString
	var sourceType sql.NullString
	var mcpConfig sql.NullString
	if err := scanner.Scan(
		&feed.ID,
		&folderID,
		&feed.Title,
		&feed.URL,
		&siteURL,
		&description,
		&summaryPromptReminder,
		&iconPath,
		&feedType,
		&etag,
		&lastModified,
		&errorMessage,
		&createdAt,
		&updatedAt,
		&autoTranslate,
		&autoSummary,
		&readerMode,
		&proxyMode,
		&proxyConfig,
		&refreshFailCount,
		&refreshLastFailAt,
		&sourceType,
		&mcpConfig,
	); err != nil {
		return model.Feed{}, err
	}
	if folderID.Valid {
		feed.FolderID = &folderID.Int64
	}
	if siteURL.Valid {
		feed.SiteURL = &siteURL.String
	}
	if description.Valid {
		feed.Description = &description.String
	}
	if summaryPromptReminder.Valid {
		feed.SummaryPromptReminder = &summaryPromptReminder.String
	}
	if iconPath.Valid {
		feed.IconPath = &iconPath.String
	}
	if feedType.Valid {
		feed.Type = feedType.String
	} else {
		feed.Type = "article"
	}
	if etag.Valid {
		feed.ETag = &etag.String
	}
	if lastModified.Valid {
		feed.LastModified = &lastModified.String
	}
	if errorMessage.Valid {
		feed.ErrorMessage = &errorMessage.String
	}
	if autoTranslate.Valid {
		value := autoTranslate.Bool
		feed.AutoTranslate = &value
	}
	if autoSummary.Valid {
		value := autoSummary.Bool
		feed.AutoSummary = &value
	}
	if readerMode.Valid {
		value := readerMode.Bool
		feed.ReaderMode = &value
	}
	feed.ProxyMode = parseProxyMode(proxyMode)
	feed.ProxyConfig = parseProxyConfig(proxyConfig)
	feed.RefreshFailCount = refreshFailCount
	if refreshLastFailAt.Valid {
		feed.RefreshLastFailAt = parseTimePtr(refreshLastFailAt.String)
	}
	if sourceType.Valid && sourceType.String != "" {
		feed.SourceType = sourceType.String
	} else {
		// 老行（迁移前建的）没有值 —— 语义就是 rss
		feed.SourceType = model.FeedSourceRSS
	}
	if mcpConfig.Valid {
		feed.MCPConfig = &mcpConfig.String
	}
	var err error
	feed.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return model.Feed{}, fmt.Errorf("parse feed created_at: %w", err)
	}
	feed.UpdatedAt, err = parseTime(updatedAt)
	if err != nil {
		return model.Feed{}, fmt.Errorf("parse feed updated_at: %w", err)
	}
	return feed, nil
}
