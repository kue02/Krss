//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/pkg/logger"
)

// 全量备份的格式标识与版本。与「应用设置导出」（SettingsExport）区分：
// 那份只装 UI/应用设置，本文件是整库的订阅 + 配置快照。
const (
	backupFormat  = "krss-backup"
	backupVersion = 1
)

// 备份分区标识：前端多选下拉的取值，也是文件里 sections 字段的值。
const (
	BackupSectionSubscriptions = "subscriptions" // 文件夹层级 + 订阅
	BackupSectionSettings      = "settings"      // 非敏感应用设置
	BackupSectionCredentials   = "credentials"   // 敏感凭证（AI Key / 代理密码 / 插件密钥 / MCP 凭证）
	BackupSectionPlugins       = "plugins"       // 插件启停状态
	BackupSectionMCP           = "mcp"           // MCP 连接
)

// BackupExportOptions 决定导出哪些分区。Credentials 只影响设置里的敏感键与 MCP 凭证。
type BackupExportOptions struct {
	Subscriptions bool `json:"subscriptions"`
	Settings      bool `json:"settings"`
	Credentials   bool `json:"credentials"`
	Plugins       bool `json:"plugins"`
	MCP           bool `json:"mcp"`
}

// DefaultBackupExportOptions 默认导出全部分区，但**不含**敏感凭证。
func DefaultBackupExportOptions() BackupExportOptions {
	return BackupExportOptions{Subscriptions: true, Settings: true, Plugins: true, MCP: true}
}

// BackupService 整库备份：导出为一份 JSON，能把文件夹层级 + 订阅 + 关键配置重建回来。
type BackupService interface {
	Export(ctx context.Context) ([]byte, error)
	ExportWithOptions(ctx context.Context, opts BackupExportOptions) ([]byte, error)
	Import(ctx context.Context, reader io.Reader) (BackupImportResult, error)
}

// BackupDocument 是备份文件的根结构。
//
// 说明：IDs 以数字序列化，文件名交给前端时前端**不解析**（直接按字节下载/上传），
// 因此不会踩 JS 大整数精度问题。若第三方工具要读，请按字符串处理超过 2^53 的 ID。
type BackupDocument struct {
	Format     string            `json:"format"`
	Version    int               `json:"version"`
	ExportedAt time.Time         `json:"exportedAt"`
	Folders    []BackupFolder    `json:"folders"`
	Feeds      []BackupFeed      `json:"feeds"`
	Settings   map[string]string `json:"settings"`
	Plugins    []BackupPlugin    `json:"plugins"`
	MCPServers []BackupMCPServer `json:"mcpServers"`
	// Sections 记录本文件实际包含的分区，导入端据此预览与恢复。
	Sections []string `json:"sections"`
	// Excluded 记录本备份**没有**包含的内容与原因，导入时据此提醒用户。
	Excluded BackupExclusions `json:"excluded"`
}

type BackupFolder struct {
	ID          int64                      `json:"id"`
	Name        string                     `json:"name"`
	ParentID    *int64                     `json:"parentId,omitempty"`
	Type        string                     `json:"type"`
	ProxyMode   *model.ProxyMode           `json:"proxyMode,omitempty"`
	ProxyConfig *model.ProxyOverrideConfig `json:"proxyConfig,omitempty"`
}

type BackupFeed struct {
	ID                    int64                      `json:"id"`
	FolderID              *int64                     `json:"folderId,omitempty"`
	Title                 string                     `json:"title"`
	URL                   string                     `json:"url"`
	SiteURL               *string                    `json:"siteUrl,omitempty"`
	Description           *string                    `json:"description,omitempty"`
	SummaryPromptReminder *string                    `json:"summaryPromptReminder,omitempty"`
	Type                  string                     `json:"type"`
	SourceType            string                     `json:"sourceType"`
	MCPConfig             *string                    `json:"mcpConfig,omitempty"`
	AutoTranslate         *bool                      `json:"autoTranslate,omitempty"`
	AutoSummary           *bool                      `json:"autoSummary,omitempty"`
	ReaderMode            *bool                      `json:"readerMode,omitempty"`
	ProxyMode             *model.ProxyMode           `json:"proxyMode,omitempty"`
	ProxyConfig           *model.ProxyOverrideConfig `json:"proxyConfig,omitempty"`
}

type BackupPlugin struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
}

// BackupMCPServer 只带非敏感的连接配置；Headers / OAuth token 等凭证一律不导出，
// 导入后连接默认禁用，需要用户重新填 Key / 重新授权。
type BackupMCPServer struct {
	Name                   string   `json:"name"`
	Transport              string   `json:"transport"`
	URL                    string   `json:"url"`
	AuthType               string   `json:"authType"`
	Purposes               []string `json:"purposes,omitempty"`
	UseGlobalFetch         bool     `json:"useGlobalFetch"`
	FetchTimeoutSeconds    *int     `json:"fetchTimeoutSeconds,omitempty"`
	FetchConcurrency       *int     `json:"fetchConcurrency,omitempty"`
	RefreshIntervalMinutes *int     `json:"refreshIntervalMinutes,omitempty"`
	// 以下凭证仅在「敏感凭证」勾选时出现；否则为空。
	Headers           map[string]string `json:"headers,omitempty"`
	OAuthClientID     string            `json:"oauthClientId,omitempty"`
	OAuthClientSecret string            `json:"oauthClientSecret,omitempty"`
	OAuthAccessToken  string            `json:"oauthAccessToken,omitempty"`
	OAuthRefreshToken string            `json:"oauthRefreshToken,omitempty"`
	OAuthTokenType    string            `json:"oauthTokenType,omitempty"`
	OAuthScope        string            `json:"oauthScope,omitempty"`
	OAuthAuthServer   string            `json:"oauthAuthServer,omitempty"`
	OAuthExpiresAt    *time.Time        `json:"oauthExpiresAt,omitempty"`
}

type BackupExclusions struct {
	// Settings 是被安全策略排除的设置键（含通配前缀）。
	Settings []string `json:"settings,omitempty"`
	// Tables 是未纳入备份的数据库表。
	Tables []string `json:"tables,omitempty"`
	Note   string   `json:"note,omitempty"`
}

type BackupImportResult struct {
	FoldersCreated    int `json:"foldersCreated"`
	FoldersSkipped    int `json:"foldersSkipped"`
	FeedsCreated      int `json:"feedsCreated"`
	FeedsSkipped      int `json:"feedsSkipped"`
	SettingsApplied   int `json:"settingsApplied"`
	PluginsApplied    int `json:"pluginsApplied"`
	MCPServersCreated int `json:"mcpServersCreated"`
	MCPServersSkipped int `json:"mcpServersSkipped"`
}

type backupService struct {
	folders    repository.FolderRepository
	feeds      repository.FeedRepository
	settings   repository.SettingsRepository
	plugins    repository.PluginRepository
	mcpServers repository.MCPServerRepository
}

func NewBackupService(
	folders repository.FolderRepository,
	feeds repository.FeedRepository,
	settings repository.SettingsRepository,
	plugins repository.PluginRepository,
	mcpServers repository.MCPServerRepository,
) BackupService {
	return &backupService{
		folders:    folders,
		feeds:      feeds,
		settings:   settings,
		plugins:    plugins,
		mcpServers: mcpServers,
	}
}

// Export 导出默认备份（全部分区，但不含敏感凭证）。
func (s *backupService) Export(ctx context.Context) ([]byte, error) {
	return s.ExportWithOptions(ctx, DefaultBackupExportOptions())
}

// ExportWithOptions 按勾选的分区导出。Credentials 决定是否带上敏感设置与 MCP 凭证。
func (s *backupService) ExportWithOptions(ctx context.Context, opts BackupExportOptions) ([]byte, error) {
	doc := BackupDocument{
		Format:     backupFormat,
		Version:    backupVersion,
		ExportedAt: time.Now().UTC(),
		Folders:    []BackupFolder{},
		Feeds:      []BackupFeed{},
		Settings:   map[string]string{},
		Plugins:    []BackupPlugin{},
		MCPServers: []BackupMCPServer{},
		Sections:   []string{},
		Excluded: BackupExclusions{
			Tables: []string{"entries", "entry_ai_judgements", "ai_summaries", "ai_translations", "ai_list_translations", "ai_summary_status", "ai_translation_status", "filter_matches", "filters", "plugin_data", "domain_rate_limits"},
			Note:   "不含文章正文与 AI 缓存（可重新抓取生成）；不含筛选规则（引用会被重建的订阅/文件夹 ID）；不含插件 KV 数据（无全量枚举接口，可由插件重建）。登录密码哈希与 JWT 密钥始终不导出。",
		},
	}

	if opts.Subscriptions {
		folders, err := s.folders.List(ctx)
		if err != nil {
			return nil, fmt.Errorf("list folders: %w", err)
		}
		for _, f := range folders {
			doc.Folders = append(doc.Folders, BackupFolder{
				ID:          f.ID,
				Name:        f.Name,
				ParentID:    f.ParentID,
				Type:        f.Type,
				ProxyMode:   f.ProxyMode,
				ProxyConfig: sanitizeProxyConfig(f.ProxyConfig),
			})
		}
		feeds, err := s.feeds.List(ctx, nil)
		if err != nil {
			return nil, fmt.Errorf("list feeds: %w", err)
		}
		for _, f := range feeds {
			doc.Feeds = append(doc.Feeds, BackupFeed{
				ID:                    f.ID,
				FolderID:              f.FolderID,
				Title:                 f.Title,
				URL:                   f.URL,
				SiteURL:               f.SiteURL,
				Description:           f.Description,
				SummaryPromptReminder: f.SummaryPromptReminder,
				Type:                  f.Type,
				SourceType:            f.SourceType,
				MCPConfig:             f.MCPConfig,
				AutoTranslate:         f.AutoTranslate,
				AutoSummary:           f.AutoSummary,
				ReaderMode:            f.ReaderMode,
				ProxyMode:             f.ProxyMode,
				ProxyConfig:           sanitizeProxyConfig(f.ProxyConfig),
			})
		}
		doc.Sections = append(doc.Sections, BackupSectionSubscriptions)
	}

	if (opts.Settings || opts.Credentials) && s.settings != nil {
		all, err := s.settings.GetByPrefix(ctx, "")
		if err != nil {
			return nil, fmt.Errorf("list settings: %w", err)
		}
		for _, item := range all {
			switch {
			case isNeverExportSettingKey(item.Key):
				doc.Excluded.Settings = append(doc.Excluded.Settings, item.Key)
			case isSensitiveSettingKey(item.Key):
				if opts.Credentials {
					doc.Settings[item.Key] = item.Value
				} else {
					doc.Excluded.Settings = append(doc.Excluded.Settings, item.Key)
				}
			default:
				if opts.Settings {
					doc.Settings[item.Key] = item.Value
				}
			}
		}
		if opts.Settings {
			doc.Sections = append(doc.Sections, BackupSectionSettings)
		}
		if opts.Credentials {
			doc.Sections = append(doc.Sections, BackupSectionCredentials)
		}
	}

	if opts.Plugins && s.plugins != nil {
		states, err := s.plugins.List(ctx)
		if err != nil {
			return nil, fmt.Errorf("list plugins: %w", err)
		}
		for _, p := range states {
			doc.Plugins = append(doc.Plugins, BackupPlugin{ID: p.ID, Enabled: p.Enabled})
		}
		doc.Sections = append(doc.Sections, BackupSectionPlugins)
	}

	if opts.MCP && s.mcpServers != nil {
		servers, err := s.mcpServers.List(ctx)
		if err != nil {
			return nil, fmt.Errorf("list mcp servers: %w", err)
		}
		for _, srv := range servers {
			item := BackupMCPServer{
				Name:                   srv.Name,
				Transport:              srv.Transport,
				URL:                    srv.URL,
				AuthType:               srv.AuthType,
				Purposes:               srv.Purposes,
				UseGlobalFetch:         srv.UseGlobalFetch,
				FetchTimeoutSeconds:    srv.FetchTimeoutSeconds,
				FetchConcurrency:       srv.FetchConcurrency,
				RefreshIntervalMinutes: srv.RefreshIntervalMinutes,
			}
			if opts.Credentials {
				item.Headers = srv.Headers
				item.OAuthClientID = srv.OAuthClientID
				item.OAuthClientSecret = srv.OAuthClientSecret
				item.OAuthAccessToken = srv.OAuthAccessToken
				item.OAuthRefreshToken = srv.OAuthRefreshToken
				item.OAuthTokenType = srv.OAuthTokenType
				item.OAuthScope = srv.OAuthScope
				item.OAuthAuthServer = srv.OAuthAuthServer
				item.OAuthExpiresAt = srv.OAuthExpiresAt
			}
			doc.MCPServers = append(doc.MCPServers, item)
		}
		doc.Sections = append(doc.Sections, BackupSectionMCP)
	}

	payload, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal backup: %w", err)
	}
	logger.Info("backup export completed", "module", "service", "action", "export", "resource", "backup", "result", "ok", "sections", doc.Sections, "folders", len(doc.Folders), "feeds", len(doc.Feeds), "settings", len(doc.Settings), "plugins", len(doc.Plugins), "mcp_servers", len(doc.MCPServers))
	return payload, nil
}
func (s *backupService) Import(ctx context.Context, reader io.Reader) (BackupImportResult, error) {
	var result BackupImportResult
	data, err := io.ReadAll(reader)
	if err != nil {
		return result, fmt.Errorf("%w: read backup: %v", ErrInvalid, err)
	}
	var doc BackupDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return result, fmt.Errorf("%w: parse backup: %v", ErrInvalid, err)
	}
	if doc.Format != backupFormat {
		return result, fmt.Errorf("%w: not a krss backup file", ErrInvalid)
	}
	if doc.Version <= 0 || doc.Version > backupVersion {
		return result, fmt.Errorf("%w: unsupported backup version %d", ErrInvalid, doc.Version)
	}

	folderMap, err := s.importFolders(ctx, doc.Folders, &result)
	if err != nil {
		return result, err
	}
	if err := s.importFeeds(ctx, doc.Feeds, folderMap, &result); err != nil {
		return result, err
	}

	// 设置：只跳过「永不出导」键（user.password_hash / user.jwt_secret）。
	// 敏感凭证（ai.api_key 等）若出现在文件里则照常导入 —— 导入按文件实际包含的分区恢复。
	if s.settings != nil && len(doc.Settings) > 0 {
		toSet := make(map[string]string, len(doc.Settings))
		for k, v := range doc.Settings {
			if isNeverExportSettingKey(k) {
				continue
			}
			toSet[k] = v
		}
		if err := s.settings.SetMany(ctx, toSet); err != nil {
			return result, fmt.Errorf("apply settings: %w", err)
		}
		result.SettingsApplied = len(toSet)
	}

	if s.plugins != nil {
		for _, p := range doc.Plugins {
			if strings.TrimSpace(p.ID) == "" {
				continue
			}
			if err := s.plugins.Upsert(ctx, p.ID, p.Enabled); err != nil {
				return result, fmt.Errorf("restore plugin %s: %w", p.ID, err)
			}
			result.PluginsApplied++
		}
	}

	if s.mcpServers != nil && len(doc.MCPServers) > 0 {
		if err := s.importMCPServers(ctx, doc.MCPServers, &result); err != nil {
			return result, err
		}
	}

	logger.Info("backup import completed", "module", "service", "action", "import", "resource", "backup", "result", "ok", "folders_created", result.FoldersCreated, "folders_skipped", result.FoldersSkipped, "feeds_created", result.FeedsCreated, "feeds_skipped", result.FeedsSkipped, "settings", result.SettingsApplied, "plugins", result.PluginsApplied)
	return result, nil
}

// importFolders 按父子关系重建文件夹树：先建父再建子，按（名称+父级）去重。
// 返回原始文件夹 ID → 新建/复用文件夹 ID 的映射，供 importFeeds 还原订阅归属。
func (s *backupService) importFolders(ctx context.Context, folders []BackupFolder, result *BackupImportResult) (map[int64]int64, error) {
	folderMap := make(map[int64]int64, len(folders))
	if len(folders) == 0 {
		return folderMap, nil
	}
	byID := make(map[int64]BackupFolder, len(folders))
	children := make(map[int64][]int64, len(folders))
	var roots []int64
	for _, f := range folders {
		byID[f.ID] = f
	}
	for _, f := range folders {
		if f.ParentID == nil {
			roots = append(roots, f.ID)
			continue
		}
		if _, ok := byID[*f.ParentID]; !ok {
			roots = append(roots, f.ID)
			continue
		}
		children[*f.ParentID] = append(children[*f.ParentID], f.ID)
	}

	visited := make(map[int64]bool, len(folders))

	var create func(oldID int64, newParent *int64) error
	create = func(oldID int64, newParent *int64) error {
		if visited[oldID] {
			return nil
		}
		visited[oldID] = true
		f := byID[oldID]
		folder, created, err := s.ensureFolder(ctx, f, newParent)
		if err != nil {
			return err
		}
		folderMap[oldID] = folder.ID
		if created {
			result.FoldersCreated++
		} else {
			result.FoldersSkipped++
		}
		for _, childID := range children[oldID] {
			parentID := folder.ID
			if err := create(childID, &parentID); err != nil {
				return err
			}
		}
		return nil
	}

	for _, rootID := range roots {
		if err := create(rootID, nil); err != nil {
			return folderMap, err
		}
	}
	// 兜底：环状/孤立引用（不应出现）也不会漏建。
	for _, f := range folders {
		if !visited[f.ID] {
			if err := create(f.ID, nil); err != nil {
				return folderMap, err
			}
		}
	}

	return folderMap, nil
}

func (s *backupService) ensureFolder(ctx context.Context, f BackupFolder, newParent *int64) (model.Folder, bool, error) {
	name := strings.TrimSpace(f.Name)
	if name == "" {
		name = "Untitled"
	}
	if existing, err := s.folders.FindByName(ctx, name, newParent); err != nil {
		return model.Folder{}, false, fmt.Errorf("find folder: %w", err)
	} else if existing != nil {
		return *existing, false, nil
	}

	folderType := strings.TrimSpace(f.Type)
	if folderType == "" {
		folderType = "article"
	}
	folder, err := s.folders.Create(ctx, name, newParent, folderType)
	if err != nil {
		return model.Folder{}, false, fmt.Errorf("create folder %s: %w", name, err)
	}
	if f.ProxyMode != nil || f.ProxyConfig != nil {
		if err := s.folders.UpdateProxyOverride(ctx, folder.ID, f.ProxyMode, sanitizeProxyConfig(f.ProxyConfig)); err != nil {
			return model.Folder{}, false, fmt.Errorf("restore folder proxy: %w", err)
		}
	}
	return folder, true, nil
}

func (s *backupService) importFeeds(ctx context.Context, feeds []BackupFeed, folderMap map[int64]int64, result *BackupImportResult) error {
	for _, bf := range feeds {
		url := strings.TrimSpace(bf.URL)
		if url == "" {
			result.FeedsSkipped++
			continue
		}
		if existing, err := s.feeds.FindByURL(ctx, url); err != nil {
			return fmt.Errorf("find feed %s: %w", url, err)
		} else if existing != nil {
			result.FeedsSkipped++
			continue
		}

		var folderID *int64
		if bf.FolderID != nil {
			if newID, ok := folderMap[*bf.FolderID]; ok {
				folderID = &newID
			}
		}

		feed := model.Feed{
			FolderID:              folderID,
			Title:                 bf.Title,
			URL:                   url,
			SiteURL:               bf.SiteURL,
			Description:           bf.Description,
			SummaryPromptReminder: bf.SummaryPromptReminder,
			Type:                  bf.Type,
			SourceType:            bf.SourceType,
			MCPConfig:             bf.MCPConfig,
			AutoTranslate:         bf.AutoTranslate,
			AutoSummary:           bf.AutoSummary,
			ReaderMode:            bf.ReaderMode,
			ProxyMode:             bf.ProxyMode,
			ProxyConfig:           sanitizeProxyConfig(bf.ProxyConfig),
		}
		created, err := s.feeds.Create(ctx, feed)
		if err != nil {
			return fmt.Errorf("create feed %s: %w", url, err)
		}
		// Create 不落 auto_*/proxy_* 等覆盖项，用 Update 补齐（Type/SourceType/MCPConfig 已由 Create 落库）。
		feed.ID = created.ID
		if _, err := s.feeds.Update(ctx, feed); err != nil {
			return fmt.Errorf("restore feed overrides %s: %w", url, err)
		}
		result.FeedsCreated++
	}
	return nil
}

func (s *backupService) importMCPServers(ctx context.Context, servers []BackupMCPServer, result *BackupImportResult) error {
	existing, err := s.mcpServers.List(ctx)
	if err != nil {
		return fmt.Errorf("list existing mcp servers: %w", err)
	}
	existingURL := make(map[string]bool, len(existing))
	for _, e := range existing {
		existingURL[e.URL] = true
	}
	for _, bm := range servers {
		if strings.TrimSpace(bm.URL) == "" || existingURL[bm.URL] {
			result.MCPServersSkipped++
			continue
		}
		server := model.MCPServer{
			Name:                   bm.Name,
			Transport:              bm.Transport,
			URL:                    bm.URL,
			AuthType:               bm.AuthType,
			Enabled:                false, // 导入后默认禁用，待用户测试再启用
			Purposes:               bm.Purposes,
			UseGlobalFetch:         bm.UseGlobalFetch,
			FetchTimeoutSeconds:    bm.FetchTimeoutSeconds,
			FetchConcurrency:       bm.FetchConcurrency,
			RefreshIntervalMinutes: bm.RefreshIntervalMinutes,
			Headers:                bm.Headers,
			OAuthClientID:          bm.OAuthClientID,
			OAuthClientSecret:      bm.OAuthClientSecret,
			OAuthAccessToken:       bm.OAuthAccessToken,
			OAuthRefreshToken:      bm.OAuthRefreshToken,
			OAuthTokenType:         bm.OAuthTokenType,
			OAuthScope:             bm.OAuthScope,
			OAuthAuthServer:        bm.OAuthAuthServer,
			OAuthExpiresAt:         bm.OAuthExpiresAt,
		}
		if _, err := s.mcpServers.Create(ctx, server); err != nil {
			return fmt.Errorf("create mcp server %s: %w", bm.Name, err)
		}
		existingURL[bm.URL] = true
		result.MCPServersCreated++
	}
	return nil
}

// isExcludedSettingKey 复用设置导出的凭证排除清单（含 "anubis.cookie.*" 通配前缀）。
func isExcludedSettingKey(key string) bool {
	for _, pattern := range excludedSettingKeys() {
		if strings.HasSuffix(pattern, "*") {
			if strings.HasPrefix(key, strings.TrimSuffix(pattern, "*")) {
				return true
			}
			continue
		}
		if key == pattern {
			return true
		}
	}
	return false
}

// isNeverExportSettingKey 账号安全类键：任何情况下都不导出/导入。
func isNeverExportSettingKey(key string) bool {
	return matchSettingPatterns(key, neverExportSettingKeys())
}

// isSensitiveSettingKey 敏感凭证键：默认排除，仅在显式勾选「敏感凭证」时导出。
func isSensitiveSettingKey(key string) bool {
	return matchSettingPatterns(key, sensitiveSettingKeys()) ||
		matchSettingPatterns(key, extraSensitiveSettingKeys())
}

func matchSettingPatterns(key string, patterns []string) bool {
	for _, pattern := range patterns {
		if strings.HasSuffix(pattern, "*") {
			if strings.HasPrefix(key, strings.TrimSuffix(pattern, "*")) {
				return true
			}
			continue
		}
		if key == pattern {
			return true
		}
	}
	return false
}

// sanitizeProxyConfig 复制一份并清空密码：备份不落代理密码。
func sanitizeProxyConfig(cfg *model.ProxyOverrideConfig) *model.ProxyOverrideConfig {
	if cfg == nil {
		return nil
	}
	clone := *cfg
	clone.Password = ""
	return &clone
}
