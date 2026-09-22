//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"strconv"

	"krss/backend/internal/model"
	"krss/backend/internal/repository"
	"krss/backend/pkg/logger"
)

// 代理按来源生效（用户 14 批 · 迁移 26）。
//
// 解析顺序：**订阅 → 文件夹（含父级链）→ 全局**，第一个非 NULL 说了算。
// 某一层选了「走代理」时用哪套地址：这一层**单独指定**了就用它，否则用全局那套；
// 全局总开关关掉 = 全局那套不存在（GetProxyURL() 返回空），这时只有「单独指定」的层能走代理，
// 其余一律直连 —— 也就是「覆盖只在有可用地址时才有意义」。
//
// 刻意**另开入口**：既不碰 settings.GetProxyURL() 的既有语义，也不在 ClientFactory 里加缓存
// （每轮现读，改完设置立刻生效 —— 11-20 那条「每轮重读」的规矩）。
type ProxySourceService interface {
	// ProxyURLForFeed 给 pkg/network 用：按来源解析出代理 URL（空串 = 直连）。
	// 第二个返回值 false 表示解析不出来（订阅不存在 / 库里出错），调用方应退回全局那套（老行为）。
	ProxyURLForFeed(ctx context.Context, feedID int64) (string, bool)

	// ResolveForFeed 解析一条订阅实际生效的代理（不会失败：解析不出来就按全局算）。
	ResolveForFeed(ctx context.Context, feed model.Feed) ProxyEffective
	// ResolveForFeedID 同上，按 id 现取（接口/测试按钮用）。
	ResolveForFeedID(ctx context.Context, feedID int64) ProxyEffective
	// ResolveForFolder 解析一个文件夹实际生效的代理（从它自己开始往上走父级链）。
	ResolveForFolder(ctx context.Context, folderID int64) ProxyEffective

	// Overview 给设置页「按来源覆盖」段与管理面板用：全局一份 + 所有文件夹/订阅 + 计数。
	Overview(ctx context.Context) (*ProxySourceOverview, error)
}

// 生效来源（谁决定了这个结果）
const (
	ProxySourceFeed   = "feed"
	ProxySourceFolder = "folder"
	ProxySourceGlobal = "global"
)

// 生效结果（与 model.ProxyMode 对应）
const (
	proxyEffectiveProxy  = "proxy"
	proxyEffectiveDirect = "direct"
)

// ProxyEffective 一个来源实际会怎么走。
type ProxyEffective struct {
	// Mode 实际生效：proxy = 走代理，direct = 直连
	Mode string `json:"mode"`
	// Source 这个结果由谁决定：feed / folder / global
	Source string `json:"source"`
	// SourceID / SourceName 决定它的那一层（folder 时是文件夹名字，界面直接显示「来自：文件夹『技术』」）
	SourceID   string `json:"sourceId,omitempty"`
	SourceName string `json:"sourceName,omitempty"`
	// Missing：这一层选了「走代理」但拿不到可用地址（全局总开关关着、或单独指定没填全）→ 实际直连
	Missing bool `json:"missing,omitempty"`
	// URL 真实代理地址：只在服务端用，绝不进接口返回、绝不进日志（可能含密码）
	URL string `json:"-"`
}

type proxySourceService struct {
	feeds    repository.FeedRepository
	folders  repository.FolderRepository
	settings SettingsService
}

func NewProxySourceService(feeds repository.FeedRepository, folders repository.FolderRepository, settings SettingsService) ProxySourceService {
	return &proxySourceService{feeds: feeds, folders: folders, settings: settings}
}

// ProxyURLForFeed 实现 pkg/network.SourceProxyProvider。
func (s *proxySourceService) ProxyURLForFeed(ctx context.Context, feedID int64) (string, bool) {
	if feedID <= 0 {
		return "", false
	}
	feed, err := s.feeds.GetByID(ctx, feedID)
	if err != nil {
		// 取不到就退回全局（老行为），不因为一个读库失败把整条抓取变成直连
		return "", false
	}
	return s.ResolveForFeed(ctx, feed).URL, true
}

// ResolveForFeed 订阅 → 文件夹父级链 → 全局。
func (s *proxySourceService) ResolveForFeed(ctx context.Context, feed model.Feed) ProxyEffective {
	if effective, decided := s.decide(ctx, feed.ProxyMode, feed.ProxyConfig, ProxySourceFeed, feed.ID, feed.Title); decided {
		return effective
	}
	if feed.FolderID != nil {
		if effective, decided := s.resolveFolderChain(ctx, *feed.FolderID); decided {
			return effective
		}
	}
	return s.globalEffective(ctx)
}

// ResolveForFeedID 按 id 现取一条订阅再解析（取不到时按全局算，调用方另有 404 判断）。
func (s *proxySourceService) ResolveForFeedID(ctx context.Context, feedID int64) ProxyEffective {
	feed, err := s.feeds.GetByID(ctx, feedID)
	if err != nil {
		logger.Warn("proxy resolve feed failed", "module", "service", "action", "resolve", "resource", "proxy", "result", "failed", "feed_id", feedID, "error", err)
		return s.globalEffective(ctx)
	}
	return s.ResolveForFeed(ctx, feed)
}

// ResolveForFolder 从这个文件夹自己开始，逐层向上找第一个非 NULL。
func (s *proxySourceService) ResolveForFolder(ctx context.Context, folderID int64) ProxyEffective {
	if effective, decided := s.resolveFolderChain(ctx, folderID); decided {
		return effective
	}
	return s.globalEffective(ctx)
}

// resolveFolderChain 文件夹父级链：第一个非 NULL 说了算；带 visited 防环。
func (s *proxySourceService) resolveFolderChain(ctx context.Context, folderID int64) (ProxyEffective, bool) {
	visited := make(map[int64]bool)
	current := &folderID
	for current != nil && !visited[*current] {
		visited[*current] = true
		folder, err := s.folders.GetByID(ctx, *current)
		if err != nil {
			logger.Warn("proxy resolve folder failed", "module", "service", "action", "resolve", "resource", "proxy", "result", "failed", "folder_id", *current, "error", err)
			return ProxyEffective{}, false
		}
		if effective, decided := s.decide(ctx, folder.ProxyMode, folder.ProxyConfig, ProxySourceFolder, folder.ID, folder.Name); decided {
			return effective, true
		}
		current = folder.ParentID
	}
	return ProxyEffective{}, false
}

// decide 这一层自己说了什么（mode == nil 表示跟随上级，交给上层继续找）。
func (s *proxySourceService) decide(ctx context.Context, mode *model.ProxyMode, cfg *model.ProxyOverrideConfig, source string, id int64, name string) (ProxyEffective, bool) {
	if mode == nil {
		return ProxyEffective{}, false
	}
	effective := ProxyEffective{Source: source, SourceID: strconv.FormatInt(id, 10), SourceName: name}
	if *mode == model.ProxyModeDirect {
		effective.Mode = proxyEffectiveDirect
		return effective, true
	}
	effective.Mode = proxyEffectiveProxy
	if cfg.Usable() {
		effective.URL = cfg.URL()
		return effective, true
	}
	// 走代理 + 「用全局那套」：全局那套不可用就只能直连（并把缺失标出来）
	if globalURL := s.settings.GetProxyURL(ctx); globalURL != "" {
		effective.URL = globalURL
		return effective, true
	}
	effective.Mode = proxyEffectiveDirect
	effective.Missing = true
	return effective, true
}

// globalEffective 全局兜底：GetProxyURL() 非空 = 走代理，否则直连。
func (s *proxySourceService) globalEffective(ctx context.Context) ProxyEffective {
	effective := ProxyEffective{Source: ProxySourceGlobal, Mode: proxyEffectiveDirect}
	if url := s.settings.GetProxyURL(ctx); url != "" {
		effective.Mode = proxyEffectiveProxy
		effective.URL = url
	}
	return effective
}

// Overview 设置 → 网络「按来源覆盖」段的数据源：
// 全局一份（密码掩码）+ 所有文件夹 + 所有订阅 + 各自生效结果 + 计数。
// 订阅和文件夹都不多（本项目量级几百），一次给全量让前端直接画树，省掉一轮轮询接口。
func (s *proxySourceService) Overview(ctx context.Context) (*ProxySourceOverview, error) {
	global, err := s.settings.GetNetworkSettings(ctx)
	if err != nil {
		return nil, err
	}
	folders, err := s.folders.List(ctx)
	if err != nil {
		return nil, err
	}
	feeds, err := s.feeds.List(ctx, nil)
	if err != nil {
		return nil, err
	}

	feedCountByFolder := make(map[int64]int, len(folders))
	for _, feed := range feeds {
		if feed.FolderID != nil {
			feedCountByFolder[*feed.FolderID]++
		}
	}

	overview := &ProxySourceOverview{
		Global:  global,
		Folders: make([]ProxyFolderView, 0, len(folders)),
		Feeds:   make([]ProxyFeedView, 0, len(feeds)),
	}
	for _, folder := range folders {
		view := ProxyFolderView{
			ID:        strconv.FormatInt(folder.ID, 10),
			ParentID:  idOrEmpty(folder.ParentID),
			Name:      folder.Name,
			Type:      folder.Type,
			FeedCount: feedCountByFolder[folder.ID],
			Override:  toProxyOverrideView(folder.ProxyMode, folder.ProxyConfig),
			Effective: s.ResolveForFolder(ctx, folder.ID),
		}
		if folder.ProxyMode != nil {
			overview.Counts.Folders++
		}
		overview.Folders = append(overview.Folders, view)
	}
	for _, feed := range feeds {
		effective := s.ResolveForFeed(ctx, feed)
		view := ProxyFeedView{
			ID:        strconv.FormatInt(feed.ID, 10),
			FolderID:  idOrEmpty(feed.FolderID),
			Title:     feed.Title,
			Type:      feed.Type,
			IconPath:  stringOrEmpty(feed.IconPath),
			Override:  toProxyOverrideView(feed.ProxyMode, feed.ProxyConfig),
			Effective: effective,
		}
		if feed.ProxyMode != nil {
			overview.Counts.Feeds++
		}
		if effective.Mode == proxyEffectiveProxy {
			overview.Counts.ProxiedFeeds++
		}
		overview.Feeds = append(overview.Feeds, view)
	}
	if global.Enabled {
		overview.Counts.GlobalEnabled = true
	}

	return overview, nil
}

// ProxySourceOverview 一览（字段名即前端直接用）。
type ProxySourceOverview struct {
	Global  *NetworkSettings   `json:"global"`
	Folders []ProxyFolderView  `json:"folders"`
	Feeds   []ProxyFeedView    `json:"feeds"`
	Counts  ProxyOverrideCount `json:"counts"`
}

// ProxyOverrideCount 设置页那两枚计数（外加一个「实际走代理的订阅数」，方便一眼核对）。
type ProxyOverrideCount struct {
	Folders       int  `json:"folders"`
	Feeds         int  `json:"feeds"`
	ProxiedFeeds  int  `json:"proxiedFeeds"`
	GlobalEnabled bool `json:"globalEnabled"`
}

// ProxyOverrideView 某一层自己选了什么（mode：inherit / proxy / direct；config 密码已掩码）。
type ProxyOverrideView struct {
	Mode   string                     `json:"mode"`
	Config *model.ProxyOverrideConfig `json:"config,omitempty"`
}

// ProxyFolderView 文件夹一行。
type ProxyFolderView struct {
	ID        string            `json:"id"`
	ParentID  string            `json:"parentId,omitempty"`
	Name      string            `json:"name"`
	Type      string            `json:"type"`
	FeedCount int               `json:"feedCount"`
	Override  ProxyOverrideView `json:"override"`
	Effective ProxyEffective    `json:"effective"`
}

// ProxyFeedView 订阅一行。
type ProxyFeedView struct {
	ID        string            `json:"id"`
	FolderID  string            `json:"folderId,omitempty"`
	Title     string            `json:"title"`
	Type      string            `json:"type"`
	IconPath  string            `json:"iconPath,omitempty"`
	Override  ProxyOverrideView `json:"override"`
	Effective ProxyEffective    `json:"effective"`
}

// ProxyOverrideUpdate PATCH 的归一化入参（区分「没带这个字段」与「带了想要清空」）：
//   - SetMode=false：这次不动 mode；SetMode=true 且 Mode==nil：改回「跟随上级」
//   - SetConfig=false：这次不动 config；SetConfig=true 且 Config==nil：清掉「单独指定」那套
type ProxyOverrideUpdate struct {
	Mode      *model.ProxyMode
	SetMode   bool
	Config    *model.ProxyOverrideConfig
	SetConfig bool
}

// Apply 把这次改动合并到既有值上，返回落库用的 (mode, config)。
func (u ProxyOverrideUpdate) Apply(mode *model.ProxyMode, cfg *model.ProxyOverrideConfig) (*model.ProxyMode, *model.ProxyOverrideConfig) {
	if u.SetMode {
		mode = u.Mode
	}
	if u.SetConfig {
		cfg = u.Config
	}
	return mode, cfg
}

// ProxyModeToString / ProxyModeFromString 三态与接口字符串互转。
func ProxyModeToString(mode *model.ProxyMode) string {
	if mode == nil {
		return "inherit"
	}
	if *mode == model.ProxyModeDirect {
		return "direct"
	}
	return "proxy"
}

// ProxyModeFromString 解析接口字符串；返回 (nil, true) = 明确要「跟随上级」。
func ProxyModeFromString(value string) (*model.ProxyMode, bool) {
	switch value {
	case "inherit", "":
		return nil, true
	case "proxy":
		mode := model.ProxyModeProxy
		return &mode, true
	case "direct":
		mode := model.ProxyModeDirect
		return &mode, true
	default:
		return nil, false
	}
}

// toProxyOverrideView 把库里那份转成可返回前端的形态（密码照 GetNetworkSettings 那套掩码）。
func toProxyOverrideView(mode *model.ProxyMode, cfg *model.ProxyOverrideConfig) ProxyOverrideView {
	return ProxyOverrideView{Mode: ProxyModeToString(mode), Config: maskProxyConfig(cfg)}
}

// maskProxyConfig 复制一份并掩码密码（订阅级/文件夹级也一样脱敏，绝不原样回前端）。
func maskProxyConfig(cfg *model.ProxyOverrideConfig) *model.ProxyOverrideConfig {
	if cfg == nil {
		return nil
	}
	masked := *cfg
	if masked.Password != "" {
		masked.Password = maskAPIKey(masked.Password)
	}
	return &masked
}

// normalizeProxyOverrideUpdate 归一化这次改动：密码是掩码（***）时沿用库里那份的密码
// —— 与 setAPIKey 完全同一个做法，避免「编辑别的字段把密码冲掉」。
func normalizeProxyOverrideUpdate(update ProxyOverrideUpdate, existing *model.ProxyOverrideConfig) ProxyOverrideUpdate {
	if !update.SetConfig || update.Config == nil {
		return update
	}
	if update.Config.Password != "" && isMaskedKey(update.Config.Password) && existing != nil {
		update.Config.Password = existing.Password
	}
	return update
}

// MaskedProxyConfig 给 handler 层用：返回一份密码已掩码的副本（凭证不进接口返回）。
func MaskedProxyConfig(cfg *model.ProxyOverrideConfig) *model.ProxyOverrideConfig {
	return maskProxyConfig(cfg)
}

func idOrEmpty(id *int64) string {
	if id == nil {
		return ""
	}
	return strconv.FormatInt(*id, 10)
}

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
