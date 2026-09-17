//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"gist/backend/internal/model"
	"gist/backend/pkg/snowflake"
)

// MatchedEntry 一条「某规则命中过的条目」（撤销时按它决定要不要退回未读）。
type MatchedEntry struct {
	EntryID int64
	Actions model.FilterActions
}

// FilterRepository 过滤规则的存取。
// 注意：命中计数/审计是「规则引擎」的正确性依据，因此这里不省略任何写入。
type FilterRepository interface {
	List(ctx context.Context) ([]model.Filter, error)
	GetByID(ctx context.Context, id int64) (model.Filter, error)
	Create(ctx context.Context, filter model.Filter) (model.Filter, error)
	Update(ctx context.Context, filter model.Filter) error
	Delete(ctx context.Context, id int64) error
	RecordMatch(ctx context.Context, match model.FilterMatch) error
	ListMatches(ctx context.Context, filterID int64, limit int) ([]model.FilterMatch, error)
	// ListMatchedEntryIDs 取这条规则命中过、且当前仍归它管的条目（用于撤销/反悔）。
	ListMatchedEntryIDs(ctx context.Context, filterID int64, limit int) ([]MatchedEntry, error)
	// BumpMatchStats 刷新一批条目后，把每条规则的命中数/最近命中时间落库。
	BumpMatchStats(ctx context.Context, stats map[int64]int64, at time.Time) error
	// PruneMatches 只保留最近 keep 条命中记录，防止审计表无限增长。
	PruneMatches(ctx context.Context, keep int) error
}

type filterRepository struct {
	db dbtx
}

func NewFilterRepository(db dbtx) FilterRepository {
	return &filterRepository{db: db}
}

const filterColumns = `id, name, enabled, position, scope_type, scope_id, conditions, actions, match_count, last_matched_at, created_at, updated_at`

func (r *filterRepository) List(ctx context.Context) ([]model.Filter, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT `+filterColumns+` FROM filters ORDER BY position ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	filters := make([]model.Filter, 0)
	for rows.Next() {
		filter, err := scanFilter(rows.Scan)
		if err != nil {
			return nil, err
		}
		filters = append(filters, filter)
	}
	return filters, rows.Err()
}

func (r *filterRepository) GetByID(ctx context.Context, id int64) (model.Filter, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT `+filterColumns+` FROM filters WHERE id = ?`, id)
	return scanFilter(row.Scan)
}

func (r *filterRepository) Create(ctx context.Context, filter model.Filter) (model.Filter, error) {
	conditions, err := json.Marshal(normalizeConditions(filter.Conditions))
	if err != nil {
		return model.Filter{}, err
	}
	actions, err := json.Marshal(filter.Actions)
	if err != nil {
		return model.Filter{}, err
	}

	now := time.Now()
	filter.ID = snowflake.NextID()
	filter.CreatedAt = now
	filter.UpdatedAt = now
	if filter.ScopeType == "" {
		filter.ScopeType = model.FilterScopeAll
	}

	_, err = r.db.ExecContext(ctx, `
		INSERT INTO filters (id, name, enabled, position, scope_type, scope_id, conditions, actions,
		                     match_count, last_matched_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
		filter.ID,
		filter.Name,
		boolToInt(filter.Enabled),
		filter.Position,
		filter.ScopeType,
		nullableInt64(filter.ScopeID),
		string(conditions),
		string(actions),
		formatTime(now),
		formatTime(now),
	)
	if err != nil {
		return model.Filter{}, err
	}
	return r.GetByID(ctx, filter.ID)
}

func (r *filterRepository) Update(ctx context.Context, filter model.Filter) error {
	conditions, err := json.Marshal(normalizeConditions(filter.Conditions))
	if err != nil {
		return err
	}
	actions, err := json.Marshal(filter.Actions)
	if err != nil {
		return err
	}

	_, err = r.db.ExecContext(ctx, `
		UPDATE filters SET
			name = ?, enabled = ?, position = ?, scope_type = ?, scope_id = ?,
			conditions = ?, actions = ?, updated_at = ?
		WHERE id = ?`,
		filter.Name,
		boolToInt(filter.Enabled),
		filter.Position,
		filter.ScopeType,
		nullableInt64(filter.ScopeID),
		string(conditions),
		string(actions),
		formatTime(time.Now()),
		filter.ID,
	)
	return err
}

func (r *filterRepository) Delete(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM filters WHERE id = ?`, id)
	return err
}

func (r *filterRepository) RecordMatch(ctx context.Context, match model.FilterMatch) error {
	actions, err := json.Marshal(match.Actions)
	if err != nil {
		return err
	}
	now := match.CreatedAt
	if now.IsZero() {
		now = time.Now()
	}
	_, err = r.db.ExecContext(ctx, `
		INSERT INTO filter_matches (id, filter_id, entry_id, actions, created_at)
		VALUES (?, ?, ?, ?, ?)`,
		snowflake.NextID(),
		match.FilterID,
		match.EntryID,
		string(actions),
		formatTime(now),
	)
	return err
}

func (r *filterRepository) ListMatches(ctx context.Context, filterID int64, limit int) ([]model.FilterMatch, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT fm.id, fm.filter_id, fm.entry_id, fm.actions, fm.created_at,
		       COALESCE(e.title, ''), COALESCE(f.title, '')
		FROM filter_matches fm
		LEFT JOIN entries e ON e.id = fm.entry_id
		LEFT JOIN feeds f ON f.id = e.feed_id
		WHERE fm.filter_id = ?
		ORDER BY fm.id DESC
		LIMIT ?`, filterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	matches := make([]model.FilterMatch, 0)
	for rows.Next() {
		var (
			match     model.FilterMatch
			actions   string
			createdAt string
		)
		if err := rows.Scan(&match.ID, &match.FilterID, &match.EntryID, &actions, &createdAt, &match.EntryTitle, &match.FeedTitle); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(actions), &match.Actions)
		if parsed, err := parseTime(createdAt); err == nil {
			match.CreatedAt = parsed
		}
		matches = append(matches, match)
	}
	return matches, rows.Err()
}

func (r *filterRepository) BumpMatchStats(ctx context.Context, stats map[int64]int64, at time.Time) error {
	if len(stats) == 0 {
		return nil
	}
	stamp := formatTime(at)
	for filterID, delta := range stats {
		if delta <= 0 {
			continue
		}
		if _, err := r.db.ExecContext(ctx, `
			UPDATE filters
			SET match_count = match_count + ?, last_matched_at = ?
			WHERE id = ?`, delta, stamp, filterID); err != nil {
			return err
		}
	}
	return nil
}

func (r *filterRepository) PruneMatches(ctx context.Context, keep int) error {
	if keep <= 0 {
		keep = 5000
	}
	_, err := r.db.ExecContext(ctx, `
		DELETE FROM filter_matches
		WHERE id NOT IN (SELECT id FROM filter_matches ORDER BY id DESC LIMIT ?)`, keep)
	return err
}

func (r *filterRepository) ListMatchedEntryIDs(ctx context.Context, filterID int64, limit int) ([]MatchedEntry, error) {
	if limit <= 0 || limit > 20000 {
		limit = 5000
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT fm.entry_id, fm.actions
		FROM filter_matches fm
		INNER JOIN entries e ON e.id = fm.entry_id
		WHERE fm.filter_id = ? AND e.filter_id = ?
		  AND fm.id = (
			SELECT MAX(fm2.id) FROM filter_matches fm2
			WHERE fm2.entry_id = fm.entry_id AND fm2.filter_id = fm.filter_id
		  )
		ORDER BY fm.id DESC
		LIMIT ?`, filterID, filterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	matched := make([]MatchedEntry, 0)
	for rows.Next() {
		var (
			item    MatchedEntry
			actions string
		)
		if err := rows.Scan(&item.EntryID, &actions); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(actions), &item.Actions)
		matched = append(matched, item)
	}
	return matched, rows.Err()
}

func scanFilter(scan func(dest ...interface{}) error) (model.Filter, error) {
	var (
		filter        model.Filter
		enabled       int
		scopeID       sql.NullInt64
		conditionsRaw string
		actionsRaw    string
		lastMatched   sql.NullString
		createdAt     string
		updatedAt     string
	)
	if err := scan(&filter.ID, &filter.Name, &enabled, &filter.Position, &filter.ScopeType, &scopeID,
		&conditionsRaw, &actionsRaw, &filter.MatchCount, &lastMatched, &createdAt, &updatedAt); err != nil {
		return model.Filter{}, err
	}
	filter.Enabled = enabled != 0
	if scopeID.Valid {
		value := scopeID.Int64
		filter.ScopeID = &value
	}
	if err := json.Unmarshal([]byte(conditionsRaw), &filter.Conditions); err != nil {
		filter.Conditions = nil
	}
	if err := json.Unmarshal([]byte(actionsRaw), &filter.Actions); err != nil {
		filter.Actions = model.FilterActions{}
	}
	if lastMatched.Valid && lastMatched.String != "" {
		if parsed, err := parseTime(lastMatched.String); err == nil {
			filter.LastMatchedAt = &parsed
		}
	}
	if parsed, err := parseTime(createdAt); err == nil {
		filter.CreatedAt = parsed
	}
	if parsed, err := parseTime(updatedAt); err == nil {
		filter.UpdatedAt = parsed
	}
	return filter, nil
}

func normalizeConditions(conditions []model.FilterCondition) []model.FilterCondition {
	if conditions == nil {
		return []model.FilterCondition{}
	}
	return conditions
}
