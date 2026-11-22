//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package repository

import (
	"context"
	"database/sql"
	"time"

	"krss/backend/internal/model"
	"krss/backend/pkg/snowflake"
)

type AISummaryRepository interface {
	Get(ctx context.Context, entryID int64, isReadability bool, language string) (*model.AISummary, error)
	Save(ctx context.Context, entryID int64, isReadability bool, language, summary string) error
	// UpsertStatus 记录摘要生成状态与所用模型提供商（迁移 37）。
	UpsertStatus(ctx context.Context, entryID int64, isReadability bool, language, status, errMsg, provider, model string) error
	// GetStatusBatch 批量取摘要状态；只返回有状态行的条目。
	GetStatusBatch(ctx context.Context, entryIDs []int64, isReadability bool, language string) (map[int64]model.AISummaryStatus, error)
	DeleteByEntryID(ctx context.Context, entryID int64) error
	DeleteAll(ctx context.Context) (int64, error)
}

type aiSummaryRepository struct {
	db dbtx
}

func NewAISummaryRepository(db dbtx) AISummaryRepository {
	return &aiSummaryRepository{db: db}
}

func (r *aiSummaryRepository) Get(ctx context.Context, entryID int64, isReadability bool, language string) (*model.AISummary, error) {
	isReadabilityInt := 0
	if isReadability {
		isReadabilityInt = 1
	}

	row := r.db.QueryRowContext(
		ctx,
		`SELECT id, entry_id, is_readability, language, summary, created_at
		 FROM ai_summaries WHERE entry_id = ? AND is_readability = ? AND language = ?`,
		entryID, isReadabilityInt, language,
	)

	var s model.AISummary
	var isReadabilityDB int
	var createdAt string

	err := row.Scan(&s.ID, &s.EntryID, &isReadabilityDB, &s.Language, &s.Summary, &createdAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	s.IsReadability = isReadabilityDB == 1
	s.CreatedAt, _ = parseTime(createdAt)

	return &s, nil
}

func (r *aiSummaryRepository) Save(ctx context.Context, entryID int64, isReadability bool, language, summary string) error {
	id := snowflake.NextID()
	now := formatTime(time.Now())

	isReadabilityInt := 0
	if isReadability {
		isReadabilityInt = 1
	}

	_, err := r.db.ExecContext(
		ctx,
		`INSERT INTO ai_summaries (id, entry_id, is_readability, language, summary, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(entry_id, is_readability, language) DO UPDATE SET
		   summary = excluded.summary,
		   created_at = excluded.created_at`,
		id, entryID, isReadabilityInt, language, summary, now,
	)
	return err
}

func (r *aiSummaryRepository) DeleteByEntryID(ctx context.Context, entryID int64) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM ai_summaries WHERE entry_id = ?`, entryID)
	return err
}

func (r *aiSummaryRepository) DeleteAll(ctx context.Context) (int64, error) {
	result, err := r.db.ExecContext(ctx, `DELETE FROM ai_summaries`)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// UpsertStatus 写单条摘要状态（迁移 37）。同 (entry, 可读, 语言) 覆盖。
func (r *aiSummaryRepository) UpsertStatus(ctx context.Context, entryID int64, isReadability bool, language, status, errMsg, provider, model_ string) error {
	isReadabilityInt := 0
	if isReadability {
		isReadabilityInt = 1
	}
	now := formatTime(time.Now())
	_, err := r.db.ExecContext(
		ctx,
		`INSERT INTO ai_summary_status (entry_id, is_readability, language, status, error, provider, model, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(entry_id, is_readability, language) DO UPDATE SET
		   status = excluded.status,
		   error = excluded.error,
		   provider = excluded.provider,
		   model = excluded.model,
		   updated_at = excluded.updated_at`,
		entryID, isReadabilityInt, language, status, errMsg, provider, model_, now,
	)
	return err
}

// GetStatusBatch 批量取摘要状态，去重 + 200 条上限。
func (r *aiSummaryRepository) GetStatusBatch(ctx context.Context, entryIDs []int64, isReadability bool, language string) (map[int64]model.AISummaryStatus, error) {
	result := make(map[int64]model.AISummaryStatus)
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
		if len(ids) >= 200 {
			break
		}
	}
	isReadabilityInt := 0
	if isReadability {
		isReadabilityInt = 1
	}
	query := `SELECT entry_id, status, error, provider, model
	          FROM ai_summary_status WHERE is_readability = ? AND language = ? AND entry_id IN (`
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
		var st model.AISummaryStatus
		if err := rows.Scan(&entryID, &st.Status, &st.Error, &st.Provider, &st.Model); err != nil {
			return nil, err
		}
		result[entryID] = st
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
