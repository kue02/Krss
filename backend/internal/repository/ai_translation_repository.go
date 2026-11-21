//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package repository

import (
	"context"
	"database/sql"
	"time"

	"krss/backend/internal/model"
	"krss/backend/pkg/snowflake"
)

type AITranslationRepository interface {
	Get(ctx context.Context, entryID int64, isReadability bool, language string) (*model.AITranslation, error)
	// GetBatch 批量取整篇译文缓存（列表卡片直接显示译文用，54-1）。
	// 只返回**已翻好**的条目；没有的条目在结果里不出现（调用方按「没拿到就用原文」处理）。
	// 上限由 repository 侧保护：一次最多 200 条，超出的截断（列表一屏远达不到）。
	GetBatch(ctx context.Context, entryIDs []int64, isReadability bool, language string) (map[int64]*model.AITranslation, error)
	// UpsertStatus 记录单条译文的翻译状态（translating / done / failed），失败时带原因。
	UpsertStatus(ctx context.Context, entryID int64, isReadability bool, language, status, errMsg string) error
	// UpsertStatusDetail 同 UpsertStatus，并记录实际所用服务/提供商/模型（供列表悬停展示）。
	UpsertStatusDetail(ctx context.Context, entryID int64, isReadability bool, language, status, errMsg, service, provider, model string) error
	// GetStatusBatch 批量取翻译状态；只返回有状态行的条目，没翻译过的条目不出现在结果里。
	GetStatusBatch(ctx context.Context, entryIDs []int64, isReadability bool, language string) (map[int64]model.AITranslationStatus, error)
	Save(ctx context.Context, entryID int64, isReadability bool, language, content string) error
	DeleteByEntryID(ctx context.Context, entryID int64) error
	DeleteAll(ctx context.Context) (int64, error)
}

// aiTranslationBatchLimit 单次批量读的上限：列表一屏 50 条足够，200 是防止误传大数组
// 把 SQL 变成长串占位符（SQLite 变量上限 999，这里留足余量）。
const aiTranslationBatchLimit = 200

type aiTranslationRepository struct {
	db dbtx
}

func NewAITranslationRepository(db dbtx) AITranslationRepository {
	return &aiTranslationRepository{db: db}
}

func (r *aiTranslationRepository) Get(ctx context.Context, entryID int64, isReadability bool, language string) (*model.AITranslation, error) {
	isReadabilityInt := 0
	if isReadability {
		isReadabilityInt = 1
	}

	row := r.db.QueryRowContext(
		ctx,
		`SELECT id, entry_id, is_readability, language, content, created_at
		 FROM ai_translations WHERE entry_id = ? AND is_readability = ? AND language = ?`,
		entryID, isReadabilityInt, language,
	)

	var t model.AITranslation
	var isReadabilityDB int
	var createdAt string

	err := row.Scan(&t.ID, &t.EntryID, &isReadabilityDB, &t.Language, &t.Content, &createdAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	t.IsReadability = isReadabilityDB == 1
	t.CreatedAt, _ = parseTime(createdAt)

	return &t, nil
}

func (r *aiTranslationRepository) GetBatch(ctx context.Context, entryIDs []int64, isReadability bool, language string) (map[int64]*model.AITranslation, error) {
	result := make(map[int64]*model.AITranslation)
	if len(entryIDs) == 0 {
		return result, nil
	}
	// 去重 + 截断：调用方可能把「可见行 + 上一页残留」一起传进来，重复 id 会让
	// IN 列表白长一截；上限见 aiTranslationBatchLimit。
	seen := make(map[int64]struct{}, len(entryIDs))
	ids := make([]int64, 0, len(entryIDs))
	for _, id := range entryIDs {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
		if len(ids) >= aiTranslationBatchLimit {
			break
		}
	}

	isReadabilityInt := 0
	if isReadability {
		isReadabilityInt = 1
	}

	// 与 Get 同一列序（少取 created_at 之外无差，这里保持一致以免 scan 漂移）
	query := `SELECT id, entry_id, is_readability, language, content, created_at
	          FROM ai_translations WHERE is_readability = ? AND language = ? AND entry_id IN (`
	args := make([]interface{}, 0, len(ids)+2)
	args = append(args, isReadabilityInt, language)
	for i, id := range ids {
		if i > 0 {
			query += ","
		}
		query += "?"
		args = append(args, id)
	}
	query += ")"

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var t model.AITranslation
		var isReadabilityDB int
		var createdAt string
		if err := rows.Scan(&t.ID, &t.EntryID, &isReadabilityDB, &t.Language, &t.Content, &createdAt); err != nil {
			return nil, err
		}
		t.IsReadability = isReadabilityDB == 1
		t.CreatedAt, _ = parseTime(createdAt)
		result[t.EntryID] = &t
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *aiTranslationRepository) Save(ctx context.Context, entryID int64, isReadability bool, language, content string) error {
	id := snowflake.NextID()
	now := formatTime(time.Now())

	isReadabilityInt := 0
	if isReadability {
		isReadabilityInt = 1
	}

	_, err := r.db.ExecContext(
		ctx,
		`INSERT INTO ai_translations (id, entry_id, is_readability, language, content, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(entry_id, is_readability, language) DO UPDATE SET
		   content = excluded.content,
		   created_at = excluded.created_at`,
		id, entryID, isReadabilityInt, language, content, now,
	)
	return err
}

func (r *aiTranslationRepository) DeleteByEntryID(ctx context.Context, entryID int64) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM ai_translations WHERE entry_id = ?`, entryID)
	return err
}

func (r *aiTranslationRepository) DeleteAll(ctx context.Context) (int64, error) {
	result, err := r.db.ExecContext(ctx, `DELETE FROM ai_translations`)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// UpsertStatus 写单条翻译状态（迁移 36）。同 (entry, 可读, 语言) 覆盖，不插新行。
func (r *aiTranslationRepository) UpsertStatus(ctx context.Context, entryID int64, isReadability bool, language, status, errMsg string) error {
	return r.UpsertStatusDetail(ctx, entryID, isReadability, language, status, errMsg, "", "", "")
}

// UpsertStatusDetail 写状态并记录服务/提供商/模型（迁移 37 新增列）。
func (r *aiTranslationRepository) UpsertStatusDetail(ctx context.Context, entryID int64, isReadability bool, language, status, errMsg, service, provider, model string) error {
	isReadabilityInt := 0
	if isReadability {
		isReadabilityInt = 1
	}
	now := formatTime(time.Now())

	_, err := r.db.ExecContext(
		ctx,
		`INSERT INTO ai_translation_status (entry_id, is_readability, language, status, error, service, provider, model, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(entry_id, is_readability, language) DO UPDATE SET
		   status = excluded.status,
		   error = excluded.error,
		   service = excluded.service,
		   provider = excluded.provider,
		   model = excluded.model,
		   updated_at = excluded.updated_at`,
		entryID, isReadabilityInt, language, status, errMsg, service, provider, model, now,
	)
	return err
}

// GetStatusBatch 批量取翻译状态，口径与 GetBatch 一致（去重 + 200 条上限）。
func (r *aiTranslationRepository) GetStatusBatch(ctx context.Context, entryIDs []int64, isReadability bool, language string) (map[int64]model.AITranslationStatus, error) {
	result := make(map[int64]model.AITranslationStatus)
	if len(entryIDs) == 0 {
		return result, nil
	}
	seen := make(map[int64]struct{}, len(entryIDs))
	ids := make([]int64, 0, len(entryIDs))
	for _, id := range entryIDs {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
		if len(ids) >= aiTranslationBatchLimit {
			break
		}
	}

	isReadabilityInt := 0
	if isReadability {
		isReadabilityInt = 1
	}

	query := `SELECT entry_id, status, error, service, provider, model
	          FROM ai_translation_status WHERE is_readability = ? AND language = ? AND entry_id IN (`
	args := make([]interface{}, 0, len(ids)+2)
	args = append(args, isReadabilityInt, language)
	for i, id := range ids {
		if i > 0 {
			query += ","
		}
		query += "?"
		args = append(args, id)
	}
	query += ")"

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var entryID int64
		var st model.AITranslationStatus
		if err := rows.Scan(&entryID, &st.Status, &st.Error, &st.Service, &st.Provider, &st.Model); err != nil {
			return nil, err
		}
		result[entryID] = st
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
