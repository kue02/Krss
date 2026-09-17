//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/pkg/logger"
)

type EntryListParams struct {
	FeedID      *int64
	FolderID    *int64
	ContentType *string
	// ViewID 按「保存筛选视图」取条目（filters.kind = view）：作用域与条件都来自视图
	ViewID       *int64
	UnreadOnly   bool
	StarredOnly  bool
	HasThumbnail bool
	// IncludeMuted 为 true 时把被规则静音的条目也列出来（默认隐藏）。
	IncludeMuted bool
	// MutedOnly 只看被规则静音的条目（「已静音」视图）。
	MutedOnly bool
	Limit     int
	Offset    int
}

type EntryService interface {
	List(ctx context.Context, params EntryListParams) ([]model.Entry, error)
	// Search 关键词检索（FTS5），供搜索弹窗用
	Search(ctx context.Context, keyword string, limit int) ([]model.Entry, error)
	GetByID(ctx context.Context, id int64) (model.Entry, error)
	MarkAsRead(ctx context.Context, id int64, read bool) error
	MarkManyAsRead(ctx context.Context, ids []int64, read bool) error
	MarkAsStarred(ctx context.Context, id int64, starred bool) error
	// Unmute 取消单条条目的静音（规则写上去的标记由用户手动反悔）：清 muted/filter_id 并退回未读。
	Unmute(ctx context.Context, id int64) error
	MarkAllAsRead(ctx context.Context, feedID *int64, folderID *int64, contentType *string) error
	GetUnreadCounts(ctx context.Context) (map[int64]int, error)
	// GetStarredCount 星标数；contentType 为空串 = 全部内容类型。
	GetStarredCount(ctx context.Context, contentType string) (int, error)
	// ClearReadabilityCache clears all readable_content from entries
	ClearReadabilityCache(ctx context.Context) (int64, error)
	// ClearEntryCache deletes all unstarred entries
	ClearEntryCache(ctx context.Context) (int64, error)
}

type entryService struct {
	entries repository.EntryRepository
	feeds   repository.FeedRepository
	folders repository.FolderRepository
	// filters 只读用途：把「保存筛选视图」（filters.kind = view）的作用域与条件套到列表上
	filters repository.FilterRepository
}

func NewEntryService(
	entries repository.EntryRepository,
	feeds repository.FeedRepository,
	folders repository.FolderRepository,
	filters repository.FilterRepository,
) EntryService {
	return &entryService{
		entries: entries,
		feeds:   feeds,
		folders: folders,
		filters: filters,
	}
}

// Search 关键词检索（FTS5）。
func (s *entryService) Search(ctx context.Context, keyword string, limit int) ([]model.Entry, error) {
	if strings.TrimSpace(keyword) == "" {
		return []model.Entry{}, nil
	}
	entries, err := s.entries.Search(ctx, keyword, limit)
	if err != nil {
		logger.Error("search entries", "module", "service", "action", "search", "resource", "entry", "result", "failed", "error", err)
		return nil, err
	}
	return entries, nil
}

func (s *entryService) List(ctx context.Context, params EntryListParams) ([]model.Entry, error) {
	// Validate feedID exists if provided
	if params.FeedID != nil {
		_, err := s.feeds.GetByID(ctx, *params.FeedID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, err
		}
	}

	// Validate folderID exists if provided
	if params.FolderID != nil {
		_, err := s.folders.GetByID(ctx, *params.FolderID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, err
		}
	}

	// Set default limit
	// Allow up to 101 for internal hasMore check (handler requests limit+1)
	limit := params.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 101 {
		limit = 101
	}

	// 「保存筛选视图」：作用域与条件都来自视图，其余列表参数（未读/内容类型/星标/静音口径）照旧生效
	if params.ViewID != nil {
		return s.listByView(ctx, *params.ViewID, params, limit)
	}

	filter := repository.EntryListFilter{
		FeedID:       params.FeedID,
		FolderID:     params.FolderID,
		ContentType:  params.ContentType,
		UnreadOnly:   params.UnreadOnly,
		StarredOnly:  params.StarredOnly,
		HasThumbnail: params.HasThumbnail,
		IncludeMuted: params.IncludeMuted,
		MutedOnly:    params.MutedOnly,
		Limit:        limit,
		Offset:       params.Offset,
	}

	entries, err := s.entries.List(ctx, filter)
	if err != nil {
		logger.Error("entry list failed", "module", "service", "action", "list", "resource", "entry", "result", "failed", "error", err)
		return nil, err
	}
	logger.Debug("entry list", "module", "service", "action", "list", "resource", "entry", "result", "ok", "count", len(entries))
	return entries, nil
}

// viewScanLimit 视图最多回看这么多条再在内存里按条件筛（避免为「一个视图」改造成 SQL 条件翻译）。
// 视图本来就是「最近这些内容」的阅读入口，配未读/星标等胶囊足够收窄。
const viewScanLimit = 1000

// listByView 按「保存筛选视图」取条目：作用域 + 条件与规则引擎用的是同一套求值函数（不会两套语义）。
//
// 分页口径：作用域内先取最近 viewScanLimit 条，在内存里按条件筛完再按 offset/limit 切片。
// handler 仍然按「多要一条判断 hasMore」的惯例调用 —— 这里的 limit 已经是 limit+1。
func (s *entryService) listByView(ctx context.Context, viewID int64, params EntryListParams, limit int) ([]model.Entry, error) {
	view, err := s.filters.GetByID(ctx, viewID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if view.Kind != model.FilterKindView {
		return nil, ErrNotFound
	}

	// 视图的作用域覆盖列表里的 feedId/folderId；其余筛选参数继续生效
	scope := repository.EntryListFilter{
		ContentType:  params.ContentType,
		UnreadOnly:   params.UnreadOnly,
		StarredOnly:  params.StarredOnly,
		HasThumbnail: params.HasThumbnail,
		IncludeMuted: params.IncludeMuted,
		MutedOnly:    params.MutedOnly,
		Limit:        viewScanLimit,
	}
	switch view.ScopeType {
	case model.FilterScopeFeed:
		scope.FeedID = view.ScopeID
	case model.FilterScopeFolder:
		scope.FolderID = view.ScopeID
	}

	candidates, err := s.entries.List(ctx, scope)
	if err != nil {
		logger.Error("entry list by view failed", "module", "service", "action", "list", "resource", "entry", "result", "failed", "view_id", viewID, "error", err)
		return nil, err
	}

	feedByID, folderNames, err := s.viewContext(ctx)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	matched := make([]model.Entry, 0, limit)
	skipped := 0
	for _, entry := range candidates {
		feed, ok := feedByID[entry.FeedID]
		if !ok {
			continue
		}
		if !ScopeMatches(view, feed) {
			continue
		}
		entryCtx := buildEntryContext(entry, feed, folderNames)
		// 视图不执行动作，AI 条件自然也不该在浏览列表时花钱：这里不注入判定函数（判不成 = 不命中）
		if !MatchConditions(entryCtx, view.Conditions, now, nil) {
			continue
		}
		if skipped < params.Offset {
			skipped++
			continue
		}
		matched = append(matched, entry)
		if len(matched) >= limit {
			break
		}
	}

	logger.Debug("entry list by view", "module", "service", "action", "list", "resource", "entry", "result", "ok",
		"view_id", viewID, "scanned", len(candidates), "matched", len(matched))
	return matched, nil
}

// viewContext 视图求值要用订阅元数据与分类名（与规则引擎共用同一份上下文构造）。
func (s *entryService) viewContext(ctx context.Context) (map[int64]model.Feed, map[int64]string, error) {
	feeds, err := s.feeds.List(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	feedByID := make(map[int64]model.Feed, len(feeds))
	for _, feed := range feeds {
		feedByID[feed.ID] = feed
	}

	folderNames := make(map[int64]string)
	if s.folders != nil {
		if folders, err := s.folders.List(ctx); err == nil {
			for _, folder := range folders {
				folderNames[folder.ID] = folder.Name
			}
		}
	}
	return feedByID, folderNames, nil
}

func (s *entryService) GetByID(ctx context.Context, id int64) (model.Entry, error) {
	entry, err := s.entries.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Entry{}, ErrNotFound
		}
		return model.Entry{}, err
	}
	logger.Debug("entry get", "module", "service", "action", "fetch", "resource", "entry", "result", "ok", "entry_id", id)
	return entry, nil
}

// Unmute 取消单条条目的静音：清掉规则写的 muted/filter_id，并让它回到未读流里。
func (s *entryService) Unmute(ctx context.Context, id int64) error {
	entry, err := s.entries.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if !entry.Muted {
		return nil
	}
	if _, err := s.entries.ResetFilterState(ctx, []int64{id}, true); err != nil {
		logger.Error("entry unmute failed", "module", "service", "action", "update", "resource", "entry", "result", "failed", "entry_id", id, "error", err)
		return err
	}
	logger.Info("entry unmuted", "module", "service", "action", "update", "resource", "entry", "result", "ok", "entry_id", id)
	return nil
}

func (s *entryService) MarkAsRead(ctx context.Context, id int64, read bool) error {
	// Check entry exists
	_, err := s.entries.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}

	if err := s.entries.UpdateReadStatus(ctx, id, read); err != nil {
		logger.Error("entry update read failed", "module", "service", "action", "update", "resource", "entry", "result", "failed", "entry_id", id, "read", read, "error", err)
		return err
	}
	logger.Info("entry read updated", "module", "service", "action", "update", "resource", "entry", "result", "ok", "entry_id", id, "read", read)
	return nil
}

func (s *entryService) MarkManyAsRead(ctx context.Context, ids []int64, read bool) error {
	if len(ids) == 0 {
		return nil
	}

	if err := s.entries.UpdateManyReadStatus(ctx, ids, read); err != nil {
		logger.Error("entries update read failed", "module", "service", "action", "update", "resource", "entry", "result", "failed", "count", len(ids), "read", read, "error", err)
		return err
	}
	logger.Info("entries read updated", "module", "service", "action", "update", "resource", "entry", "result", "ok", "count", len(ids), "read", read)
	return nil
}

func (s *entryService) MarkAllAsRead(ctx context.Context, feedID *int64, folderID *int64, contentType *string) error {
	// Validate feedID exists if provided
	if feedID != nil {
		_, err := s.feeds.GetByID(ctx, *feedID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
	}

	// Validate folderID exists if provided
	if folderID != nil {
		_, err := s.folders.GetByID(ctx, *folderID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
	}

	var feedIDValue any
	if feedID != nil {
		feedIDValue = *feedID
	}
	var folderIDValue any
	if folderID != nil {
		folderIDValue = *folderID
	}
	var contentTypeValue any
	if contentType != nil {
		contentTypeValue = *contentType
	}

	if err := s.entries.MarkAllAsRead(ctx, feedID, folderID, contentType); err != nil {
		logger.Error("entries mark all read failed", "module", "service", "action", "update", "resource", "entry", "result", "failed", "feed_id", feedIDValue, "folder_id", folderIDValue, "content_type", contentTypeValue, "error", err)
		return err
	}
	logger.Info("entries marked read", "module", "service", "action", "update", "resource", "entry", "result", "ok", "feed_id", feedIDValue, "folder_id", folderIDValue, "content_type", contentTypeValue)
	return nil
}

func (s *entryService) GetUnreadCounts(ctx context.Context) (map[int64]int, error) {
	counts, err := s.entries.GetAllUnreadCounts(ctx)
	if err != nil {
		logger.Error("entry unread counts failed", "module", "service", "action", "list", "resource", "entry", "result", "failed", "error", err)
		return nil, err
	}

	result := make(map[int64]int)
	for _, uc := range counts {
		result[uc.FeedID] = uc.Count
	}

	return result, nil
}

func (s *entryService) MarkAsStarred(ctx context.Context, id int64, starred bool) error {
	// Check entry exists
	_, err := s.entries.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}

	if err := s.entries.UpdateStarredStatus(ctx, id, starred); err != nil {
		logger.Error("entry update starred failed", "module", "service", "action", "update", "resource", "entry", "result", "failed", "entry_id", id, "starred", starred, "error", err)
		return err
	}
	logger.Info("entry starred updated", "module", "service", "action", "update", "resource", "entry", "result", "ok", "entry_id", id, "starred", starred)
	return nil
}

func (s *entryService) GetStarredCount(ctx context.Context, contentType string) (int, error) {
	var scope *string
	if trimmed := strings.TrimSpace(contentType); trimmed != "" {
		scope = &trimmed
	}
	count, err := s.entries.GetStarredCount(ctx, scope)
	if err != nil {
		logger.Error("entry starred count failed", "module", "service", "action", "list", "resource", "entry", "result", "failed", "error", err)
		return 0, err
	}
	logger.Debug("entry starred count", "module", "service", "action", "list", "resource", "entry", "result", "ok", "count", count)
	return count, nil
}

func (s *entryService) ClearReadabilityCache(ctx context.Context) (int64, error) {
	deleted, err := s.entries.ClearAllReadableContent(ctx)
	if err != nil {
		logger.Error("readability cache clear failed", "module", "service", "action", "clear", "resource", "entry", "result", "failed", "error", err)
		return 0, err
	}
	logger.Info("readability cache cleared", "module", "service", "action", "clear", "resource", "entry", "result", "ok", "count", deleted)
	return deleted, nil
}

func (s *entryService) ClearEntryCache(ctx context.Context) (int64, error) {
	deleted, err := s.entries.DeleteUnstarred(ctx)
	if err != nil {
		logger.Error("entry cache clear failed", "module", "service", "action", "clear", "resource", "entry", "result", "failed", "error", err)
		return 0, err
	}
	// 重置所有 feeds 的 Conditional GET 信息，强制下次刷新时全量拉取
	// 避免因 304 Not Modified 导致已删除的文章无法被重新拉取
	if _, resetErr := s.feeds.ClearAllConditionalGet(ctx); resetErr != nil {
		logger.Warn("feed conditional get reset failed", "module", "service", "action", "update", "resource", "feed", "result", "failed", "error", resetErr)
	}
	logger.Info("entry cache cleared", "module", "service", "action", "clear", "resource", "entry", "result", "ok", "count", deleted)
	return deleted, nil
}
