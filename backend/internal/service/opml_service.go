//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/opml"
)

type OPMLService interface {
	Import(ctx context.Context, reader io.Reader, onProgress func(ImportProgress)) (ImportResult, error)
	Export(ctx context.Context) ([]byte, error)
}

type ImportResult struct {
	FoldersCreated int `json:"foldersCreated"`
	FoldersSkipped int `json:"foldersSkipped"`
	FeedsCreated   int `json:"feedsCreated"`
	FeedsSkipped   int `json:"feedsSkipped"`
}

type ImportProgress struct {
	Total   int    `json:"total"`
	Current int    `json:"current"`
	Feed    string `json:"feed,omitempty"`
	Status  string `json:"status"` // "started", "importing", "done", "error"
}

type opmlService struct {
	folderService  FolderService
	feedService    FeedService
	refreshService RefreshService
	iconService    IconService
	folders        repository.FolderRepository
	feeds          repository.FeedRepository
}

func NewOPMLService(
	folderService FolderService,
	feedService FeedService,
	refreshService RefreshService,
	iconService IconService,
	folders repository.FolderRepository,
	feeds repository.FeedRepository,
) OPMLService {
	return &opmlService{
		folderService:  folderService,
		feedService:    feedService,
		refreshService: refreshService,
		iconService:    iconService,
		folders:        folders,
		feeds:          feeds,
	}
}

func (s *opmlService) Import(ctx context.Context, reader io.Reader, onProgress func(ImportProgress)) (ImportResult, error) {
	doc, err := opml.Parse(reader)
	if err != nil {
		return ImportResult{}, ErrInvalid
	}

	// Count total feeds
	total := countFeeds(doc.Body.Outlines)

	logger.Info("opml import parsed", "module", "service", "action", "import", "resource", "opml", "result", "ok", "count", total)
	// Send started progress
	if onProgress != nil {
		onProgress(ImportProgress{Total: total, Current: 0, Status: "started"})
	}

	result := ImportResult{}
	current := 0
	var newFeedIDs []int64

	for _, outline := range doc.Body.Outlines {
		if err := s.importOutline(ctx, outline, nil, "article", &result, &current, total, onProgress, &newFeedIDs); err != nil {
			logger.Error("opml import failed", "module", "service", "action", "import", "resource", "opml", "result", "failed", "error", err)
			return result, err
		}

	}

	// Concurrently refresh newly created feeds and backfill icons
	if len(newFeedIDs) > 0 {
		go func() {
			bgCtx := context.Background()
			if s.refreshService != nil {
				_ = s.refreshService.RefreshFeeds(bgCtx, newFeedIDs)
			}
			if s.iconService != nil {
				_ = s.iconService.BackfillIcons(bgCtx)
			}
		}()
	}

	logger.Info("opml import completed", "module", "service", "action", "import", "resource", "opml", "result", "ok", "folders_created", result.FoldersCreated, "folders_skipped", result.FoldersSkipped, "feeds_created", result.FeedsCreated, "feeds_skipped", result.FeedsSkipped)
	return result, nil
}

func countFeeds(outlines []opml.Outline) int {
	count := 0
	for _, outline := range outlines {
		if isFeedOutline(outline) {
			count++
		} else {
			count += countFeeds(outline.Outlines)
		}
	}
	return count
}

func (s *opmlService) Export(ctx context.Context) ([]byte, error) {
	folders, err := s.folders.List(ctx)
	if err != nil {
		logger.Error("opml export list folders failed", "module", "service", "action", "export", "resource", "opml", "result", "failed", "error", err)
		return nil, fmt.Errorf("list folders: %w", err)
	}
	feeds, err := s.feeds.List(ctx, nil)
	if err != nil {
		logger.Error("opml export list feeds failed", "module", "service", "action", "export", "resource", "opml", "result", "failed", "error", err)
		return nil, fmt.Errorf("list feeds: %w", err)
	}

	rootOutlines := buildExportOutlines(folders, feeds)
	date := time.Now().UTC().Format(time.RFC1123Z)
	doc := opml.Document{
		Version: "2.0",
		Head: opml.Head{
			Title:        "Krss Subscriptions",
			DateCreated:  date,
			DateModified: date,
		},
		Body: opml.Body{Outlines: rootOutlines},
	}

	payload, err := opml.Encode(doc)
	if err != nil {
		logger.Error("opml export encode failed", "module", "service", "action", "export", "resource", "opml", "result", "failed", "error", err)
		return nil, fmt.Errorf("encode opml: %w", err)
	}
	logger.Info("opml export completed", "module", "service", "action", "export", "resource", "opml", "result", "ok", "folders", len(folders), "feeds", len(feeds))
	return payload, nil
}

func (s *opmlService) importOutline(
	ctx context.Context,
	outline opml.Outline,
	parentID *int64,
	folderType string,
	result *ImportResult,
	current *int,
	total int,
	onProgress func(ImportProgress),
	newFeedIDs *[]int64,
) error {
	// Check if context is cancelled
	if ctx.Err() != nil {
		return ctx.Err()
	}

	if isFeedOutline(outline) {
		return s.importFeed(ctx, outline, parentID, folderType, result, current, total, onProgress, newFeedIDs)
	}

	folderName := pickOutlineTitle(outline)
	// 优先用导出时写入的 krss:type 还原文件夹类型；外部 OPML 没有该属性时回退 article（保持旧行为）。
	ownType := pickFolderType(outline)
	folder, created, err := s.ensureFolder(ctx, folderName, parentID, ownType)
	if err != nil {
		return err
	}
	if created {
		result.FoldersCreated++
	} else {
		result.FoldersSkipped++
	}

	for _, child := range outline.Outlines {
		// Use the folder's actual type (may differ from parent if folder already existed)
		if err := s.importOutline(ctx, child, &folder.ID, folder.Type, result, current, total, onProgress, newFeedIDs); err != nil {
			return err
		}
	}

	return nil
}

func (s *opmlService) ensureFolder(ctx context.Context, name string, parentID *int64, folderType string) (model.Folder, bool, error) {
	if strings.TrimSpace(name) == "" {
		name = "Untitled"
	}
	if strings.TrimSpace(folderType) == "" {
		folderType = "article"
	}

	// Try to find existing folder first
	if existing, err := s.folders.FindByName(ctx, name, parentID); err != nil {
		return model.Folder{}, false, fmt.Errorf("find folder: %w", err)
	} else if existing != nil {
		return *existing, false, nil
	}

	// Create new folder using FolderService
	folder, err := s.folderService.Create(ctx, name, parentID, folderType)
	if err != nil {
		if errors.Is(err, ErrConflict) {
			// Race condition: folder was created between check and create
			if existing, findErr := s.folders.FindByName(ctx, name, parentID); findErr == nil && existing != nil {
				return *existing, false, nil
			}
		}
		return model.Folder{}, false, fmt.Errorf("create folder: %w", err)
	}
	return folder, true, nil
}

func (s *opmlService) importFeed(
	ctx context.Context,
	outline opml.Outline,
	folderID *int64,
	folderType string,
	result *ImportResult,
	current *int,
	total int,
	onProgress func(ImportProgress),
	newFeedIDs *[]int64,
) error {
	feedURL := strings.TrimSpace(outline.XMLURL)
	title := strings.TrimSpace(outline.Title)
	if title == "" {
		title = strings.TrimSpace(outline.Text)
	}

	// Send progress before importing
	*current++
	if onProgress != nil {
		onProgress(ImportProgress{
			Total:   total,
			Current: *current,
			Feed:    title,
			Status:  "importing",
		})
	}

	if feedURL == "" {
		result.FeedsSkipped++
		return nil
	}

	// MCP 订阅：URL 不是 http(s)，无法走 AddWithoutFetch（它要求 http/https）。
	// 用显式的 krss:sourceType=mcp 或 mcp:// 前缀识别，直接写库重建，避免误建成普通 RSS。
	if isMCPFeedOutline(outline, feedURL) {
		return s.importMCPFeed(ctx, outline, feedURL, title, folderID, result)
	}

	// 用 AddWithoutFetch 快速创建订阅记录（不发网络请求）。
	// 它要求 feed 类型与所在文件夹类型一致，所以先按 folderType 建，再用 UpdateType 纠正成真实类型。
	feedType := resolveFeedType(outline, folderType)
	feed, isNew, err := s.feedService.AddWithoutFetch(ctx, feedURL, folderID, title, folderType)
	if err != nil {
		return fmt.Errorf("add feed %s: %w", feedURL, err)
	}

	if !isNew {
		result.FeedsSkipped++
		return nil
	}

	if feedType != "" && feedType != folderType {
		if err := s.feedService.UpdateType(ctx, feed.ID, feedType); err != nil {
			logger.Warn("opml import update feed type failed", "module", "service", "action", "import", "resource", "opml", "result", "failed", "feed_id", feed.ID, "feed_type", feedType, "error", err)
		}
	}

	result.FeedsCreated++
	*newFeedIDs = append(*newFeedIDs, feed.ID)
	return nil
}

// importMCPFeed 重建一条 MCP 订阅。MCP 订阅的 URL 形如 mcp://…，无法用 AddWithoutFetch 校验，
// 因此直接调用仓储 Create，并显式写入 source_type=mcp 与 mcp_config。
func (s *opmlService) importMCPFeed(
	ctx context.Context,
	outline opml.Outline,
	feedURL string,
	title string,
	folderID *int64,
	result *ImportResult,
) error {
	if s.feeds == nil {
		result.FeedsSkipped++
		return nil
	}

	existing, err := s.feeds.FindByURL(ctx, feedURL)
	if err != nil {
		return fmt.Errorf("find mcp feed: %w", err)
	}
	if existing != nil {
		result.FeedsSkipped++
		return nil
	}

	feedType := resolveFeedType(outline, "article")
	var mcpConfig *string
	if cfg := strings.TrimSpace(outline.KrssMCPConfig); cfg != "" {
		c := cfg
		mcpConfig = &c
	}

	if _, err := s.feeds.Create(ctx, model.Feed{
		FolderID:   folderID,
		Title:      title,
		URL:        feedURL,
		Type:       feedType,
		SourceType: model.FeedSourceMCP,
		MCPConfig:  mcpConfig,
	}); err != nil {
		return fmt.Errorf("create mcp feed %s: %w", feedURL, err)
	}

	result.FeedsCreated++
	return nil
}

// isMCPFeedOutline 判断一个 outline 是否为 MCP 订阅：
// 显式 krss:sourceType=mcp，或 URL 以 mcp:// 开头。
func isMCPFeedOutline(outline opml.Outline, feedURL string) bool {
	if strings.EqualFold(strings.TrimSpace(outline.KrssSourceType), model.FeedSourceMCP) {
		return true
	}
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(feedURL)), "mcp://")
}

// resolveFeedType 取订阅的真实内容类型：优先 krss:type，其次沿用所在文件夹类型，最后 article。
func resolveFeedType(outline opml.Outline, folderType string) string {
	if t := strings.TrimSpace(outline.KrssType); t != "" {
		return t
	}
	if strings.TrimSpace(folderType) != "" {
		return folderType
	}
	return "article"
}

// pickFolderType 取文件夹的真实内容类型：优先 krss:type，缺省 article。
func pickFolderType(outline opml.Outline) string {
	if t := strings.TrimSpace(outline.KrssType); t != "" {
		return t
	}
	return "article"
}

func isFeedOutline(outline opml.Outline) bool {
	if strings.TrimSpace(outline.XMLURL) != "" {
		return true
	}
	feedType := strings.ToLower(strings.TrimSpace(outline.Type))
	return feedType == "rss" || feedType == "atom" || feedType == "feed"
}

func pickOutlineTitle(outline opml.Outline) string {
	if strings.TrimSpace(outline.Title) != "" {
		return outline.Title
	}
	return outline.Text
}

type folderNode struct {
	folder model.Folder
	child  []*folderNode
	feeds  []model.Feed
}

func buildExportOutlines(folders []model.Folder, feeds []model.Feed) []opml.Outline {
	nodeByID := make(map[int64]*folderNode)
	for _, folder := range folders {
		nodeByID[folder.ID] = &folderNode{folder: folder}
	}

	var roots []*folderNode
	for _, node := range nodeByID {
		if node.folder.ParentID == nil {
			roots = append(roots, node)
			continue
		}
		parent := nodeByID[*node.folder.ParentID]
		if parent == nil {
			roots = append(roots, node)
			continue
		}
		parent.child = append(parent.child, node)
	}

	var rootFeeds []model.Feed
	for _, feed := range feeds {
		if feed.FolderID == nil {
			rootFeeds = append(rootFeeds, feed)
			continue
		}
		parent := nodeByID[*feed.FolderID]
		if parent == nil {
			rootFeeds = append(rootFeeds, feed)
			continue
		}
		parent.feeds = append(parent.feeds, feed)
	}

	sort.Slice(roots, func(i, j int) bool {
		return strings.ToLower(roots[i].folder.Name) < strings.ToLower(roots[j].folder.Name)
	})
	sort.Slice(rootFeeds, func(i, j int) bool {
		return strings.ToLower(rootFeeds[i].Title) < strings.ToLower(rootFeeds[j].Title)
	})

	var outlines []opml.Outline
	for _, node := range roots {
		outlines = append(outlines, buildFolderOutline(node))
	}
	for _, feed := range rootFeeds {
		outlines = append(outlines, buildFeedOutline(feed))
	}
	return outlines
}

func buildFolderOutline(node *folderNode) opml.Outline {
	sort.Slice(node.child, func(i, j int) bool {
		return strings.ToLower(node.child[i].folder.Name) < strings.ToLower(node.child[j].folder.Name)
	})
	sort.Slice(node.feeds, func(i, j int) bool {
		return strings.ToLower(node.feeds[i].Title) < strings.ToLower(node.feeds[j].Title)
	})

	outline := opml.Outline{
		Text:     node.folder.Name,
		Title:    node.folder.Name,
		KrssType: node.folder.Type,
	}
	for _, child := range node.child {
		outline.Outlines = append(outline.Outlines, buildFolderOutline(child))
	}
	for _, feed := range node.feeds {
		outline.Outlines = append(outline.Outlines, buildFeedOutline(feed))
	}
	return outline
}

func buildFeedOutline(feed model.Feed) opml.Outline {
	sourceType := feed.SourceType
	if strings.TrimSpace(sourceType) == "" {
		sourceType = model.FeedSourceRSS
	}
	outline := opml.Outline{
		Text:           feed.Title,
		Title:          feed.Title,
		Type:           "rss",
		XMLURL:         feed.URL,
		KrssType:       feed.Type,
		KrssSourceType: sourceType,
	}
	if feed.SiteURL != nil {
		outline.HTMLURL = *feed.SiteURL
	}
	if feed.MCPConfig != nil {
		outline.KrssMCPConfig = *feed.MCPConfig
	}
	return outline
}
