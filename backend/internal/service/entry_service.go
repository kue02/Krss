//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/repository"
	"krss/backend/pkg/logger"
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

// ViewMatchedFeed 「保存筛选视图」当前命中的订阅聚合：某订阅在这个视图下当前有多少条内容。
// 侧栏把视图展开成「智能文件夹」时，用它列出「这个视图当前匹配到的订阅源」。
type ViewMatchedFeed struct {
	FeedID    int64
	FeedTitle string
	Count     int
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
	// ListViewMatchedFeeds 按「保存筛选视图」聚合当前命中的订阅（智能文件夹展开用）。
	// 只返回 count>0 的订阅；contentType 为 nil = 不按内容类型过滤。
	ListViewMatchedFeeds(ctx context.Context, viewID int64, contentType *string) ([]ViewMatchedFeed, error)
	// ClearReadabilityCache clears all readable_content from entries
	ClearReadabilityCache(ctx context.Context) (int64, error)
	// ClearEntryCache deletes read and unstarred entries (preserves starred and unread entries)
	ClearEntryCache(ctx context.Context) (int64, error)
	// WithPlugins 装上插件注册表（55-21：条目详情读取时跑阅读期处理器）。
	// builder 形状照 RefreshService.WithPlugins：main.go 构造处一行接上，不传 = 老行为。
	WithPlugins(registry *plugin.Registry) EntryService
	// WithEntryProcessorTimeout 覆盖单个阅读期处理器的超时（默认 2s；测试用短超时）。
	WithEntryProcessorTimeout(timeout time.Duration) EntryService
	// WithCacheSettings 装上缓存清理设置来源（1123）：清理时按保留期计算时间门槛。
	// builder 形状同 WithPlugins：main.go 构造处一行接上，不传 = 用默认保留期。
	WithCacheSettings(settings SettingsService) EntryService
}

// entryProcessorTimeout 单个阅读期处理器的超时（插件运行时安全）。
// 铁律：一个插件不许拖住正文 —— 每个插件单独给这么久，超时就跳过，继续下一个。
const entryProcessorTimeout = 2 * time.Second

type entryService struct {
	entries repository.EntryRepository
	feeds   repository.FeedRepository
	folders repository.FolderRepository
	// filters 只读用途：把「保存筛选视图」（filters.kind = view）的作用域与条件套到列表上
	filters repository.FilterRepository
	// plugins 阅读期处理器来源（55-21）；nil = 老行为（详情原样返回）。
	plugins *plugin.Registry
	// processorTimeout 单个处理器的超时；默认 entryProcessorTimeout，测试可改小。
	processorTimeout time.Duration
	// settings 缓存清理设置来源（1123）；nil = 用默认保留期（30/180 天）。
	settings SettingsService
}

func NewEntryService(
	entries repository.EntryRepository,
	feeds repository.FeedRepository,
	folders repository.FolderRepository,
	filters repository.FilterRepository,
) EntryService {
	return &entryService{
		entries:          entries,
		feeds:            feeds,
		folders:          folders,
		filters:          filters,
		processorTimeout: entryProcessorTimeout,
	}
}

// WithPlugins 装上插件注册表（55-21：条目详情读取时跑阅读期处理器）。
// 用 builder 而不是加构造参数：既有 10+ 处测试调用点零改动，nil 就是老行为。
func (s *entryService) WithPlugins(registry *plugin.Registry) EntryService {
	s.plugins = registry
	return s
}

// WithEntryProcessorTimeout 覆盖单个阅读期处理器的超时（默认 2s）。
// 主要给测试用：真等 2s 太慢，短超时就能验证「卡住的插件不拖住正文」。
func (s *entryService) WithEntryProcessorTimeout(timeout time.Duration) EntryService {
	if timeout > 0 {
		s.processorTimeout = timeout
	}
	return s
}

// WithCacheSettings 装上缓存清理设置来源（1123）：不传 = 清理时用默认保留期。
func (s *entryService) WithCacheSettings(settings SettingsService) EntryService {
	s.settings = settings
	return s
}

// runEntryProcessors 阅读期处理（55 批）：插件对某类订阅源的特别优化落在这一层。
// 铁律：处理器出错只记日志、返回原条目 —— 阅读体验不能被一个插件搞坏；
// 也不写库（读路径 Pure），入库数据永远保持源站原样。
func (s *entryService) runEntryProcessors(ctx context.Context, entry model.Entry) model.Entry {
	if s.plugins == nil {
		return entry
	}
	feed, err := s.feeds.GetByID(ctx, entry.FeedID)
	if err != nil {
		// 订阅源取不到（刚被删 / 数据不齐）：不认路，原样返回。
		return entry
	}
	for _, processor := range s.plugins.EntryProcessors() {
		// 父 ctx 已取消（用户离开 / 请求断开）：立即停手，别再调后面的插件。
		if ctx.Err() != nil {
			break
		}
		if !processor.Matches(feed, entry) {
			continue
		}
		// 每个插件单独限时：单个插件卡住/超时只跳过它，继续下一个，绝不拖住正文。
		procCtx, cancel := context.WithTimeout(ctx, s.processorTimeout)
		processed, err := processor.Process(procCtx, entry)
		cancel()
		if err != nil {
			logger.Warn("entry processor failed", "module", "service", "action", "process", "resource", "entry", "result", "failed", "processor", processor.ID(), "entry_id", entry.ID, "error", err)
			continue
		}
		entry = processed
	}
	return entry
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
		FeedID:          params.FeedID,
		FolderID:        params.FolderID,
		ContentType:     params.ContentType,
		UnreadOnly:      params.UnreadOnly,
		StarredOnly:     params.StarredOnly,
		HasThumbnail:    params.HasThumbnail,
		IncludeMuted:    params.IncludeMuted,
		MutedOnly:       params.MutedOnly,
		Limit:           limit,
		Offset:          params.Offset,
		ContentTruncate: repository.ListContentTruncate,
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
		ContentType:     params.ContentType,
		UnreadOnly:      params.UnreadOnly,
		StarredOnly:     params.StarredOnly,
		HasThumbnail:    params.HasThumbnail,
		IncludeMuted:    params.IncludeMuted,
		MutedOnly:       params.MutedOnly,
		Limit:           viewScanLimit,
		ContentTruncate: repository.ListContentTruncate,
	}
	switch view.ScopeType {
	case model.FilterScopeFeed:
		if len(view.ScopeIDs) > 0 {
			scope.FeedIDs = view.ScopeIDs
		} else {
			scope.FeedID = view.ScopeID
		}
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

// ListViewMatchedFeeds 按「保存筛选视图」聚合当前命中的订阅（侧栏「智能文件夹」展开用）。
//
// 求值完全复用 listByView 的同一套函数（ScopeMatches / buildEntryContext / MatchConditions），
// 保证「展开看到的订阅列表」与「点进去看到的条目」语义一致：没命中内容的订阅不出现。
// count 是该订阅在视图内的全体命中数（与 listByView 同一口径，不随「只看未读」等临时胶囊变化）。
// 不分页 —— 这是聚合全部命中的订阅，不是翻页。返回按 count 降序、再按 feedTitle 升序（并列再按 feedId，保证稳定）。
func (s *entryService) ListViewMatchedFeeds(ctx context.Context, viewID int64, contentType *string) ([]ViewMatchedFeed, error) {
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

	// 视图的作用域覆盖候选条目；contentType 收窄类型，其余筛选口径为零值（默认隐藏被静音的条目）。
	scope := repository.EntryListFilter{
		ContentType:     contentType,
		Limit:           viewScanLimit,
		ContentTruncate: repository.ListContentTruncate,
	}
	switch view.ScopeType {
	case model.FilterScopeFeed:
		if len(view.ScopeIDs) > 0 {
			scope.FeedIDs = view.ScopeIDs
		} else {
			scope.FeedID = view.ScopeID
		}
	case model.FilterScopeFolder:
		scope.FolderID = view.ScopeID
	}

	candidates, err := s.entries.List(ctx, scope)
	if err != nil {
		logger.Error("entry list view matched feeds failed", "module", "service", "action", "list", "resource", "entry", "result", "failed", "view_id", viewID, "error", err)
		return nil, err
	}

	feedByID, folderNames, err := s.viewContext(ctx)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	counts := make(map[int64]int)
	titles := make(map[int64]string)
	for _, entry := range candidates {
		feed, ok := feedByID[entry.FeedID]
		if !ok {
			continue
		}
		if !ScopeMatches(view, feed) {
			continue
		}
		entryCtx := buildEntryContext(entry, feed, folderNames)
		// 视图不执行动作，AI 条件自然也不该在浏览时花钱：这里不注入判定函数（判不成 = 不命中）。
		if !MatchConditions(entryCtx, view.Conditions, now, nil) {
			continue
		}
		counts[feed.ID]++
		if _, seen := titles[feed.ID]; !seen {
			titles[feed.ID] = feed.Title
		}
	}

	feeds := make([]ViewMatchedFeed, 0, len(counts))
	for feedID, count := range counts {
		feeds = append(feeds, ViewMatchedFeed{FeedID: feedID, FeedTitle: titles[feedID], Count: count})
	}
	sort.Slice(feeds, func(i, j int) bool {
		if feeds[i].Count != feeds[j].Count {
			return feeds[i].Count > feeds[j].Count
		}
		if feeds[i].FeedTitle != feeds[j].FeedTitle {
			return feeds[i].FeedTitle < feeds[j].FeedTitle
		}
		return feeds[i].FeedID < feeds[j].FeedID
	})

	logger.Debug("entry list view matched feeds", "module", "service", "action", "list", "resource", "entry", "result", "ok",
		"view_id", viewID, "scanned", len(candidates), "feeds", len(feeds))
	return feeds, nil
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
	return s.runEntryProcessors(ctx, entry), nil
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
	// 1123：清理范围由设置决定。已读保留期 entryDays：0 = 清全部（老行为）；
	// 墓碑保留期 tombDays：0 = 永久保留（不让旧墓碑过期）。
	entryDays := DefaultCacheEntryRetentionDays
	tombDays := DefaultCacheTombstoneRetentionDays
	if s.settings != nil {
		if cs, err := s.settings.GetCacheSettings(ctx); err != nil {
			// 设置读失败不能拖垮清理：回退默认保留期，照常清理。
			logger.Error("read cache settings failed, use defaults", "module", "service", "action", "clear", "resource", "entry", "result", "failed", "error", err)
		} else if cs != nil {
			entryDays = cs.EntryRetentionDays
			tombDays = cs.TombstoneRetentionDays
		}
	}

	now := time.Now()
	var entryBefore, tombstoneBefore *time.Time
	if entryDays > 0 {
		t := now.AddDate(0, 0, -entryDays)
		entryBefore = &t
	}
	if tombDays > 0 {
		t := now.AddDate(0, 0, -tombDays)
		tombstoneBefore = &t
	}

	deleted, err := s.entries.DeleteReadUnstarred(ctx, entryBefore, tombstoneBefore)
	if err != nil {
		logger.Error("entry cache clear failed", "module", "service", "action", "clear", "resource", "entry", "result", "failed", "error", err)
		return 0, err
	}
	// 不重置 feeds 的 Conditional GET：本次只清理「已读且未收藏」的条目，
	// 若清空 ETag，下一轮轮询会立刻全量回灌，被删的已读文章会以未读身份重新入库，
	// 既违背「保留已收藏和未读」的预期，也会让列表头部涌入大量条目。
	// 条目本身是硬删（不保留正文），但 DeleteReadUnstarred 会先写入极小的指纹墓碑
	// （entry_tombstones：feed_id + hash + url），之后刷新即使拿到全量 items 也会被
	// CreateOrUpdateSkippingTombstones 挡住，不会把清理过的文章重新插回来。
	logger.Info("entry cache cleared", "module", "service", "action", "clear", "resource", "entry", "result", "ok", "count", deleted)
	return deleted, nil
}
