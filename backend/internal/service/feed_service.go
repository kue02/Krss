//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mmcdole/gofeed"

	"krss/backend/internal/config"
	"krss/backend/internal/hashutil"
	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/network"
	"krss/backend/pkg/sanitizer"
)

const feedTimeout = 30 * time.Second
const maxFeedSummaryPromptReminderLength = 2000

type FeedService interface {
	Add(ctx context.Context, feedURL string, folderID *int64, titleOverride string, feedType string) (model.Feed, error)
	// AddMCP 新建一条 MCP 订阅（16 批）：落一条普通 feed 行（source_type='mcp'），
	// 并**立刻拉一次首批条目** —— 这是本项目两条入库路径里的第二条，不能被绕过。
	AddMCP(ctx context.Context, input MCPFeedAddInput) (model.Feed, error)
	AddWithoutFetch(ctx context.Context, feedURL string, folderID *int64, titleOverride string, feedType string) (model.Feed, bool, error)
	Preview(ctx context.Context, feedURL string) (FeedPreview, error)
	List(ctx context.Context, folderID *int64) ([]model.Feed, error)
	Update(ctx context.Context, id int64, title string, folderID *int64, summaryPromptReminder *string) (model.Feed, error)
	UpdateType(ctx context.Context, id int64, feedType string) error
	// UpdateURL 改订阅地址（RSSHub 实例换域名等场景）。
	// 目标地址已被别的订阅占用时返回 *FeedURLConflictError（前端据此弹「确认合并」）。
	UpdateURL(ctx context.Context, id int64, feedURL string) (model.Feed, error)
	// MergePreview 预览「把这个订阅换成某个地址」会发生什么：目标是谁、两边各有几条/几条星标
	MergePreview(ctx context.Context, sourceID int64, targetURL string) (FeedMergePreview, error)
	// MergeInto 把 source 订阅并入 target（条目改归属、去重、补分类，然后删掉 source）
	MergeInto(ctx context.Context, sourceID, targetID int64) (FeedMergeResult, error)
	// UpdateAIOverrides 单独设置某个订阅的自动翻译/自动摘要（nil = 跟随全局）
	UpdateAIOverrides(ctx context.Context, id int64, autoTranslate, autoSummary, readerMode *bool) (model.Feed, error)
	// UpdateProxyOverride 单独设置某个订阅的代理覆盖（迁移 26）：跟随上级 / 走代理 / 直连
	UpdateProxyOverride(ctx context.Context, id int64, update ProxyOverrideUpdate) (model.Feed, error)
	// UpdateMCPConfig 改 MCP 订阅的取数配置（16-14 编辑模式）：连接/工具-资源/参数/映射/分页/标题/文件夹。
	// 只允许 source_type='mcp' 的源；不立刻重拉（向导里预览门禁已经验过），下次刷新按新配置取。
	UpdateMCPConfig(ctx context.Context, id int64, input MCPFeedAddInput) (model.Feed, error)
	Delete(ctx context.Context, id int64) error
	DeleteBatch(ctx context.Context, ids []int64) error
}

type FeedPreview struct {
	URL         string
	Title       string
	Description *string
	SiteURL     *string
	ImageURL    *string
	ItemCount   *int
	LastUpdated *string
	// Entries 是订阅前「试看」用的前几条条目（不落库），
	// 用于添加订阅时按所选视图渲染真实效果。
	Entries []model.Entry
}

// MCPFeedAddInput 新建 MCP 订阅的入参（建源向导最后一步传进来的那份配置）。
// UpdateMCPConfig 复用它（忽略 FeedType）：编辑模式回填的连接/工具-资源/参数/映射/分页/标题/文件夹。
type MCPFeedAddInput struct {
	ServerID    int64
	Kind        string
	ToolName    string
	ResourceURI string
	Arguments   map[string]any
	Limit       int
	Mapping     model.MCPFieldMapping
	Pagination  *model.MCPPagination
	Tier        string
	KeyLevel    string
	Title       string
	FolderID    *int64
	FeedType    string
}

type feedService struct {
	feeds         repository.FeedRepository
	folders       repository.FolderRepository
	entries       repository.EntryRepository
	icons         IconService
	settings      SettingsService
	clientFactory *network.ClientFactory
	anubis        AnubisSolver
	filters       FilterService
	// mcp 16 批（入向）：可选依赖 —— 不传就建不了 MCP 订阅，RSS 路径完全不受影响。
	mcp MCPService
}

// NewFeedService 建订阅服务。mcpService 是可选依赖（变参，16 批加进来）——
// 既有调用点与测试一行不用改。
func NewFeedService(feeds repository.FeedRepository, folders repository.FolderRepository, entries repository.EntryRepository, icons IconService, settings SettingsService, clientFactory *network.ClientFactory, anubisSolver AnubisSolver, filters FilterService, mcpService ...MCPService) FeedService {
	svc := &feedService{feeds: feeds, folders: folders, entries: entries, icons: icons, settings: settings, clientFactory: clientFactory, anubis: anubisSolver, filters: filters}
	for _, m := range mcpService {
		svc.mcp = m
	}
	return svc
}

func (s *feedService) Add(ctx context.Context, feedURL string, folderID *int64, titleOverride string, feedType string) (model.Feed, error) {
	trimmedURL := strings.TrimSpace(feedURL)
	if !isValidURL(trimmedURL) {
		return model.Feed{}, ErrInvalid
	}
	if existing, err := s.feeds.FindByURL(ctx, trimmedURL); err != nil {
		return model.Feed{}, fmt.Errorf("check feed url: %w", err)
	} else if existing != nil {
		return model.Feed{}, &FeedConflictError{ExistingFeed: *existing}
	}
	if folderID != nil {
		folder, err := s.folders.GetByID(ctx, *folderID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return model.Feed{}, ErrNotFound
			}
			return model.Feed{}, fmt.Errorf("check folder: %w", err)
		}
		if folder.Type != feedType {
			logger.Warn("feed type mismatch with folder type", "module", "service", "action", "create", "resource", "feed", "result", "failed", "folder_id", *folderID, "folder_type", folder.Type, "feed_type", feedType)
			return model.Feed{}, ErrInvalid
		}
	}

	fetched, fetchErr := s.fetchFeed(ctx, trimmedURL)
	if fetchErr != nil {
		logger.Warn("feed fetch failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(trimmedURL), "error", fetchErr)
		// Fetch failed, create feed with error message
		finalTitle := strings.TrimSpace(titleOverride)
		if finalTitle == "" {
			finalTitle = trimmedURL
		}
		errMsg := fetchErr.Error()
		feed := model.Feed{
			FolderID:     folderID,
			Title:        finalTitle,
			URL:          trimmedURL,
			Type:         feedType,
			ErrorMessage: &errMsg,
		}
		return s.feeds.Create(ctx, feed)
	}

	finalTitle := strings.TrimSpace(titleOverride)
	if finalTitle == "" {
		finalTitle = strings.TrimSpace(fetched.title)
	}
	if finalTitle == "" {
		finalTitle = trimmedURL
	}

	feed := model.Feed{
		FolderID:     folderID,
		Title:        finalTitle,
		URL:          trimmedURL,
		SiteURL:      optionalString(fetched.siteURL),
		Description:  optionalString(fetched.description),
		Type:         feedType,
		ETag:         optionalString(fetched.etag),
		LastModified: optionalString(fetched.lastModified),
	}

	created, err := s.feeds.Create(ctx, feed)
	if err != nil {
		logger.Error("feed create failed", "module", "service", "action", "create", "resource", "feed", "result", "failed", "host", network.ExtractHost(trimmedURL), "error", err)
		return model.Feed{}, err
	}

	logger.Info("feed created", "module", "service", "action", "create", "resource", "feed", "result", "ok", "feed_id", created.ID, "feed_title", created.Title, "host", network.ExtractHost(created.URL))

	// Download and save icon
	if s.icons != nil {
		siteURL := ""
		if created.SiteURL != nil {
			siteURL = *created.SiteURL
		}
		if siteURL == "" {
			siteURL = trimmedURL // Use feed URL as fallback for favicon
		}
		if iconPath, err := s.icons.FetchAndSaveIconForFeed(ctx, created.ID, fetched.imageURL, siteURL); err == nil && iconPath != "" {
			_ = s.feeds.UpdateIconPath(ctx, created.ID, iconPath)
			created.IconPath = &iconPath
		}
	}

	// Save entries from the fetched feed
	dynamicTime := hasDynamicTime(fetched.items)
	newEntries := make([]model.Entry, 0, len(fetched.items))
	for _, item := range fetched.items {
		entry := itemToEntry(created.ID, item, dynamicTime)
		if entry.URL == nil || *entry.URL == "" {
			continue
		}
		if err := s.entries.CreateOrUpdate(ctx, entry); err != nil {
			logger.Warn("entry create failed", "module", "service", "action", "create", "resource", "entry", "result", "failed", "feed_id", created.ID, "feed_title", created.Title, "host", network.ExtractHost(*entry.URL), "error", err)
			continue
		}
		newEntries = append(newEntries, entry)
	}

	// 规则引擎挂在入库之后：新订阅的第一批条目也要过一遍
	// （这是本项目仅有的第二条入库路径，另一条在 refresh_service.saveEntries）。
	if len(newEntries) > 0 && s.filters != nil {
		if applied, err := s.filters.ApplyToEntries(ctx, created, newEntries); err != nil {
			logger.Warn("apply filters failed", "module", "service", "action", "apply", "resource", "filter", "result", "failed", "feed_id", created.ID, "error", err)
		} else if applied > 0 {
			logger.Info("filters applied on new entries", "module", "service", "action", "apply", "resource", "filter", "result", "ok", "feed_id", created.ID, "applied", applied)
		}
	}

	return created, nil
}

// AddMCP 新建 MCP 订阅（16 批）。与 Add() 的差别只在「怎么取第一批」：
// Add 走 HTTP+gofeed，这里走 MCP 服务；之后的入库 + 规则引擎部分与 Add 完全同构。
func (s *feedService) AddMCP(ctx context.Context, input MCPFeedAddInput) (model.Feed, error) {
	if s.mcp == nil {
		return model.Feed{}, fmt.Errorf("%w: MCP 服务未初始化", ErrInvalid)
	}
	config := model.MCPFeedConfig{
		ServerID:    model.SnowflakeID(input.ServerID),
		Kind:        input.Kind,
		ToolName:    input.ToolName,
		ResourceURI: input.ResourceURI,
		Arguments:   input.Arguments,
		Limit:       input.Limit,
		Mapping:     input.Mapping,
		Pagination:  input.Pagination,
		Tier:        input.Tier,
		KeyLevel:    input.KeyLevel,
	}
	rawConfig, err := BuildMCPFeedConfig(config)
	if err != nil {
		return model.Feed{}, err
	}

	feedURL := MCPFeedURL(config)
	if existing, err := s.feeds.FindByURL(ctx, feedURL); err != nil {
		return model.Feed{}, fmt.Errorf("check mcp feed url: %w", err)
	} else if existing != nil {
		return model.Feed{}, &FeedConflictError{ExistingFeed: *existing}
	}

	feedType := input.FeedType
	if feedType == "" {
		feedType = "article"
	}
	if input.FolderID != nil {
		folder, err := s.folders.GetByID(ctx, *input.FolderID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return model.Feed{}, ErrNotFound
			}
			return model.Feed{}, fmt.Errorf("check folder: %w", err)
		}
		if folder.Type != feedType {
			return model.Feed{}, ErrInvalid
		}
	}

	title := strings.TrimSpace(input.Title)
	if title == "" {
		title = defaultMCPFeedTitle(config)
	}

	created, err := s.feeds.Create(ctx, model.Feed{
		FolderID:   input.FolderID,
		Title:      title,
		URL:        feedURL,
		Type:       feedType,
		SourceType: model.FeedSourceMCP,
		MCPConfig:  &rawConfig,
	})
	if err != nil {
		logger.Error("mcp feed create failed", "module", "service", "action", "create", "resource", "feed", "result", "failed", "mcp_server_id", config.ServerID.Int64(), "error", err)
		return model.Feed{}, err
	}
	logger.Info("mcp feed created", "module", "service", "action", "create", "resource", "feed", "result", "ok",
		"feed_id", created.ID, "feed_title", created.Title, "mcp_server_id", config.ServerID.Int64(), "kind", config.Kind)

	// 首批条目：立刻拉一次（这条路径与刷新路径共用 MCPService.FetchFeedItems）。
	// 取数失败不吞：写进该源的 error_message（界面行内红字），订阅行照样建出来。
	result, fetchErr := s.mcp.FetchFeedItems(ctx, created)
	if fetchErr != nil {
		errMsg := fetchErr.Error()
		_ = s.feeds.UpdateErrorMessage(ctx, created.ID, &errMsg)
		created.ErrorMessage = &errMsg
		logger.Warn("mcp feed first fetch failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed",
			"feed_id", created.ID, "mcp_server_id", config.ServerID.Int64(), "error", fetchErr)
		return created, nil
	}

	newEntries := make([]model.Entry, 0, len(result.Items))
	dynamicTime := hasDynamicTime(result.Items)
	for _, item := range result.Items {
		entry := itemToEntry(created.ID, item, dynamicTime)
		if entry.URL == nil || *entry.URL == "" {
			continue
		}
		if err := s.entries.CreateOrUpdate(ctx, entry); err != nil {
			logger.Warn("entry create failed", "module", "service", "action", "create", "resource", "entry", "result", "failed", "feed_id", created.ID, "error", err)
			continue
		}
		newEntries = append(newEntries, entry)
	}

	// 规则引擎挂在入库之后（与 Add 同一处）：MCP 订阅的第一批条目也要过一遍
	if len(newEntries) > 0 && s.filters != nil {
		if applied, err := s.filters.ApplyToEntries(ctx, created, newEntries); err != nil {
			logger.Warn("apply filters failed", "module", "service", "action", "apply", "resource", "filter", "result", "failed", "feed_id", created.ID, "error", err)
		} else if applied > 0 {
			logger.Info("filters applied on new entries", "module", "service", "action", "apply", "resource", "filter", "result", "ok", "feed_id", created.ID, "applied", applied)
		}
	}

	return created, nil
}

// defaultMCPFeedTitle 没填标题时的默认名：MCP · 工具名（资源则用资源名/uri 尾段）。
func defaultMCPFeedTitle(config model.MCPFeedConfig) string {
	name := config.ToolName
	if config.Kind == "resource" {
		name = config.ResourceURI
		if index := strings.LastIndex(name, "/"); index >= 0 && index+1 < len(name) {
			name = name[index+1:]
		}
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "订阅"
	}
	return "MCP · " + name
}

// AddWithoutFetch creates a feed record without fetching content.
// Returns (feed, isNew, error). isNew is true if a new feed was created.
func (s *feedService) AddWithoutFetch(ctx context.Context, feedURL string, folderID *int64, titleOverride string, feedType string) (model.Feed, bool, error) {
	trimmedURL := strings.TrimSpace(feedURL)
	if !isValidURL(trimmedURL) {
		return model.Feed{}, false, ErrInvalid
	}
	if existing, err := s.feeds.FindByURL(ctx, trimmedURL); err != nil {
		return model.Feed{}, false, fmt.Errorf("check feed url: %w", err)
	} else if existing != nil {
		return *existing, false, nil // Feed already exists, not an error
	}
	if folderID != nil {
		folder, err := s.folders.GetByID(ctx, *folderID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return model.Feed{}, false, ErrNotFound
			}
			return model.Feed{}, false, fmt.Errorf("check folder: %w", err)
		}
		if folder.Type != feedType {
			logger.Warn("feed type mismatch with folder type", "module", "service", "action", "create", "resource", "feed", "result", "failed", "folder_id", *folderID, "folder_type", folder.Type, "feed_type", feedType)
			return model.Feed{}, false, ErrInvalid
		}
	}

	finalTitle := strings.TrimSpace(titleOverride)
	if finalTitle == "" {
		finalTitle = trimmedURL
	}

	feed := model.Feed{
		FolderID: folderID,
		Title:    finalTitle,
		URL:      trimmedURL,
		Type:     feedType,
	}

	created, err := s.feeds.Create(ctx, feed)
	if err != nil {
		logger.Error("feed create without fetch failed", "module", "service", "action", "create", "resource", "feed", "result", "failed", "host", network.ExtractHost(trimmedURL), "error", err)
		return model.Feed{}, false, err
	}

	logger.Info("feed created without fetch", "module", "service", "action", "create", "resource", "feed", "result", "ok", "feed_id", created.ID, "feed_title", created.Title, "host", network.ExtractHost(created.URL))
	return created, true, nil
}

func (s *feedService) Preview(ctx context.Context, feedURL string) (FeedPreview, error) {
	trimmedURL := strings.TrimSpace(feedURL)
	if !isValidURL(trimmedURL) {
		return FeedPreview{}, ErrInvalid
	}

	fetched, err := s.fetchFeed(ctx, trimmedURL)
	if err != nil {
		logger.Warn("feed preview failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(trimmedURL), "error", err)
		return FeedPreview{}, err
	}

	logger.Debug("feed preview fetched", "module", "service", "action", "fetch", "resource", "feed", "result", "ok", "host", network.ExtractHost(trimmedURL))

	title := strings.TrimSpace(fetched.title)
	if title == "" {
		title = trimmedURL
	}
	preview := FeedPreview{
		URL:         trimmedURL,
		Title:       title,
		Description: optionalString(fetched.description),
		SiteURL:     optionalString(fetched.siteURL),
		ImageURL:    optionalString(fetched.imageURL),
		ItemCount:   fetched.itemCount,
		LastUpdated: optionalString(fetched.lastUpdated),
		Entries:     buildPreviewEntries(fetched.items),
	}

	return preview, nil
}

// previewEntryLimit 试看条目数：够看清该视图长什么样即可，不追求完整。
const previewEntryLimit = 4

// buildPreviewEntries 把刚抓到的 feed 条目转成预览用条目（不写库）。
func buildPreviewEntries(items []*gofeed.Item) []model.Entry {
	if len(items) == 0 {
		return nil
	}

	dynamicTime := hasDynamicTime(items)
	limit := len(items)
	if limit > previewEntryLimit {
		limit = previewEntryLimit
	}

	entries := make([]model.Entry, 0, limit)
	for _, item := range items[:limit] {
		entries = append(entries, itemToEntry(0, item, dynamicTime))
	}
	return entries
}

func (s *feedService) List(ctx context.Context, folderID *int64) ([]model.Feed, error) {
	feeds, err := s.feeds.List(ctx, folderID)
	if err != nil {
		logger.Error("feed list failed", "module", "service", "action", "list", "resource", "feed", "result", "failed", "folder_id", folderID, "error", err)
		return nil, err
	}
	return feeds, nil
}

func (s *feedService) Update(ctx context.Context, id int64, title string, folderID *int64, summaryPromptReminder *string) (model.Feed, error) {
	trimmedTitle := strings.TrimSpace(title)
	if trimmedTitle == "" {
		return model.Feed{}, ErrInvalid
	}

	var normalizedReminder *string
	var err error
	if summaryPromptReminder != nil {
		normalizedReminder, err = normalizeSummaryPromptReminder(*summaryPromptReminder)
		if err != nil {
			return model.Feed{}, err
		}
	}

	feed, err := s.feeds.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Feed{}, ErrNotFound
		}
		return model.Feed{}, fmt.Errorf("get feed: %w", err)
	}

	// Check if folder is actually changing (value comparison, not pointer comparison)
	folderChanged := false
	if folderID == nil && feed.FolderID != nil {
		folderChanged = true // moving from folder to no folder
	} else if folderID != nil && feed.FolderID == nil {
		folderChanged = true // moving from no folder to folder
	} else if folderID != nil && feed.FolderID != nil && *folderID != *feed.FolderID {
		folderChanged = true // moving from one folder to another
	}

	if folderID != nil && folderChanged {
		folder, err := s.folders.GetByID(ctx, *folderID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return model.Feed{}, ErrNotFound
			}
			return model.Feed{}, fmt.Errorf("check folder: %w", err)
		}
		if folder.Type != feed.Type {
			logger.Warn("feed type mismatch with folder type", "module", "service", "action", "update", "resource", "feed", "result", "failed", "feed_id", id, "folder_id", *folderID, "folder_type", folder.Type, "feed_type", feed.Type)
			return model.Feed{}, ErrInvalid
		}
	}
	feed.Title = trimmedTitle
	feed.FolderID = folderID
	if summaryPromptReminder != nil {
		feed.SummaryPromptReminder = normalizedReminder
	}

	updated, err := s.feeds.Update(ctx, feed)
	if err != nil {
		logger.Error("feed update failed", "module", "service", "action", "update", "resource", "feed", "result", "failed", "feed_id", id, "error", err)
		return model.Feed{}, err
	}
	logger.Info("feed updated", "module", "service", "action", "update", "resource", "feed", "result", "ok", "feed_id", updated.ID, "feed_title", updated.Title)
	return updated, nil
}

// UpdateProxyOverride 写订阅级代理覆盖（迁移 26）。
// mode：nil = 跟随文件夹链 → 全局；proxy = 走代理；direct = 直连。
// config：nil = 用全局那套代理；有值 = 这一条单独指定（密码传掩码时沿用库里那份）。
func (s *feedService) UpdateProxyOverride(ctx context.Context, id int64, update ProxyOverrideUpdate) (model.Feed, error) {
	feed, err := s.feeds.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Feed{}, ErrNotFound
		}
		return model.Feed{}, fmt.Errorf("get feed: %w", err)
	}

	update = normalizeProxyOverrideUpdate(update, feed.ProxyConfig)
	mode, cfg := update.Apply(feed.ProxyMode, feed.ProxyConfig)
	if err := s.feeds.UpdateProxyOverride(ctx, id, mode, cfg); err != nil {
		logger.Error("feed proxy override update failed", "module", "service", "action", "update", "resource", "proxy", "result", "failed", "feed_id", id, "error", err)
		return model.Feed{}, err
	}

	feed.ProxyMode = mode
	feed.ProxyConfig = cfg
	// 只记「档位 + 有没有单独指定」：地址与密码一律不进日志
	logger.Info("feed proxy override updated", "module", "service", "action", "update", "resource", "proxy", "result", "ok", "feed_id", id, "mode", ProxyModeToString(mode), "custom_config", cfg.Usable())
	return feed, nil
}

// UpdateMCPConfig 改 MCP 订阅的取数配置（16-14 编辑模式）。
// 只允许 source_type='mcp' 的源（RSS 源调这个接口直接 400）；连接不存在也 400。
// 标题/文件夹语义与 Update 一致；mcp_config 整体替换（BuildMCPFeedConfig 同一套钳制）。
func (s *feedService) UpdateMCPConfig(ctx context.Context, id int64, input MCPFeedAddInput) (model.Feed, error) {
	feed, err := s.feeds.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Feed{}, ErrNotFound
		}
		return model.Feed{}, fmt.Errorf("get feed: %w", err)
	}
	if !feed.IsMCP() {
		return model.Feed{}, fmt.Errorf("%w: 只有 MCP 订阅能改取数配置", ErrInvalid)
	}
	if s.mcp == nil {
		return model.Feed{}, fmt.Errorf("%w: MCP 服务未初始化", ErrInvalid)
	}
	if _, err := s.mcp.GetServer(ctx, input.ServerID); err != nil {
		return model.Feed{}, fmt.Errorf("%w: MCP 连接不存在", ErrInvalid)
	}
	config := model.MCPFeedConfig{
		ServerID:    model.SnowflakeID(input.ServerID),
		Kind:        input.Kind,
		ToolName:    input.ToolName,
		ResourceURI: input.ResourceURI,
		Arguments:   input.Arguments,
		Limit:       input.Limit,
		Mapping:     input.Mapping,
		Pagination:  input.Pagination,
		Tier:        input.Tier,
		KeyLevel:    input.KeyLevel,
	}
	rawConfig, err := BuildMCPFeedConfig(config)
	if err != nil {
		return model.Feed{}, err
	}

	trimmedTitle := strings.TrimSpace(input.Title)
	if trimmedTitle == "" {
		return model.Feed{}, ErrInvalid
	}
	if input.FolderID != nil {
		folder, err := s.folders.GetByID(ctx, *input.FolderID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return model.Feed{}, ErrNotFound
			}
			return model.Feed{}, fmt.Errorf("check folder: %w", err)
		}
		if folder.Type != feed.Type {
			return model.Feed{}, ErrInvalid
		}
	}

	feed.Title = trimmedTitle
	feed.FolderID = input.FolderID
	feed.MCPConfig = &rawConfig
	updated, err := s.feeds.Update(ctx, feed)
	if err != nil {
		logger.Error("mcp feed config update failed", "module", "service", "action", "update", "resource", "feed", "result", "failed", "feed_id", id, "error", err)
		return model.Feed{}, err
	}
	logger.Info("mcp feed config updated", "module", "service", "action", "update", "resource", "feed", "result", "ok",
		"feed_id", updated.ID, "mcp_server_id", config.ServerID.Int64(), "kind", config.Kind)
	return updated, nil
}

// UpdateAIOverrides 覆盖单个订阅的自动翻译/自动摘要/正文打开方式；
// 传 nil 表示恢复「跟随全局」。readerMode: true=阅读模式，false=原文。
func (s *feedService) UpdateAIOverrides(ctx context.Context, id int64, autoTranslate, autoSummary, readerMode *bool) (model.Feed, error) {
	feed, err := s.feeds.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Feed{}, ErrNotFound
		}
		return model.Feed{}, fmt.Errorf("get feed: %w", err)
	}

	feed.AutoTranslate = autoTranslate
	feed.AutoSummary = autoSummary
	feed.ReaderMode = readerMode

	updated, err := s.feeds.Update(ctx, feed)
	if err != nil {
		logger.Error("feed ai overrides update failed", "module", "service", "action", "update", "resource", "feed", "result", "failed", "feed_id", id, "error", err)
		return model.Feed{}, err
	}
	logger.Info("feed ai overrides updated", "module", "service", "action", "update", "resource", "feed", "result", "ok", "feed_id", updated.ID)
	return updated, nil
}

// UpdateURL 改订阅地址：只换地址，不动标题/文件夹；下次刷新即走新地址。
func (s *feedService) UpdateURL(ctx context.Context, id int64, feedURL string) (model.Feed, error) {
	trimmed := strings.TrimSpace(feedURL)
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return model.Feed{}, ErrInvalid
	}

	feed, err := s.feeds.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Feed{}, ErrNotFound
		}
		return model.Feed{}, fmt.Errorf("get feed: %w", err)
	}
	if feed.URL == trimmed {
		return feed, nil
	}

	// RSSHub 换实例后可能和另一个订阅撞成同一个地址：这时不能默默写下去（会变成两个同源订阅），
	// 交给上层弹「确认合并」（用户 2026-09-17 要求）。
	existing, err := s.feeds.FindByURL(ctx, trimmed)
	if err != nil {
		return model.Feed{}, fmt.Errorf("find feed by url: %w", err)
	}
	if existing != nil && existing.ID != id {
		return model.Feed{}, &FeedURLConflictError{Feed: *existing}
	}

	feed.URL = trimmed
	updated, err := s.feeds.Update(ctx, feed)
	if err != nil {
		logger.Error("feed url update failed", "module", "service", "action", "update", "resource", "feed", "result", "failed", "feed_id", id, "error", err)
		return model.Feed{}, err
	}
	logger.Info("feed url updated", "module", "service", "action", "update", "resource", "feed", "result", "ok", "feed_id", updated.ID)
	return updated, nil
}

func normalizeSummaryPromptReminder(raw string) (*string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(trimmed) > maxFeedSummaryPromptReminderLength {
		return nil, ErrInvalid
	}
	return &trimmed, nil
}

func (s *feedService) Delete(ctx context.Context, id int64) error {
	if _, err := s.feeds.GetByID(ctx, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("get feed: %w", err)
	}
	if err := s.feeds.Delete(ctx, id); err != nil {
		logger.Error("feed delete failed", "module", "service", "action", "delete", "resource", "feed", "result", "failed", "feed_id", id, "error", err)
		return err
	}
	logger.Info("feed deleted", "module", "service", "action", "delete", "resource", "feed", "result", "ok", "feed_id", id)
	return nil
}

func (s *feedService) UpdateType(ctx context.Context, id int64, feedType string) error {
	if _, err := s.feeds.GetByID(ctx, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("get feed: %w", err)
	}
	if err := s.feeds.UpdateType(ctx, id, feedType); err != nil {
		logger.Error("feed update type failed", "module", "service", "action", "update", "resource", "feed", "result", "failed", "feed_id", id, "type", feedType, "error", err)
		return err
	}
	logger.Info("feed type updated", "module", "service", "action", "update", "resource", "feed", "result", "ok", "feed_id", id, "type", feedType)
	return nil
}

func (s *feedService) DeleteBatch(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	// Delete and check affected rows to detect missing IDs
	affected, err := s.feeds.DeleteBatch(ctx, ids)
	if err != nil {
		logger.Error("feed batch delete failed", "module", "service", "action", "delete", "resource", "feed", "result", "failed", "count", len(ids), "error", err)
		return err
	}
	if affected != int64(len(ids)) {
		logger.Warn("feed batch delete missing", "module", "service", "action", "delete", "resource", "feed", "result", "failed", "count", len(ids), "affected", affected)
		return ErrNotFound
	}
	logger.Info("feed batch deleted", "module", "service", "action", "delete", "resource", "feed", "result", "ok", "count", len(ids))
	return nil
}

type feedFetch struct {
	title        string
	description  string
	siteURL      string
	imageURL     string
	lastUpdated  string
	itemCount    *int
	etag         string
	lastModified string
	items        []*gofeed.Item
}

func (s *feedService) fetchFeed(ctx context.Context, feedURL string) (feedFetch, error) {
	return s.fetchFeedWithUA(ctx, feedURL, config.DefaultUserAgent, true)
}

func (s *feedService) fetchFeedWithUA(ctx context.Context, feedURL string, userAgent string, allowFallback bool) (feedFetch, error) {
	return s.fetchFeedWithCookie(ctx, feedURL, userAgent, "", allowFallback, 0)
}

func (s *feedService) fetchFeedWithCookie(ctx context.Context, feedURL string, userAgent string, cookie string, allowFallback bool, retryCount int) (feedFetch, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, feedURL, nil)
	if err != nil {
		return feedFetch{}, ErrFeedFetch
	}
	req.Header.Set("User-Agent", userAgent)

	// Add cached Anubis cookie if available
	if cookie == "" {
		host := network.ExtractHost(feedURL)
		if cachedCookie := getCachedAnubisCookie(ctx, s.anubis, host, req.Header); cachedCookie != "" {
			cookie = cachedCookie
		}
	}

	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	httpClient := s.clientFactory.NewHTTPClient(ctx, feedTimeout)
	resp, err := httpClient.Do(req)
	if err != nil {
		logger.Warn("feed preview fetch failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "error", err)
		return feedFetch{}, ErrFeedFetch
	}
	defer resp.Body.Close()

	// On HTTP error, try fallback UA if available
	if resp.StatusCode >= http.StatusBadRequest && allowFallback && s.settings != nil {
		fallbackUA := s.settings.GetFallbackUserAgent(ctx)
		if fallbackUA != "" {
			logger.Warn("feed preview retry with fallback ua", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "status_code", resp.StatusCode)
			return s.fetchFeedWithCookie(ctx, feedURL, fallbackUA, cookie, false, retryCount)
		}
	}

	if resp.StatusCode >= http.StatusBadRequest {
		logger.Error("feed preview http error", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "status_code", resp.StatusCode)
		return feedFetch{}, ErrFeedFetch
	}

	// Read body into memory for Anubis detection and RSS parsing
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logger.Warn("feed preview read failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "error", err)
		return feedFetch{}, ErrFeedFetch
	}

	// Try to parse as RSS/Atom
	parser := gofeed.NewParser()
	parsed, parseErr := parser.Parse(bytes.NewReader(body))
	if parseErr != nil {
		newCookie, anubisErr := trySolveAnubisChallenge(ctx, s.anubis, body, feedURL, resp.Cookies(), req.Header.Clone(), retryCount)
		switch {
		case anubisErr == nil:
			// Retry with fresh client and same request fingerprint.
			return s.fetchFeedWithFreshClient(ctx, feedURL, userAgent, newCookie, retryCount+1)
		case errors.Is(anubisErr, errAnubisNotPage):
			// Not an Anubis page; keep original parse error handling.
		case errors.Is(anubisErr, errAnubisRejected):
			logger.Warn("feed preview upstream rejected", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL))
			return feedFetch{}, fmt.Errorf("upstream rejected")
		case errors.Is(anubisErr, errAnubisRetryExceeded):
			logger.Warn("feed preview anubis persists", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "retry_count", retryCount)
			return feedFetch{}, fmt.Errorf("anubis challenge persists after %d retries", retryCount)
		default:
			logger.Warn("feed preview anubis solve failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "error", anubisErr)
			return feedFetch{}, ErrFeedFetch
		}
		logger.Error("feed preview parse failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "error", parseErr)
		return feedFetch{}, ErrFeedFetch

	}

	title := strings.TrimSpace(parsed.Title)
	description := strings.TrimSpace(parsed.Description)
	siteURL := strings.TrimSpace(parsed.Link)
	imageURL := ""
	if parsed.Image != nil {
		imageURL = strings.TrimSpace(parsed.Image.URL)
	}
	lastUpdated := ""
	if parsed.UpdatedParsed != nil {
		lastUpdated = parsed.UpdatedParsed.UTC().Format(time.RFC3339)
	} else if parsed.PublishedParsed != nil {
		lastUpdated = parsed.PublishedParsed.UTC().Format(time.RFC3339)
	}
	var itemCount *int
	if parsed.Items != nil {
		count := len(parsed.Items)
		itemCount = &count
	}

	etag := strings.TrimSpace(resp.Header.Get("ETag"))
	lastModified := strings.TrimSpace(resp.Header.Get("Last-Modified"))

	return feedFetch{
		title:        title,
		description:  description,
		siteURL:      siteURL,
		imageURL:     imageURL,
		lastUpdated:  lastUpdated,
		itemCount:    itemCount,
		etag:         etag,
		lastModified: lastModified,
		items:        parsed.Items,
	}, nil
}

// fetchFeedWithFreshClient creates a new http.Client to avoid connection reuse after Anubis
func (s *feedService) fetchFeedWithFreshClient(ctx context.Context, feedURL string, userAgent string, cookie string, retryCount int) (feedFetch, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, feedURL, nil)
	if err != nil {
		return feedFetch{}, ErrFeedFetch
	}
	req.Header.Set("User-Agent", userAgent)
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	// Use fresh client to avoid connection reuse
	freshClient := s.clientFactory.NewHTTPClient(ctx, feedTimeout)
	resp, err := freshClient.Do(req)
	if err != nil {
		logger.Warn("feed preview fetch failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "error", err)
		return feedFetch{}, ErrFeedFetch
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusBadRequest {
		logger.Error("feed preview http error", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "status_code", resp.StatusCode)
		return feedFetch{}, ErrFeedFetch
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logger.Warn("feed preview read failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "error", err)
		return feedFetch{}, ErrFeedFetch
	}

	newCookie, anubisErr := trySolveAnubisChallenge(ctx, s.anubis, body, feedURL, resp.Cookies(), req.Header.Clone(), retryCount)
	switch {
	case anubisErr == nil:
		return s.fetchFeedWithFreshClient(ctx, feedURL, userAgent, newCookie, retryCount+1)
	case errors.Is(anubisErr, errAnubisNotPage):
		// Not an Anubis page; continue normal parsing.
	case errors.Is(anubisErr, errAnubisRejected):
		logger.Warn("feed preview upstream rejected", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL))
		return feedFetch{}, fmt.Errorf("upstream rejected")
	case errors.Is(anubisErr, errAnubisRetryExceeded):
		logger.Warn("feed preview anubis persists", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "retry_count", retryCount)
		return feedFetch{}, fmt.Errorf("anubis challenge persists after %d retries", retryCount)
	default:
		logger.Warn("feed preview anubis solve failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "error", anubisErr)
		return feedFetch{}, ErrFeedFetch
	}

	parser := gofeed.NewParser()
	parsed, parseErr := parser.Parse(bytes.NewReader(body))
	if parseErr != nil {
		logger.Error("feed preview parse failed", "module", "service", "action", "fetch", "resource", "feed", "result", "failed", "host", network.ExtractHost(feedURL), "error", parseErr)
		return feedFetch{}, ErrFeedFetch
	}

	title := strings.TrimSpace(parsed.Title)
	description := strings.TrimSpace(parsed.Description)
	siteURL := strings.TrimSpace(parsed.Link)
	imageURL := ""
	if parsed.Image != nil {
		imageURL = strings.TrimSpace(parsed.Image.URL)
	}
	lastUpdated := ""
	if parsed.UpdatedParsed != nil {
		lastUpdated = parsed.UpdatedParsed.UTC().Format(time.RFC3339)
	} else if parsed.PublishedParsed != nil {
		lastUpdated = parsed.PublishedParsed.UTC().Format(time.RFC3339)
	}
	var itemCount *int
	if parsed.Items != nil {
		count := len(parsed.Items)
		itemCount = &count
	}

	etag := strings.TrimSpace(resp.Header.Get("ETag"))
	lastModified := strings.TrimSpace(resp.Header.Get("Last-Modified"))

	return feedFetch{
		title:        title,
		description:  description,
		siteURL:      siteURL,
		imageURL:     imageURL,
		lastUpdated:  lastUpdated,
		itemCount:    itemCount,
		etag:         etag,
		lastModified: lastModified,
		items:        parsed.Items,
	}, nil
}

// hasDynamicTime checks if all items have the same updated time (dynamic generation)
func hasDynamicTime(items []*gofeed.Item) bool {
	if len(items) < 2 {
		return false
	}
	var firstTime *time.Time
	for _, item := range items {
		if item.UpdatedParsed != nil {
			if firstTime == nil {
				firstTime = item.UpdatedParsed
			} else if !firstTime.Equal(*item.UpdatedParsed) {
				return false
			}
		}
	}
	return firstTime != nil
}

func itemToEntry(feedID int64, item *gofeed.Item, ignoreDynamicTime bool) model.Entry {
	entry := model.Entry{
		FeedID: feedID,
	}

	var title string
	if item.Title != "" {
		title = strings.TrimSpace(item.Title)
		entry.Title = &title
	}

	var link string
	if item.Link != "" {
		link = strings.TrimSpace(item.Link)
		entry.URL = &link
	}

	content := item.Content
	if content == "" {
		content = item.Description
	}
	content = strings.TrimSpace(content)
	if content != "" {
		entry.Content = &content
	}

	// Extract thumbnail from media tags
	entry.ThumbnailURL = extractThumbnail(item)

	if item.Author != nil && item.Author.Name != "" {
		author := sanitizer.SanitizeAuthor(item.Author.Name)
		if author != "" {
			entry.Author = &author
		}
	}

	entry.PublishedAt = extractPublishedAt(item, ignoreDynamicTime)
	entry.Hash = computeEntryHash(item, title, content)

	return entry
}

func computeEntryHash(item *gofeed.Item, title string, content string) string {
	if guid := strings.TrimSpace(item.GUID); guid != "" {
		return hashToHex(guid)
	}
	if link := strings.TrimSpace(item.Link); link != "" {
		return hashToHex(link)
	}
	return hashToHex(strings.TrimSpace(title) + strings.TrimSpace(content))
}

func hashToHex(input string) string {
	return hashutil.SHA256Hex(input)
}

func extractPublishedAt(item *gofeed.Item, ignoreDynamicTime bool) *time.Time {
	// 1. Try to extract from summary (SEC RSS: "Filed: 2025-12-17")
	if t := extractDateFromSummary(item.Description); t != nil {
		return t
	}

	// 2. Try standard fields
	if item.PublishedParsed != nil {
		t := item.PublishedParsed.UTC()
		return &t
	}
	if !ignoreDynamicTime && item.UpdatedParsed != nil {
		t := item.UpdatedParsed.UTC()
		return &t
	}

	// Fallback to current time when no date is available
	now := time.Now().UTC()
	return &now
}

var filedDateRegex = regexp.MustCompile(`Filed:.*?(\d{4}-\d{2}-\d{2})`)

func extractDateFromSummary(summary string) *time.Time {
	if summary == "" {
		return nil
	}
	matches := filedDateRegex.FindStringSubmatch(summary)
	if len(matches) >= 2 {
		if t, err := time.Parse("2006-01-02", matches[1]); err == nil {
			utc := t.UTC()
			return &utc
		}
	}
	return nil
}

func extractThumbnail(item *gofeed.Item) *string {
	// 1. Check item.Image
	if item.Image != nil && item.Image.URL != "" {
		url := strings.TrimSpace(item.Image.URL)
		return &url
	}

	// 2. Check enclosures for image type
	for _, enc := range item.Enclosures {
		if strings.HasPrefix(enc.Type, "image/") {
			url := strings.TrimSpace(enc.URL)
			if url != "" {
				return &url
			}
		}
	}

	// 3. Check media:content and media:thumbnail
	if media, ok := item.Extensions["media"]; ok {
		// Check media:content
		if content, ok := media["content"]; ok {
			for _, c := range content {
				url := strings.TrimSpace(c.Attrs["url"])
				if url == "" {
					continue
				}
				// Check type attribute
				if typ := c.Attrs["type"]; strings.HasPrefix(typ, "image/") {
					return &url
				}
				// Check medium attribute
				if medium := c.Attrs["medium"]; medium == "image" {
					return &url
				}
			}
		}
		// Check media:thumbnail
		if thumb, ok := media["thumbnail"]; ok {
			for _, t := range thumb {
				url := strings.TrimSpace(t.Attrs["url"])
				if url != "" {
					return &url
				}
			}
		}
	}

	return nil
}

func optionalString(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func isValidURL(value string) bool {
	parsed, err := url.ParseRequestURI(value)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	return parsed.Host != ""
}

// FeedURLConflictError：改订阅地址时撞上另一个订阅（RSSHub 换链路后两个订阅指向同一地址）。
type FeedURLConflictError struct {
	Feed model.Feed
}

func (e *FeedURLConflictError) Error() string {
	return "feed url already used by another subscription"
}

// FeedMergeSide：弹框里一侧的情况
type FeedMergeSide struct {
	ID      int64  `json:"id"`
	Title   string `json:"title"`
	Entries int64  `json:"entries"`
	Starred int64  `json:"starred"`
}

// FeedMergePreview：合并前给用户看的两侧对比
type FeedMergePreview struct {
	Source FeedMergeSide  `json:"source"`
	Target *FeedMergeSide `json:"target"`
}

// FeedMergeResult：合并结果
type FeedMergeResult struct {
	TargetID       int64 `json:"targetId"`
	MovedEntries   int64 `json:"movedEntries"`
	DedupedEntries int64 `json:"dedupedEntries"`
}

// MergePreview 预览合并：目标地址属于哪个订阅、两边各有几条。
func (s *feedService) MergePreview(ctx context.Context, sourceID int64, targetURL string) (FeedMergePreview, error) {
	source, err := s.feeds.GetByID(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return FeedMergePreview{}, ErrNotFound
		}
		return FeedMergePreview{}, fmt.Errorf("get source feed: %w", err)
	}

	sourceEntries, sourceStarred, err := s.entries.FeedEntryStats(ctx, sourceID)
	if err != nil {
		return FeedMergePreview{}, err
	}
	preview := FeedMergePreview{
		Source: FeedMergeSide{
			ID:      source.ID,
			Title:   source.Title,
			Entries: sourceEntries,
			Starred: sourceStarred,
		},
	}

	trimmed := strings.TrimSpace(targetURL)
	if trimmed == "" {
		return preview, nil
	}
	target, err := s.feeds.FindByURL(ctx, trimmed)
	if err != nil {
		return FeedMergePreview{}, fmt.Errorf("find target feed: %w", err)
	}
	if target == nil || target.ID == sourceID {
		return preview, nil
	}

	targetEntries, targetStarred, err := s.entries.FeedEntryStats(ctx, target.ID)
	if err != nil {
		return FeedMergePreview{}, err
	}
	preview.Target = &FeedMergeSide{
		ID:      target.ID,
		Title:   target.Title,
		Entries: targetEntries,
		Starred: targetStarred,
	}
	return preview, nil
}

// MergeInto 把 source 并入 target：**保留目标那条订阅**（用户 2026-09-17 拍板），
// 来源的条目/星标/未读状态随条目一起过去；来源有分类而目标没有时，把分类补上；最后删掉来源。
func (s *feedService) MergeInto(ctx context.Context, sourceID, targetID int64) (FeedMergeResult, error) {
	if sourceID == targetID {
		return FeedMergeResult{}, ErrInvalid
	}
	source, err := s.feeds.GetByID(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return FeedMergeResult{}, ErrNotFound
		}
		return FeedMergeResult{}, fmt.Errorf("get source feed: %w", err)
	}
	target, err := s.feeds.GetByID(ctx, targetID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return FeedMergeResult{}, ErrNotFound
		}
		return FeedMergeResult{}, fmt.Errorf("get target feed: %w", err)
	}

	moved, deduped, err := s.entries.MoveFeedEntries(ctx, source.ID, target.ID)
	if err != nil {
		return FeedMergeResult{}, err
	}

	// 来源有分类、目标没有 → 把分类补过去（目标已有分类就不动，以保留的那条为准）
	if target.FolderID == nil && source.FolderID != nil {
		target.FolderID = source.FolderID
		if _, err := s.feeds.Update(ctx, target); err != nil {
			return FeedMergeResult{}, fmt.Errorf("carry over folder: %w", err)
		}
	}

	if err := s.feeds.Delete(ctx, source.ID); err != nil {
		return FeedMergeResult{}, fmt.Errorf("delete merged feed: %w", err)
	}

	logger.Info("feed merged", "module=service", "action=merge", "resource=feed", "result=ok",
		"source_feed_id", source.ID, "target_feed_id", target.ID,
		"moved_entries", moved, "deduped_entries", deduped)
	return FeedMergeResult{TargetID: target.ID, MovedEntries: moved, DedupedEntries: deduped}, nil
}
