package repository

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"time"
)

// PluginDataRepository 插件专属数据（迁移 34 的 plugin_data 表）—— 三段式 KV：
// (plugin_id, collection, key) → value（任意 JSON 字符串，本体不解析）。
//
// 权限边界在 service 层：本仓储不认识「谁在调」，只认 plugin_id 这个隔离位。
// 宿主在外部插件走 socket 时把插件 id 注入进来，插件没法自己填别人的 id ⇒ 不可能越权。
type PluginDataRepository interface {
	// Get 取一个键；不存在返回 ErrNotFound。
	Get(ctx context.Context, pluginID, collection, key string) (string, error)
	// Put 写入或覆盖一个键（同 (plugin, collection, key) = 覆盖，不是插新行）。
	Put(ctx context.Context, pluginID, collection, key, value string) error
	// Delete 删一个键；键本来就不在返回 ErrNotFound。
	Delete(ctx context.Context, pluginID, collection, key string) error
	// List 列一个 collection 里的键值（prefix 为空 = 全部），按 key 升序、最多 limit 条。
	List(ctx context.Context, pluginID, collection, prefix string, limit int) (map[string]string, error)
	// DeleteCollection 删掉一个 collection 的全部键（幂等：空 collection 不报错）。
	DeleteCollection(ctx context.Context, pluginID, collection string) error
	// Count 这个插件一共存了多少键（跨 collection；配额/诊断用）。
	Count(ctx context.Context, pluginID string) (int, error)
}

// 插件数据的硬限制。service 也会挡一道（那里要回 400 而不是 500），
// 这里是第二道：绕过 service 的写法（插件 socket 通道、脚本直接调仓储）也灌不进脏数据。
const (
	// PluginDataMaxValueBytes 单值上限 256KB（字节，不是字符）。
	PluginDataMaxValueBytes = 256 * 1024
	// PluginDataMaxKeyBytes 键名上限 200 字节。
	PluginDataMaxKeyBytes = 200
	// PluginDataDefaultLimit / PluginDataMaxLimit List 的缺省与上限。
	PluginDataDefaultLimit = 200
	PluginDataMaxLimit     = 1000
)

var (
	// ErrNotFound 仓储层的「这条不存在」哨兵（service 把它翻成 404）。
	// 其余老仓储沿用 sql.ErrNoRows，plugin_data 这组方法直接回哨兵，
	// 免得 service 到处 import database/sql 判错。
	ErrNotFound = errors.New("not found")
	// ErrPluginDataInvalidCollection collection 名不合规（^[a-z0-9_-]{1,32}$）。
	ErrPluginDataInvalidCollection = errors.New("plugin data: invalid collection")
	// ErrPluginDataInvalidKey 键名不合规（1..200 字节）。
	ErrPluginDataInvalidKey = errors.New("plugin data: invalid key")
	// ErrPluginDataValueTooLarge 单值超 256KB。
	ErrPluginDataValueTooLarge = errors.New("plugin data: value too large")
)

// pluginDataCollectionPattern collection 名：小写字母 / 数字 / 下划线 / 连字符，1..32 位。
// 这些字符不用转义就能进 URL 路径段，也不会跟键名前缀（feed:1 之类）打架。
var pluginDataCollectionPattern = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// ValidPluginDataCollection collection 名是否合规（service 复用同一份规则，别各写一遍正则）。
func ValidPluginDataCollection(collection string) bool {
	return pluginDataCollectionPattern.MatchString(collection)
}

type pluginDataRepository struct {
	db *sql.DB
}

func NewPluginDataRepository(db *sql.DB) PluginDataRepository {
	return &pluginDataRepository{db: db}
}

// validate 写路径的入参检查（读路径只查 collection/key，值不在手上）。
func validatePluginDataRef(collection, key string) error {
	if !ValidPluginDataCollection(collection) {
		return ErrPluginDataInvalidCollection
	}
	if len(key) == 0 || len(key) > PluginDataMaxKeyBytes {
		return ErrPluginDataInvalidKey
	}
	return nil
}

func (r *pluginDataRepository) Get(ctx context.Context, pluginID, collection, key string) (string, error) {
	if err := validatePluginDataRef(collection, key); err != nil {
		return "", err
	}
	var value string
	err := r.db.QueryRowContext(ctx, `
		SELECT value FROM plugin_data WHERE plugin_id = ? AND collection = ? AND key = ?
	`, pluginID, collection, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return value, nil
}

func (r *pluginDataRepository) Put(ctx context.Context, pluginID, collection, key, value string) error {
	if err := validatePluginDataRef(collection, key); err != nil {
		return err
	}
	if len(value) > PluginDataMaxValueBytes {
		return ErrPluginDataValueTooLarge
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO plugin_data (plugin_id, collection, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(plugin_id, collection, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`, pluginID, collection, key, value, time.Now().Unix())
	return err
}

func (r *pluginDataRepository) Delete(ctx context.Context, pluginID, collection, key string) error {
	if err := validatePluginDataRef(collection, key); err != nil {
		return err
	}
	result, err := r.db.ExecContext(ctx, `
		DELETE FROM plugin_data WHERE plugin_id = ? AND collection = ? AND key = ?
	`, pluginID, collection, key)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *pluginDataRepository) List(ctx context.Context, pluginID, collection, prefix string, limit int) (map[string]string, error) {
	if !ValidPluginDataCollection(collection) {
		return nil, ErrPluginDataInvalidCollection
	}
	if limit <= 0 {
		limit = PluginDataDefaultLimit
	}
	if limit > PluginDataMaxLimit {
		limit = PluginDataMaxLimit
	}
	query := `SELECT key, value FROM plugin_data WHERE plugin_id = ? AND collection = ?`
	args := []any{pluginID, collection}
	if prefix != "" {
		// substr 而不是 LIKE：键名里的 % / _ 就没人要转义了（插件爱怎么起名就怎么起名）。
		query += ` AND substr(key, 1, length(?)) = ?`
		args = append(args, prefix, prefix)
	}
	query += ` ORDER BY key LIMIT ?`
	args = append(args, limit)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]string)
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		out[key] = value
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *pluginDataRepository) DeleteCollection(ctx context.Context, pluginID, collection string) error {
	if !ValidPluginDataCollection(collection) {
		return ErrPluginDataInvalidCollection
	}
	_, err := r.db.ExecContext(ctx, `
		DELETE FROM plugin_data WHERE plugin_id = ? AND collection = ?
	`, pluginID, collection)
	return err
}

func (r *pluginDataRepository) Count(ctx context.Context, pluginID string) (int, error) {
	var count int
	if err := r.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM plugin_data WHERE plugin_id = ?
	`, pluginID).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}
