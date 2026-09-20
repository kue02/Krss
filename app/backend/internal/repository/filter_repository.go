//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"krss/backend/internal/model"
	"krss/backend/pkg/snowflake"
)

// MatchedEntry 一条「某规则命中过的条目」（撤销时按它决定要不要退回未读）。
type MatchedEntry struct {
	EntryID int64
	Actions model.FilterActions
}

// RevertImpactEntry 撤销前清单里的一行。
type RevertImpactEntry struct {
	EntryID     int64
	Title       string
	FeedTitle   string
	PublishedAt string
	Read        bool
	Starred     bool
	Muted       bool
	// Actions 当初这条规则对它做过什么（撤销会影响到的就是这些）
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
	// ListRevertImpact 取「撤销会被影响的条目」清单（条目本身 + 来源 + 当前状态 + 当初的动作），
	// 供撤销前让用户看清并勾选（用户 11-23）。不写库。
	ListRevertImpact(ctx context.Context, filterID int64, limit int) ([]RevertImpactEntry, error)
	// BumpMatchStats 刷新一批条目后，把每条规则的命中数/最近命中时间落库。
	BumpMatchStats(ctx context.Context, stats map[int64]int64, at time.Time) error
	// PruneMatches 只保留最近 keep 条命中记录，防止审计表无限增长。
	PruneMatches(ctx context.Context, keep int) error
	// SetLastError / ClearLastError 记录规则执行失败的可见原因（webhook 投递失败、AI 判定失败）；
	// 下一次成功就清掉，规则表上始终显示「最近一次失败」。
	SetLastError(ctx context.Context, filterID int64, message string, at time.Time) error
	ClearLastError(ctx context.Context, filterID int64) error
	// GetAIJudgement 取 AI 条件判定缓存（found=false 表示没判过，需要问模型）。
	GetAIJudgement(ctx context.Context, entryID int64, questionHash string) (verdict bool, found bool, err error)
	// SaveAIJudgement 落一条判定缓存（同条目同问题只问一次模型）。
	SaveAIJudgement(ctx context.Context, entryID int64, questionHash string, verdict bool, model string, at time.Time) error
}

type filterRepository struct {
	db dbtx
}

func NewFilterRepository(db dbtx) FilterRepository {
	return &filterRepository{db: db}
}

const filterColumns = `id, name, enabled, position, kind, scope_type, scope_id, scope_ids, content_types, icon, conditions, actions, match_count, last_matched_at, last_error, last_error_at, created_at, updated_at`

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
	if filter.Kind == "" {
		filter.Kind = model.FilterKindRule
	}

	scopeIDs, err := marshalScopeIDs(filter.ScopeIDs)
	if err != nil {
		return model.Filter{}, err
	}
	contentTypes, err := marshalStringList(filter.ContentTypes)
	if err != nil {
		return model.Filter{}, err
	}

	_, err = r.db.ExecContext(ctx, `
		INSERT INTO filters (id, name, enabled, position, kind, scope_type, scope_id, scope_ids, content_types, icon, conditions, actions,
		                     match_count, last_matched_at, last_error, last_error_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)`,
		filter.ID,
		filter.Name,
		boolToInt(filter.Enabled),
		filter.Position,
		filter.Kind,
		filter.ScopeType,
		nullableInt64(filter.ScopeID),
		scopeIDs,
		contentTypes,
		nullableString(iconPtr(filter.Icon)),
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
	scopeIDs, err := marshalScopeIDs(filter.ScopeIDs)
	if err != nil {
		return err
	}
	contentTypes, err := marshalStringList(filter.ContentTypes)
	if err != nil {
		return err
	}

	_, err = r.db.ExecContext(ctx, `
		UPDATE filters SET
			name = ?, enabled = ?, position = ?, kind = ?, scope_type = ?, scope_id = ?, scope_ids = ?, content_types = ?, icon = ?,
			conditions = ?, actions = ?, updated_at = ?
		WHERE id = ?`,
		filter.Name,
		boolToInt(filter.Enabled),
		filter.Position,
		filter.Kind,
		filter.ScopeType,
		nullableInt64(filter.ScopeID),
		scopeIDs,
		contentTypes,
		nullableString(iconPtr(filter.Icon)),
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

// SetLastError / ClearLastError：规则执行失败的可见出口（webhook 投递失败、AI 判定失败）。
func (r *filterRepository) SetLastError(ctx context.Context, filterID int64, message string, at time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE filters SET last_error = ?, last_error_at = ? WHERE id = ?`,
		message, formatTime(at), filterID)
	return err
}

func (r *filterRepository) ClearLastError(ctx context.Context, filterID int64) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE filters SET last_error = NULL, last_error_at = NULL WHERE id = ?`, filterID)
	return err
}

// GetAIJudgement 取 AI 条件判定缓存：同一条目同一个问题只问模型一次。
func (r *filterRepository) GetAIJudgement(ctx context.Context, entryID int64, questionHash string) (bool, bool, error) {
	var verdict int
	err := r.db.QueryRowContext(ctx,
		`SELECT verdict FROM entry_ai_judgements WHERE entry_id = ? AND question_hash = ?`,
		entryID, questionHash).Scan(&verdict)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, false, nil
		}
		return false, false, err
	}
	return verdict == 1, true, nil
}

func (r *filterRepository) SaveAIJudgement(ctx context.Context, entryID int64, questionHash string, verdict bool, model string, at time.Time) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO entry_ai_judgements (id, entry_id, question_hash, verdict, model, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(entry_id, question_hash) DO UPDATE SET verdict = excluded.verdict`,
		snowflake.NextID(), entryID, questionHash, boolToInt(verdict), model, formatTime(at))
	return err
}

// ListRevertImpact 撤销影响清单：与 ListMatchedEntryIDs 同一口径（最近一次命中、且条目当前仍归它管），
// 另带条目自身状态，供前端列出「会撤销哪些条目」。
func (r *filterRepository) ListRevertImpact(ctx context.Context, filterID int64, limit int) ([]RevertImpactEntry, error) {
	if limit <= 0 || limit > 20000 {
		limit = 5000
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT fm.entry_id, COALESCE(e.title, ''), COALESCE(f.title, ''), COALESCE(e.published_at, ''),
		       e.read, e.starred, e.muted, fm.actions
		FROM filter_matches fm
		INNER JOIN entries e ON e.id = fm.entry_id
		LEFT JOIN feeds f ON f.id = e.feed_id
		WHERE fm.filter_id = ? AND e.filter_id = ?
		  AND fm.id = (
			SELECT MAX(fm2.id) FROM filter_matches fm2
			WHERE fm2.entry_id = fm.entry_id AND fm2.filter_id = fm.filter_id
		  )
		ORDER BY e.published_at DESC, fm.entry_id DESC
		LIMIT ?`, filterID, filterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]RevertImpactEntry, 0, 16)
	for rows.Next() {
		var item RevertImpactEntry
		var readInt, starredInt, mutedInt int
		var rawActions string
		if err := rows.Scan(&item.EntryID, &item.Title, &item.FeedTitle, &item.PublishedAt,
			&readInt, &starredInt, &mutedInt, &rawActions); err != nil {
			return nil, err
		}
		item.Read = readInt == 1
		item.Starred = starredInt == 1
		item.Muted = mutedInt == 1
		_ = json.Unmarshal([]byte(rawActions), &item.Actions)
		out = append(out, item)
	}
	return out, rows.Err()
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

// marshalStringList 字符串集合 → JSON；空写 NULL（与 scope_ids 同规约：NULL 与 "[]" 是两种含义）。
func marshalStringList(values []string) (interface{}, error) {
	if len(values) == 0 {
		return nil, nil
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return nil, err
	}
	return string(raw), nil
}

// iconPtr 空图标写 NULL，别存空串。
func iconPtr(icon string) *string {
	if icon == "" {
		return nil
	}
	return &icon
}

// marshalScopeIDs 多选订阅集合 → JSON 字符串；空集合写 NULL
//（NULL 与 "[]" 对「有没有多选」是两种含义，别让读的人猜）。
func marshalScopeIDs(ids []int64) (interface{}, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	raw, err := json.Marshal(ids)
	if err != nil {
		return nil, err
	}
	return string(raw), nil
}

func scanFilter(scan func(dest ...interface{}) error) (model.Filter, error) {
	var (
		filter        model.Filter
		enabled       int
		scopeID       sql.NullInt64
		scopeIDsRaw   sql.NullString
		contentTypes  sql.NullString
		icon          sql.NullString
		conditionsRaw string
		actionsRaw    string
		lastMatched   sql.NullString
		lastError     sql.NullString
		lastErrorAt   sql.NullString
		createdAt     string
		updatedAt     string
	)
	if err := scan(&filter.ID, &filter.Name, &enabled, &filter.Position, &filter.Kind, &filter.ScopeType, &scopeID, &scopeIDsRaw,
		&contentTypes, &icon, &conditionsRaw, &actionsRaw, &filter.MatchCount, &lastMatched, &lastError, &lastErrorAt, &createdAt, &updatedAt); err != nil {
		return model.Filter{}, err
	}
	filter.Enabled = enabled != 0
	if filter.Kind == "" {
		filter.Kind = model.FilterKindRule
	}
	if scopeID.Valid {
		value := scopeID.Int64
		filter.ScopeID = &value
	}
	if contentTypes.Valid && contentTypes.String != "" {
		var types []string
		if err := json.Unmarshal([]byte(contentTypes.String), &types); err == nil && len(types) > 0 {
			filter.ContentTypes = types
		}
	}
	if icon.Valid {
		filter.Icon = icon.String
	}
	if scopeIDsRaw.Valid && scopeIDsRaw.String != "" {
		var ids []int64
		if err := json.Unmarshal([]byte(scopeIDsRaw.String), &ids); err == nil && len(ids) > 0 {
			filter.ScopeIDs = ids
		}
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
	if lastError.Valid && lastError.String != "" {
		value := lastError.String
		filter.LastError = &value
	}
	if lastErrorAt.Valid && lastErrorAt.String != "" {
		if parsed, err := parseTime(lastErrorAt.String); err == nil {
			filter.LastErrorAt = &parsed
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
