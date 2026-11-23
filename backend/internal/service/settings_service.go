//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"krss/backend/internal/repository"
	"krss/backend/internal/service/ai"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/network"
)

// AIProviderConfig 一个保存好的 AI 提供商配置（可存多个，随时切换当前使用）。
type AIProviderConfig struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	BaseURL  string `json:"baseUrl"`
	// Model：该提供商的默认模型 —— 「当前使用」是它时就用这个出请求，
	// 分场景只写到 provider:<id>（不带 #model）时也回落到它。
	Model string `json:"model"`
	// Models：该提供商可用的模型库（通常含默认模型）。同一个提供商可能同时提供
	// 翻译、摘要等不同模型，分场景按 provider:<id>#<model> 从这里挑；老库没有这个
	// 字段时读侧按 [Model] 兜底，不影响升级。
	Models         []string       `json:"models,omitempty"`
	APIKey         string         `json:"apiKey"`
	RequestOptions map[string]any `json:"requestOptions,omitempty"`
	// Placeholder：合成占位（51 批 1）。老实例没有保存过提供商列表时，getAIProviders
	// 会用平铺字段合成一条 default —— 它不是用户配出来的真实提供商，前端据此把
	// 「只剩占位」的状态显示成「无」。保存路径会把它剥掉，永不落库。
	Placeholder bool `json:"placeholder,omitempty"`
}

// AISettings holds the AI configuration.
type AISettings struct {
	Provider        string         `json:"provider"`
	APIKey          string         `json:"apiKey"`
	BaseURL         string         `json:"baseUrl"`
	Model           string         `json:"model"`
	RequestOptions  map[string]any `json:"requestOptions"`
	SummaryLanguage string         `json:"summaryLanguage"`
	AutoTranslate   bool           `json:"autoTranslate"`
	AutoSummary     bool           `json:"autoSummary"`
	RateLimit       int            `json:"rateLimit"`
	// TranslateChannel：旧的单值通道（兼容用，始终等于轮询列表的第一个）。空 = 用上面配置的模型。
	TranslateChannel string `json:"translateChannel"`
	// TranslateChannels：免费翻译通道轮询列表（顺序即轮询顺序）。为空 = 不走免费通道，翻译直接用模型。
	TranslateChannels []string `json:"translateChannels"`
	// FallbackToModel：免费通道失败时是否自动切回模型（默认开）
	FallbackToModel bool `json:"fallbackToModel"`
	// UseProxy：AI 调用是否走代理（含智能代理），默认 false（默认直连）
	UseProxy bool `json:"useProxy"`
	// 保存的提供商列表 + 当前使用哪一个（上面的 Provider/APIKey/... 始终等于当前使用的那份）
	Providers        []AIProviderConfig `json:"providers"`
	ActiveProviderID string             `json:"activeProviderId"`
	// 分场景模型覆盖（50 批 1.2）：空串 = 跟随当前提供商的模型（默认，行为与原来一致）。
	// 值形如 provider:<id>（用 providers 里那一份的 key/model）或 free（仅翻译场景 = 免费通道）。
	SceneTranslate  string `json:"sceneTranslate"`
	SceneSummary    string `json:"sceneSummary"`
	SceneAutomation string `json:"sceneAutomation"`
}

// ErrInvalidExportDir 导出目录填错（相对路径 / 不存在 / 不是文件夹）—— handler 据此回 400。
var ErrInvalidExportDir = errors.New("导出目录无效")

// GeneralSettings holds general application settings.
type GeneralSettings struct {
	FallbackUserAgent string `json:"fallbackUserAgent"`
	// ExportDir 插件导出的文件写到哪（Obsidian vault 之类）。空 = 走浏览器下载。
	// 它是宿主能力而不是某个插件的能力：任何插件返回 files，宿主都往这里写。
	ExportDir        string `json:"exportDir"`
	AutoReadability  bool   `json:"autoReadability"`
	MarkReadOnScroll bool   `json:"markReadOnScroll"`
	// 55-18：RSSHub 实例地址 / ACCESS_KEY 已搬进 rsshub 插件（键 plugin.rsshub.*），
	// 本体通用设置不再认识它们 —— 特化能力不进核心。
}

// NetworkSettings holds network proxy configuration.
type NetworkSettings struct {
	Enabled  bool   `json:"enabled"`
	Type     string `json:"type"` // http, socks5
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	IPStack  string `json:"ipStack"` // default, ipv4, ipv6
	// Mode 全局代理怎么用（50 批 2.2）：proxy = 全走代理（旧行为）；smart = 先直连不通再代理 + 按域记忆。
	// 空 = proxy（老库零变化）。
	Mode string `json:"mode"`
}

// AppearanceSettings holds appearance configuration.
type AppearanceSettings struct {
	ContentTypes []string `json:"contentTypes"`
}

// ---------- 21 批（2026-09-18）：界面设置搬到服务端，跨设备/换浏览器/清缓存都不丢 ----------

// UIThemeSettings 主题三件套：明暗模式 + 明暗各自选的那套配色。
type UIThemeSettings struct {
	Mode       string `json:"mode"`
	LightTheme string `json:"lightTheme"`
	DarkTheme  string `json:"darkTheme"`
}

// UISettings 界面设置整包。
//
// 这里**刻意只做透传、不给前端字段建模**：UI 与 SidebarState 是原样 JSON，后端只校验
// 「是 JSON 对象 + 不超限」。原因是有前车之鉴 —— 后端 DTO 少一个字段，前端设置会静默失效
// 且不报错（前端设置曾因后端 DTO 少一个字段而静默失效）。前端字段有 25+ 项而且还会继续长，建模等于给自己埋雷。
//
// UI 的形状由前端约定：`{ "shared": {...}, "device": { "desktop": {...}, "mobile": {...} } }`
// —— 尺寸类（列宽/缩放/侧栏）按设备分套，其余共享，避免把桌面的列宽同步到手机上。
type UISettings struct {
	UI           json.RawMessage `json:"ui"`
	Theme        UIThemeSettings `json:"theme"`
	Lang         string          `json:"lang"`
	SidebarState json.RawMessage `json:"sidebarState"`
	UpdatedAt    time.Time       `json:"updatedAt,omitempty"`
	// Empty = 服务端一条界面设置都没存过。前端据此判断「首次迁移：以本地为准推上去」。
	Empty bool `json:"empty"`
}

// settingsExportVersion 导出文件格式版本（改结构时要一起改）。
const settingsExportVersion = 1

// SettingsExport 导出的设置整包（可读 JSON，导入可逆）。
type SettingsExport struct {
	Version    int                        `json:"version"`
	ExportedAt time.Time                  `json:"exportedAt"`
	Settings   map[string]json.RawMessage `json:"settings"`
	// ExcludedKeys 导出时被排除的键（凭证类）——写进文件里，让用户知道漏了哪些、为什么。
	ExcludedKeys []string `json:"excludedKeys"`
}

const (
	// keyUISettings 界面设置整包（shared + 按设备分套的尺寸类）
	keyUISettings = "ui"
	// keyUITheme 主题（模式 + 明暗配色）
	keyUITheme = "ui.theme"
	// keyUILang 界面语言
	keyUILang = "ui.lang"
	// keyUISidebarState 侧栏分类展开态
	keyUISidebarState = "ui.sidebar_state"
)

// 界面设置的大小上限：正常整包实测 < 4KB，256KB 是防呆（防止把别的东西塞进来当设置）。
const (
	maxUISettingsBytes = 256 * 1024
	maxUIShortFieldLen = 32
)

// Setting keys
const (
	keyAIProvider          = "ai.provider"
	keyAIAPIKey            = "ai.api_key"
	keyAIBaseURL           = "ai.base_url"
	keyAIModel             = "ai.model"
	keyAIRequestOptions    = "ai.request_options"
	keyAISummaryLanguage   = "ai.summary_language"
	keyAIAutoTranslate     = "ai.auto_translate"
	keyAIAutoSummary       = "ai.auto_summary"
	keyAIRateLimit         = "ai.rate_limit"
	keyAITranslateChannel  = "ai.translate_channel"
	keyAITranslateChannels = "ai.translate_channels"
	keyAIFallbackToModel   = "ai.fallback_to_model"
	keyAIUseProxy          = "ai.use_proxy"
	keyAIProviders         = "ai.providers"
	keyAIActiveProvider    = "ai.active_provider_id"
	// 分场景模型覆盖（50 批 1.2）：空 = 跟随当前提供商；provider:<id> = 用已保存的那份；free = 免费通道（仅翻译）
	keyAISceneTranslate  = "ai.scene_translate"
	keyAISceneSummary    = "ai.scene_summary"
	keyAISceneAutomation = "ai.scene_automation"

	keyFallbackUserAgent = "general.fallback_user_agent"
	keyExportDir         = "general.export_dir"
	keyAutoReadability   = "general.auto_readability"
	keyMarkReadOnScroll  = "general.mark_read_on_scroll"
	// RSSHub 实例配置 55-18 起归 rsshub 插件；旧键保留，只为兼容老版本导出的设置备份。
	pluginRSSHubBaseURL = "plugin.rsshub.base_url"
	legacyRSSHubBaseURL = "general.rsshub_base_url"
	keyNetworkEnabled   = "network.proxy_enabled"
	keyNetworkMode      = "network.proxy_mode" // "proxy" | "smart"；空 = proxy（旧行为）
	keyNetworkType      = "network.proxy_type"
	keyNetworkHost      = "network.proxy_host"
	keyNetworkPort      = "network.proxy_port"
	keyNetworkUsername  = "network.proxy_username"
	keyNetworkPassword  = "network.proxy_password"
	keyNetworkIPStack   = "network.ip_stack"

	keyAppearanceContentTypes = "appearance.content_types"

	// 拉取（11-20）：频率与并发可配置。四个值都是「下一轮生效」的读法（不缓存到进程里），
	// 用户改完不用重启；空值一律回落默认，越界值在写入时就夹紧。
	keyRefreshIntervalMinutes    = "general.refresh_interval_minutes"
	keyRefreshConcurrency        = "general.refresh_concurrency"
	keyRefreshPerHostConcurrency = "general.refresh_per_host_concurrency"
	keyRefreshTimeoutSeconds     = "general.refresh_timeout_seconds"

	// 缓存清理（1123）：已读文章保留天数 / 墓碑保留天数。0 都有特殊语义（全部清理 / 永久保留），
	// 所以读取时必须能把「显式 0」和「没配置」区分开（用 getString + strconv.Atoi，别用 getInt）。
	keyCacheEntryRetentionDays     = "cache.entry_retention_days"
	keyCacheTombstoneRetentionDays = "cache.tombstone_retention_days"
)

// 拉取默认值（改这里等于改「没显式配置时」的行为）。
const (
	DefaultRefreshIntervalMinutes    = 15
	DefaultRefreshConcurrency        = 12
	DefaultRefreshPerHostConcurrency = 10
	DefaultRefreshTimeoutSeconds     = 15
)

// 缓存清理默认值与上限（1123）。0 是合法值：entry 0 = 全部清理，tombstone 0 = 永久保留。
const (
	DefaultCacheEntryRetentionDays     = 30
	DefaultCacheTombstoneRetentionDays = 180
	// 上限：已读保留最多 10 年，墓碑保留最多 100 年（防呆，避免离谱大数）。
	maxCacheEntryRetentionDays     = 3650
	maxCacheTombstoneRetentionDays = 36500
)

// FetchSettings 拉取相关设置（用户 11-20：定时频率、全局并发、同主机并发、单源超时）。
type FetchSettings struct {
	// IntervalMinutes 定时刷新间隔（分钟）
	IntervalMinutes int `json:"intervalMinutes"`
	// Concurrency 全局并发（同时在抓的源数上限）
	Concurrency int `json:"concurrency"`
	// PerHostConcurrency 同一主机并发上限（礼貌值：同一站别同时打太多）
	PerHostConcurrency int `json:"perHostConcurrency"`
	// TimeoutSeconds 单个源抓取超时（秒）
	TimeoutSeconds int `json:"timeoutSeconds"`
}

// CacheSettings 文章缓存清理设置（1123）：两个保留期都以「天」为单位，0 有特殊语义。
//
//   - EntryRetentionDays：清理缓存时只删「最近阅读/更新时间早于 N 天」的已读未收藏文章；
//     0 = 不设时间门槛，清理全部已读未收藏（老行为）。默认 30。
//   - TombstoneRetentionDays：已清理文章的墓碑保留 N 天，期内刷新不再回流；0 = 永久保留。默认 180。
type CacheSettings struct {
	EntryRetentionDays     int `json:"entryRetentionDays"`
	TombstoneRetentionDays int `json:"tombstoneRetentionDays"`
}

// SettingsService provides settings management.
type SettingsService interface {
	// GetAISettings returns the AI configuration with masked API keys.
	GetAISettings(ctx context.Context) (*AISettings, error)
	// SetAISettings updates the AI configuration.
	// If apiKey is empty string, it keeps the existing key.
	SetAISettings(ctx context.Context, settings *AISettings) error
	// TestAI tests the AI connection with the given configuration.
	TestAI(ctx context.Context, provider, apiKey, baseURL, model string, requestOptions map[string]any) (string, error)
	// ListAIModels 查询提供商可用模型列表
	ListAIModels(ctx context.Context, provider, apiKey, baseURL string) ([]string, error)
	// GetGeneralSettings returns the general settings.
	GetGeneralSettings(ctx context.Context) (*GeneralSettings, error)
	// SetGeneralSettings updates the general settings.
	SetGeneralSettings(ctx context.Context, settings *GeneralSettings) error
	// GetFallbackUserAgent returns the fallback user agent if set.
	GetFallbackUserAgent(ctx context.Context) string
	// ClearAnubisCookies deletes all Anubis cookies from settings.
	ClearAnubisCookies(ctx context.Context) (int64, error)
	// GetNetworkSettings returns the network proxy configuration.
	GetNetworkSettings(ctx context.Context) (*NetworkSettings, error)
	// SetNetworkSettings updates the network proxy configuration.
	SetNetworkSettings(ctx context.Context, settings *NetworkSettings) error
	// SetClientFactory 注入 HTTP 客户端工厂（设置页测试连接/探测模型走代理用）；nil = 直连。
	SetClientFactory(factory *network.ClientFactory)
	// GetProxyURL returns the formatted proxy URL (e.g., socks5://user:pass@host:port).
	// Returns empty string if proxy is disabled.
	GetProxyURL(ctx context.Context) string
	// GetNetworkSettingsMode 全局代理模式（50 批 2.2）："proxy"（默认/旧行为）| "smart"。
	GetNetworkSettingsMode(ctx context.Context) string
	// GetIPStack returns the IP stack preference (default, ipv4, ipv6).
	GetIPStack(ctx context.Context) string
	// GetFetchSettings 拉取设置（频率/并发/超时），未配置的字段返回默认值。
	GetFetchSettings(ctx context.Context) (*FetchSettings, error)
	// SetFetchSettings 更新拉取设置：只写传进来的字段（>0 才覆盖），写入前夹紧到合法区间。
	SetFetchSettings(ctx context.Context, settings *FetchSettings) error
	// GetCacheSettings 读缓存清理设置（1123）：未配置/解析失败回默认值，显式 0 保留为 0。
	GetCacheSettings(ctx context.Context) (*CacheSettings, error)
	// SetCacheSettings 写缓存清理设置（1123）：写入前夹紧到合法区间（负数按 0）。
	SetCacheSettings(ctx context.Context, settings *CacheSettings) error
	// GetAppearanceSettings returns appearance settings.
	GetAppearanceSettings(ctx context.Context) (*AppearanceSettings, error)
	// SetAppearanceSettings updates appearance settings.
	SetAppearanceSettings(ctx context.Context, settings *AppearanceSettings) error
	// GetUISettings 读界面设置整包（21 批）；Empty=true 表示服务端还没存过（前端据此做首次迁移）。
	GetUISettings(ctx context.Context) (*UISettings, error)
	// SetUISettings 写界面设置整包：只写传进来的那几项，四个键一次事务落库。
	SetUISettings(ctx context.Context, settings *UISettings) error
	// ExportSettings 导出设置（白名单键，凭证类排除并列出）。
	ExportSettings(ctx context.Context) (*SettingsExport, error)
	// ImportSettings 导入设置：只接受白名单键，整体覆盖；出现白名单外的键直接报错，不静默忽略。
	ImportSettings(ctx context.Context, payload *SettingsExport) error
}

type settingsService struct {
	repo        repository.SettingsRepository
	rateLimiter *ai.RateLimiter
	// clientFactory：设置页「测试连接 / 探测模型」走代理用；nil = 直连（测试/降级）。
	clientFactory *network.ClientFactory
}

// NewSettingsService creates a new settings service.
func NewSettingsService(repo repository.SettingsRepository, rateLimiter *ai.RateLimiter) SettingsService {
	return &settingsService{repo: repo, rateLimiter: rateLimiter}
}

// SetClientFactory 注入 HTTP 客户端工厂。因 ClientFactory 的代理解析器本身依赖本服务
// （构造时循环依赖），只能在两者都建好后由装配处回填；nil = 直连。
func (s *settingsService) SetClientFactory(factory *network.ClientFactory) {
	s.clientFactory = factory
}

// probeHTTPClient 设置页探测（测试连接 / 模型列表）用的客户端：
// ai.use_proxy 开着且有工厂时走代理（全局，feedID=0）；否则返回 nil 表示直连（用默认客户端）。
func (s *settingsService) probeHTTPClient(ctx context.Context, timeout time.Duration) *http.Client {
	if s.clientFactory != nil && s.getBoolDefault(ctx, keyAIUseProxy, false) {
		return s.clientFactory.NewHTTPClientForFeed(ctx, 0, timeout)
	}
	return nil
}

// GetAISettings returns the AI configuration with masked API keys.
func (s *settingsService) GetAISettings(ctx context.Context) (*AISettings, error) {
	settings := &AISettings{
		Provider:        ai.ProviderOpenAI, // default
		SummaryLanguage: "zh-CN",           // default language
	}

	if val, err := s.getString(ctx, keyAIProvider); err == nil && val != "" {
		settings.Provider = val
	}
	if val, err := s.getString(ctx, keyAIAPIKey); err == nil && val != "" {
		settings.APIKey = maskAPIKey(val)
	}
	if val, err := s.getString(ctx, keyAIBaseURL); err == nil {
		settings.BaseURL = val
	}
	if val, err := s.getString(ctx, keyAIModel); err == nil {
		settings.Model = val
	}
	if val, err := s.getRequestOptions(ctx); err != nil {
		return nil, err
	} else {
		settings.RequestOptions = val
	}
	if val, err := s.getString(ctx, keyAISummaryLanguage); err == nil && val != "" {
		settings.SummaryLanguage = val
	}
	settings.AutoTranslate = s.getBool(ctx, keyAIAutoTranslate)
	settings.AutoSummary = s.getBool(ctx, keyAIAutoSummary)
	hasLegacyKey := false
	if setting, err := s.repo.Get(ctx, keyAITranslateChannel); err == nil && setting != nil {
		hasLegacyKey = true
		settings.TranslateChannel = setting.Value
	}
	hasChannelsKey := false
	if setting, err := s.repo.Get(ctx, keyAITranslateChannels); err == nil && setting != nil {
		hasChannelsKey = true
		if v := strings.TrimSpace(setting.Value); v != "" {
			var channels []string
			if jsonErr := json.Unmarshal([]byte(v), &channels); jsonErr == nil {
				settings.TranslateChannels = ai.NormalizeFreeTranslateChannels(channels)
			}
		}
	}
	// B 方案：老用户只有旧单值时只保留它，不再自动补其它通道。
	if len(settings.TranslateChannels) == 0 {
		settings.TranslateChannels = ai.EffectiveFreeTranslateChannels(nil, settings.TranslateChannel)
	}
	if settings.TranslateChannels == nil {
		if !hasChannelsKey && !hasLegacyKey {
			// 全新安装：默认勾选全部免费通道
			settings.TranslateChannels = ai.DefaultFreeTranslateChannels()
		} else {
			settings.TranslateChannels = []string{} // 显式为空 = 关闭免费通道，走模型
		}
	}
	settings.FallbackToModel = s.getBoolDefault(ctx, keyAIFallbackToModel, true)
	settings.UseProxy = s.getBoolDefault(ctx, keyAIUseProxy, false)
	if val, err := s.getInt(ctx, keyAIRateLimit); err == nil && val > 0 {
		settings.RateLimit = val
	} else {
		settings.RateLimit = ai.DefaultRateLimit
	}

	settings.Providers = s.getAIProviders(ctx, settings)
	settings.ActiveProviderID = "default"
	if val, err := s.getString(ctx, keyAIActiveProvider); err == nil && val != "" {
		settings.ActiveProviderID = val
	}
	// 51 批 A5：「当前使用」必须是可用配置（至少配了模型），否则视为无 ——
	// 指向的卡缺模型时照常显示卡片，但「当前使用」行显示「无」、AI 请求不再拿它当配置。
	settings.ActiveProviderID = s.usableActiveProviderID(settings.Providers, settings.ActiveProviderID, settings.Model)
	if val, err := s.getString(ctx, keyAISceneTranslate); err == nil {
		settings.SceneTranslate = val
	}
	if val, err := s.getString(ctx, keyAISceneSummary); err == nil {
		settings.SceneSummary = val
	}
	if val, err := s.getString(ctx, keyAISceneAutomation); err == nil {
		settings.SceneAutomation = val
	}

	return settings, nil
}

// getAIProvidersRaw 读取已保存的提供商列表原始值（密钥不打码 —— 只给保存路径用，别直接往外发）。
// 老实例没有列表时合成一条 default，保证 provider:default 这种场景覆盖能解析。
func (s *settingsService) getAIProvidersRaw(ctx context.Context) []AIProviderConfig {
	raw, err := s.getString(ctx, keyAIProviders)
	if err == nil && raw != "" {
		var saved []AIProviderConfig
		if jsonErr := json.Unmarshal([]byte(raw), &saved); jsonErr == nil && len(saved) > 0 {
			return saved
		}
	}
	return []AIProviderConfig{{ID: "default"}}
}

// getAIProviders 读取已保存的提供商列表（密钥打码）。老实例没有这个列表时，
// 用当前配置合成一条，保证前端至少有一份可编辑的配置。
func (s *settingsService) getAIProviders(ctx context.Context, settings *AISettings) []AIProviderConfig {
	saved := s.getAIProvidersRaw(ctx)
	if len(saved) == 1 && saved[0].ID == "default" && saved[0].Provider == "" {
		defaultProvider := settings.Provider
		if defaultProvider == "" {
			defaultProvider = ai.ProviderOpenAI
		}
		return []AIProviderConfig{{
			ID:             "default",
			Name:           defaultProvider,
			Provider:       defaultProvider,
			BaseURL:        settings.BaseURL,
			Model:          settings.Model,
			APIKey:         maskAPIKey(settings.APIKey),
			RequestOptions: settings.RequestOptions,
			// 51 批 1：合成占位（用户从没配过提供商时平铺字段也是空的），前端显示「无」。
			// 老实例平铺字段里有真配置时不是占位 —— 那是唯一可用的配置，照常渲染卡片。
			Placeholder: settings.Model == "" && settings.BaseURL == "" && settings.APIKey == "",
		}}
	}
	for i := range saved {
		saved[i].APIKey = maskAPIKey(saved[i].APIKey)
	}
	return saved
}

// usableActiveProviderID 归一化「当前使用」：指向的配置必须存在且配了模型（模型是出请求的硬前提），
// 否则返回空串（= 无当前使用）。default 占位（列表里唯一的合成行）跟随平铺 model 判定。
// 51 批 A5：删卡/新建半成品/老实例空平铺都可能落到「没有可用提供商」，统一在这里收口。
func (s *settingsService) usableActiveProviderID(providers []AIProviderConfig, activeID, flatModel string) string {
	for i := range providers {
		if providers[i].ID != activeID {
			continue
		}
		if providers[i].Model != "" {
			return activeID
		}
		// 合成占位（default）的 Model 来自平铺字段
		if providers[i].ID == "default" && flatModel != "" {
			return activeID
		}
		return ""
	}
	// 指向的 id 不在列表里：若有任一可用配置也不自动顶上 —— 「当前使用」是显式选择，
	// 但列表为空时没有「无」可指，直接无。
	return ""
}

// SetAISettings updates the AI configuration.
func (s *settingsService) SetAISettings(ctx context.Context, settings *AISettings) error {
	if settings.Provider != "" {
		if err := s.repo.Set(ctx, keyAIProvider, settings.Provider); err != nil {
			return fmt.Errorf("set provider: %w", err)
		}
	}
	if err := s.setAPIKey(ctx, keyAIAPIKey, settings.APIKey); err != nil {
		logger.Warn("ai settings update api key failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set api key: %w", err)
	}
	if err := s.repo.Set(ctx, keyAIBaseURL, settings.BaseURL); err != nil {
		logger.Warn("ai settings update base url failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set base url: %w", err)
	}
	if err := s.repo.Set(ctx, keyAIModel, settings.Model); err != nil {
		logger.Warn("ai settings update model failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "model", settings.Model, "error", err)
		return fmt.Errorf("set model: %w", err)
	}
	requestOptions, err := json.Marshal(settings.RequestOptions)
	if err != nil {
		logger.Warn("ai settings marshal request options failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("marshal request options: %w", err)
	}
	if string(requestOptions) == "null" {
		requestOptions = []byte("{}")
	}
	if err := s.repo.Set(ctx, keyAIRequestOptions, string(requestOptions)); err != nil {
		logger.Warn("ai settings update request options failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set request options: %w", err)
	}
	if err := s.repo.Set(ctx, keyAISummaryLanguage, settings.SummaryLanguage); err != nil {
		logger.Warn("ai settings update summary language failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set summary language: %w", err)
	}
	autoTranslateVal := "false"
	if settings.AutoTranslate {
		autoTranslateVal = "true"
	}
	if err := s.repo.Set(ctx, keyAIAutoTranslate, autoTranslateVal); err != nil {
		logger.Warn("ai settings update auto translate failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set auto translate: %w", err)
	}
	autoSummaryVal := "false"
	if settings.AutoSummary {
		autoSummaryVal = "true"
	}
	if err := s.repo.Set(ctx, keyAIAutoSummary, autoSummaryVal); err != nil {
		logger.Warn("ai settings update auto summary failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set auto summary: %w", err)
	}
	// Set rate limit and update limiter
	rateLimit := settings.RateLimit
	if rateLimit <= 0 {
		rateLimit = ai.DefaultRateLimit
	}
	if err := s.repo.Set(ctx, keyAIRateLimit, fmt.Sprintf("%d", rateLimit)); err != nil {
		logger.Warn("ai settings update rate limit failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set rate limit: %w", err)
	}
	fallbackVal := "false"
	if settings.FallbackToModel {
		fallbackVal = "true"
	}
	if err := s.repo.Set(ctx, keyAIFallbackToModel, fallbackVal); err != nil {
		logger.Warn("ai settings update fallback flag failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set fallback flag: %w", err)
	}
	useProxyVal := "false"
	if settings.UseProxy {
		useProxyVal = "true"
	}
	if err := s.repo.Set(ctx, keyAIUseProxy, useProxyVal); err != nil {
		logger.Warn("ai settings update use proxy flag failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set use proxy flag: %w", err)
	}
	channels := ai.NormalizeFreeTranslateChannels(settings.TranslateChannels)
	if len(channels) == 0 && ai.IsFreeTranslateChannel(settings.TranslateChannel) {
		// 老调用方只给了单值：按旧值推导（仅保留该单值）
		channels = ai.EffectiveFreeTranslateChannels(nil, settings.TranslateChannel)
	}
	if channels == nil {
		channels = []string{}
	}
	channelsJSON, _ := json.Marshal(channels)
	if err := s.repo.Set(ctx, keyAITranslateChannels, string(channelsJSON)); err != nil {
		logger.Warn("ai settings update translate channels failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set translate channels: %w", err)
	}
	// 旧键保持为第一个通道，供仍读旧键的路径兼容；空列表写空串（= 走模型）
	legacyChannel := ""
	if len(channels) > 0 {
		legacyChannel = channels[0]
	}
	if err := s.repo.Set(ctx, keyAITranslateChannel, legacyChannel); err != nil {
		logger.Warn("ai settings update translate channel failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set translate channel: %w", err)
	}
	if s.rateLimiter != nil {
		s.rateLimiter.SetLimit(rateLimit)
	}
	if err := s.setAIProviders(ctx, settings); err != nil {
		logger.Warn("ai settings update providers failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return err
	}
	// 分场景模型覆盖（50 批 1.2）：值形如 provider:<id> / free / 空；写之前核一遍 id 在不在已保存清单里，
	// 不在（提供商被删、导入串进来）就落回空 = 跟随，别留一个永远解析不出的值。
	// free（免 key 通道）只对翻译场景合法 —— 摘要/自动化给 free 直接 400。
	sceneValues := []struct {
		key         string
		val         string
		freeAllowed bool
	}{
		{keyAISceneTranslate, settings.SceneTranslate, true},
		{keyAISceneSummary, settings.SceneSummary, false},
		{keyAISceneAutomation, settings.SceneAutomation, false},
	}
	for _, scene := range sceneValues {
		stored, err := s.resolveSceneSetting(ctx, scene.val, scene.freeAllowed)
		if err != nil {
			return fmt.Errorf("set %s: %w", scene.key, err)
		}
		if err := s.repo.Set(ctx, scene.key, stored); err != nil {
			return fmt.Errorf("set %s: %w", scene.key, err)
		}
	}
	logger.Info("ai settings updated", "module", "service", "action", "update", "resource", "settings", "result", "ok", "provider", settings.Provider, "model", settings.Model, "rate_limit", rateLimit)
	return nil
}

// splitSceneProvider 把 "provider:" 之后的部分拆成提供商 id 与可选模型（"id#model"）。
// 模型名里可能有 "-" "/" "." 等，取第一个 # 之前为 id、之后为模型，够用且不歧义。
func splitSceneProvider(after string) (id, model string) {
	after = strings.TrimSpace(after)
	if i := strings.Index(after, "#"); i >= 0 {
		return strings.TrimSpace(after[:i]), strings.TrimSpace(after[i+1:])
	}
	return after, ""
}

// resolveSceneSetting 校验并归一化场景覆盖值：空/跟随 → ""；free → "free"（仅 freeAllowed）；
// provider:<id> → id 在已保存清单里才原样返回，否则给空（按跟随处理）。
func (s *settingsService) resolveSceneSetting(ctx context.Context, val string, freeAllowed bool) (string, error) {
	val = strings.TrimSpace(val)
	if val == "" {
		return "", nil
	}
	if val == "free" {
		if !freeAllowed {
			return "", fmt.Errorf("%w: free channel is only valid for the translate scene", ErrInvalid)
		}
		return "free", nil
	}
	if after, ok := strings.CutPrefix(val, "provider:"); ok {
		// provider:<id> 用该提供商的默认模型；provider:<id>#<model> 用指定模型
		// （同一提供商下挂多个模型时分场景各挑一个）。
		id, model := splitSceneProvider(after)
		if id == "" {
			return "", nil
		}
		for _, item := range s.getAIProvidersRaw(ctx) {
			if item.ID == id {
				if model == "" {
					return "provider:" + id, nil
				}
				return "provider:" + id + "#" + model, nil
			}
		}
		return "", nil
	}
	// free 对摘要/自动化不合法（免 key 通道只接翻译），其余未知值一律拒绝而不是静默清掉
	return "", fmt.Errorf("%w: invalid scene setting %q", ErrInvalid, val)
}

// setAIProviders 保存提供商列表：打码的密钥沿用库里已存的值，当前使用的那个始终同步到 ai.api_key。
func (s *settingsService) setAIProviders(ctx context.Context, settings *AISettings) error {
	if settings.Providers == nil {
		return nil
	}

	storedKeys := map[string]string{}
	if raw, err := s.getString(ctx, keyAIProviders); err == nil && raw != "" {
		var saved []AIProviderConfig
		if jsonErr := json.Unmarshal([]byte(raw), &saved); jsonErr == nil {
			for _, item := range saved {
				storedKeys[item.ID] = item.APIKey
			}
		}
	}
	// 旧实例可能只有平铺 ai.api_key（还没把密钥写进 keyAIProviders）。
	// 只有在「从没切过当前使用」（keyAIActiveProvider 为空）时才把平铺 key 补给当前那张卡；
	// 否则会把旧 active 的 key 错误套到新 active 的 id 上，切换当前使用就会静默丢 key。
	prevActiveID := ""
	if v, err := s.getString(ctx, keyAIActiveProvider); err == nil {
		prevActiveID = v
	}
	flatKey := ""
	if v, err := s.getString(ctx, keyAIAPIKey); err == nil {
		flatKey = v
	}

	activeID := settings.ActiveProviderID
	if activeID == "" {
		activeID = "default"
	}

	list := make([]AIProviderConfig, 0, len(settings.Providers))
	for _, item := range settings.Providers {
		entry := item
		if entry.ID == "" {
			continue
		}
		// 51 批 1：合成占位永不落库 —— 前端整页快照里带着它，剥掉避免存成一张「真空卡」
		if entry.Placeholder {
			continue
		}
		if entry.APIKey == "" || isMaskedKey(entry.APIKey) {
			if stored := storedKeys[entry.ID]; stored != "" {
				entry.APIKey = stored
			} else if entry.ID == activeID && flatKey != "" && prevActiveID == "" && (settings.APIKey == "" || isMaskedKey(settings.APIKey)) {
				// 仅兼容「从未写过 providers 密钥」的老实例，避免切换当前使用时串 key。
				entry.APIKey = flatKey
			}
		}
		entry.Placeholder = false
		list = append(list, entry)
	}

	encoded, err := json.Marshal(list)
	if err != nil {
		return fmt.Errorf("marshal providers: %w", err)
	}
	if err := s.repo.Set(ctx, keyAIProviders, string(encoded)); err != nil {
		return fmt.Errorf("set providers: %w", err)
	}
	if err := s.repo.Set(ctx, keyAIActiveProvider, activeID); err != nil {
		return fmt.Errorf("set active provider: %w", err)
	}
	// 当前使用的提供商的真实密钥同步到平铺 ai.api_key，保证仍读平铺字段的路径拿到的是当前那家。
	for _, item := range list {
		if item.ID == activeID && item.APIKey != "" {
			if err := s.repo.Set(ctx, keyAIAPIKey, item.APIKey); err != nil {
				return fmt.Errorf("sync api key: %w", err)
			}
			break
		}
	}
	return nil
}

// resolveAPIKeyForProbe 探测模型时用的密钥：传了真密钥就用它，打码/为空则回落到
// 提供商列表里同 provider+baseUrl 那份，再回落当前使用的 ai.api_key。
func (s *settingsService) resolveAPIKeyForProbe(ctx context.Context, provider, baseURL, apiKey string) string {
	if apiKey != "" && !isMaskedKey(apiKey) {
		return apiKey
	}

	if raw, err := s.getString(ctx, keyAIProviders); err == nil && raw != "" {
		var saved []AIProviderConfig
		if jsonErr := json.Unmarshal([]byte(raw), &saved); jsonErr == nil {
			for _, item := range saved {
				if item.Provider == provider && strings.TrimRight(item.BaseURL, "/") == strings.TrimRight(baseURL, "/") && item.APIKey != "" {
					return item.APIKey
				}
			}
		}
	}

	if stored, err := s.getString(ctx, keyAIAPIKey); err == nil {
		return stored
	}
	return ""
}

// ListAIModels 向提供商查询可用模型列表（OpenAI/兼容端点 GET /models，Anthropic GET /v1/models）。
func (s *settingsService) ListAIModels(ctx context.Context, provider, apiKey, baseURL string) ([]string, error) {
	key := s.resolveAPIKeyForProbe(ctx, provider, baseURL, apiKey)
	if key == "" {
		return nil, ErrInvalid
	}

	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	endpoint := ""
	reqHeaders := map[string]string{}

	switch provider {
	case ai.ProviderAnthropic:
		if base == "" {
			base = "https://api.anthropic.com"
		}
		if strings.HasSuffix(base, "/v1") {
			endpoint = base + "/models"
		} else {
			endpoint = base + "/v1/models"
		}
		reqHeaders["x-api-key"] = key
		reqHeaders["anthropic-version"] = "2023-06-01"
	case ai.ProviderOpenAI, ai.ProviderCompatible:
		if base == "" {
			return nil, ErrInvalid
		}
		endpoint = base + "/models"
		reqHeaders["Authorization"] = "Bearer " + key
	default:
		return nil, ErrInvalid
	}

	reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build models request: %w", err)
	}
	for name, value := range reqHeaders {
		req.Header.Set(name, value)
	}

	client := s.probeHTTPClient(ctx, 20*time.Second)
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch models: %w", err)
	}
	defer func() {
		_ = resp.Body.Close()
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("fetch models: unexpected status %d", resp.StatusCode)
	}

	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode models: %w", err)
	}

	models := make([]string, 0, len(payload.Data))
	seen := map[string]struct{}{}
	for _, item := range payload.Data {
		if item.ID == "" {
			continue
		}
		if _, ok := seen[item.ID]; ok {
			continue
		}
		seen[item.ID] = struct{}{}
		models = append(models, item.ID)
	}
	sort.Strings(models)

	if len(models) == 0 {
		return nil, fmt.Errorf("no models returned")
	}
	return models, nil
}

// maskAPIKey returns a masked version of the API key for display.
func maskAPIKey(apiKey string) string {
	if apiKey == "" {
		return ""
	}
	if len(apiKey) <= 8 {
		return "***"
	}
	// Find prefix (e.g., "sk-" for OpenAI)
	prefixEnd := 0
	for i, c := range apiKey {
		if c == '-' {
			prefixEnd = i + 1
			break
		}
		if i >= 4 {
			break
		}
	}
	prefix := apiKey[:prefixEnd]
	suffix := apiKey[len(apiKey)-3:]
	return prefix + "***" + suffix
}

// isMaskedKey checks if a string looks like a masked API key.
func isMaskedKey(key string) bool {
	if len(key) == 0 || len(key) >= 20 {
		return false
	}
	for i := 0; i <= len(key)-3; i++ {
		if key[i:i+3] == "***" {
			return true
		}
	}
	return false
}

// TestAI tests the AI connection with the given configuration.
func (s *settingsService) TestAI(ctx context.Context, provider, apiKey, baseURL, model string, requestOptions map[string]any) (string, error) {
	// If apiKey looks like a masked key, try to get the stored key
	if isMaskedKey(apiKey) {
		storedKey, err := s.getString(ctx, keyAIAPIKey)
		if err != nil {
			return "", fmt.Errorf("get stored api key: %w", err)
		}
		apiKey = storedKey
	}

	cfg := ai.Config{
		Provider:       provider,
		APIKey:         apiKey,
		BaseURL:        baseURL,
		Model:          model,
		RequestOptions: requestOptions,
	}
	// 设置页「测试连接」也要受 ai.use_proxy 约束：开着走代理，关/无工厂直连。
	if hc := s.probeHTTPClient(ctx, 60*time.Second); hc != nil {
		cfg.HTTPClient = hc
	}

	p, err := ai.NewProvider(cfg)
	if err != nil {
		logger.Warn("ai settings test create provider failed", "module", "service", "action", "test", "resource", "settings", "result", "failed", "provider", provider, "model", model, "error", err)
		return "", err
	}

	response, err := p.Test(ctx)
	if err != nil {
		logger.Warn("ai settings test failed", "module", "service", "action", "test", "resource", "settings", "result", "failed", "provider", provider, "model", model, "error", err)
		return "", err
	}

	logger.Info("ai settings test ok", "module", "service", "action", "test", "resource", "settings", "result", "ok", "provider", provider, "model", model)
	return response, nil
}

// getString gets a plain string value from settings.
func (s *settingsService) getString(ctx context.Context, key string) (string, error) {
	setting, err := s.repo.Get(ctx, key)
	if err != nil {
		return "", err
	}
	if setting == nil {
		return "", nil
	}
	return setting.Value, nil
}

// getInt gets an integer value from settings.
func (s *settingsService) getInt(ctx context.Context, key string) (int, error) {
	val, err := s.getString(ctx, key)
	if err != nil || val == "" {
		return 0, err
	}
	var result int
	_, err = fmt.Sscanf(val, "%d", &result)
	return result, err
}

// getBool gets a boolean value from settings.
func (s *settingsService) getBool(ctx context.Context, key string) bool {
	val, err := s.getString(ctx, key)
	return err == nil && val == "true"
}

// getBoolDefault：没设过这个键时返回 fallback（用于「默认开」的开关）
func (s *settingsService) getBoolDefault(ctx context.Context, key string, fallback bool) bool {
	val, err := s.getString(ctx, key)
	if err != nil || val == "" {
		return fallback
	}
	return val == "true"
}

func (s *settingsService) getRequestOptions(ctx context.Context) (map[string]any, error) {
	val, err := s.getString(ctx, keyAIRequestOptions)
	if err != nil || val == "" {
		return nil, err
	}

	var options map[string]any
	if err := json.Unmarshal([]byte(val), &options); err != nil {
		return nil, fmt.Errorf("unmarshal request options: %w", err)
	}
	return options, nil
}

// setAPIKey sets an API key.
// If the value is empty or looks like a masked key, it keeps the existing key.
func (s *settingsService) setAPIKey(ctx context.Context, key, value string) error {
	if value == "" || isMaskedKey(value) {
		return nil
	}
	return s.repo.Set(ctx, key, value)
}

// GetGeneralSettings returns the general settings.
func (s *settingsService) GetGeneralSettings(ctx context.Context) (*GeneralSettings, error) {
	settings := &GeneralSettings{}

	if val, err := s.getString(ctx, keyFallbackUserAgent); err == nil {
		settings.FallbackUserAgent = val
	}
	settings.AutoReadability = s.getBool(ctx, keyAutoReadability)
	// 默认开启（与生产实例一致）：未显式配置时，滚动即标已读
	settings.MarkReadOnScroll = s.getBoolDefault(ctx, keyMarkReadOnScroll, true)
	if val, err := s.getString(ctx, keyExportDir); err == nil {
		settings.ExportDir = val
	}
	return settings, nil
}

// clampInt 把值夹到 [min,max]；0 表示「没传」由调用方决定要不要用默认值。
func clampInt(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// GetFetchSettings 读拉取设置；没配置过的字段返回默认值（老库升级后行为与升级前一致）。
func (s *settingsService) GetFetchSettings(ctx context.Context) (*FetchSettings, error) {
	out := &FetchSettings{
		IntervalMinutes:    DefaultRefreshIntervalMinutes,
		Concurrency:        DefaultRefreshConcurrency,
		PerHostConcurrency: DefaultRefreshPerHostConcurrency,
		TimeoutSeconds:     DefaultRefreshTimeoutSeconds,
	}
	if v, err := s.getInt(ctx, keyRefreshIntervalMinutes); err == nil && v > 0 {
		out.IntervalMinutes = clampInt(v, 1, 24*60)
	}
	if v, err := s.getInt(ctx, keyRefreshConcurrency); err == nil && v > 0 {
		out.Concurrency = clampInt(v, 1, 64)
	}
	if v, err := s.getInt(ctx, keyRefreshPerHostConcurrency); err == nil && v > 0 {
		out.PerHostConcurrency = clampInt(v, 1, 64)
	}
	if v, err := s.getInt(ctx, keyRefreshTimeoutSeconds); err == nil && v > 0 {
		out.TimeoutSeconds = clampInt(v, 1, 300)
	}
	return out, nil
}

// SetFetchSettings 只覆盖传进来的字段（>0 才写），空字段保持原值 —— 前端可以只改一项。
func (s *settingsService) SetFetchSettings(ctx context.Context, settings *FetchSettings) error {
	if settings == nil {
		return ErrInvalid
	}
	if settings.IntervalMinutes > 0 {
		if err := s.repo.Set(ctx, keyRefreshIntervalMinutes, strconv.Itoa(clampInt(settings.IntervalMinutes, 1, 24*60))); err != nil {
			return fmt.Errorf("set refresh interval: %w", err)
		}
	}
	if settings.Concurrency > 0 {
		if err := s.repo.Set(ctx, keyRefreshConcurrency, strconv.Itoa(clampInt(settings.Concurrency, 1, 64))); err != nil {
			return fmt.Errorf("set refresh concurrency: %w", err)
		}
	}
	if settings.PerHostConcurrency > 0 {
		if err := s.repo.Set(ctx, keyRefreshPerHostConcurrency, strconv.Itoa(clampInt(settings.PerHostConcurrency, 1, 64))); err != nil {
			return fmt.Errorf("set refresh per-host concurrency: %w", err)
		}
	}
	if settings.TimeoutSeconds > 0 {
		if err := s.repo.Set(ctx, keyRefreshTimeoutSeconds, strconv.Itoa(clampInt(settings.TimeoutSeconds, 1, 300))); err != nil {
			return fmt.Errorf("set refresh timeout: %w", err)
		}
	}
	return nil
}

// getCacheRetention 读一个「天」数：键不存在或值解析失败 → fallback；显式 0 保留为 0（合法值）；
// 负数按 0，超过 max 夹到 max。不能用 getInt —— 它把「没配置」和「显式 0」都读成 0。
func (s *settingsService) getCacheRetention(ctx context.Context, key string, fallback, max int) (int, error) {
	val, err := s.getString(ctx, key)
	if err != nil {
		return 0, err
	}
	val = strings.TrimSpace(val)
	if val == "" {
		return fallback, nil
	}
	parsed, perr := strconv.Atoi(val)
	if perr != nil {
		return fallback, nil
	}
	if parsed < 0 {
		parsed = 0
	}
	return clampInt(parsed, 0, max), nil
}

// GetCacheSettings 读缓存清理设置；没配置过的字段返回默认值（老库升级后行为与升级前一致）。
func (s *settingsService) GetCacheSettings(ctx context.Context) (*CacheSettings, error) {
	entryDays, err := s.getCacheRetention(ctx, keyCacheEntryRetentionDays, DefaultCacheEntryRetentionDays, maxCacheEntryRetentionDays)
	if err != nil {
		return nil, fmt.Errorf("get cache entry retention: %w", err)
	}
	tombDays, err := s.getCacheRetention(ctx, keyCacheTombstoneRetentionDays, DefaultCacheTombstoneRetentionDays, maxCacheTombstoneRetentionDays)
	if err != nil {
		return nil, fmt.Errorf("get cache tombstone retention: %w", err)
	}
	return &CacheSettings{EntryRetentionDays: entryDays, TombstoneRetentionDays: tombDays}, nil
}

// SetCacheSettings 写缓存清理设置：两个字段都写（0 是合法值，不能被「没传」的旧语义吞掉），
// 写入前把越界值夹到合法区间，负数按 0。
func (s *settingsService) SetCacheSettings(ctx context.Context, settings *CacheSettings) error {
	if settings == nil {
		return ErrInvalid
	}
	entryDays := clampInt(settings.EntryRetentionDays, 0, maxCacheEntryRetentionDays)
	tombDays := clampInt(settings.TombstoneRetentionDays, 0, maxCacheTombstoneRetentionDays)
	if err := s.repo.Set(ctx, keyCacheEntryRetentionDays, strconv.Itoa(entryDays)); err != nil {
		return fmt.Errorf("set cache entry retention: %w", err)
	}
	if err := s.repo.Set(ctx, keyCacheTombstoneRetentionDays, strconv.Itoa(tombDays)); err != nil {
		return fmt.Errorf("set cache tombstone retention: %w", err)
	}
	return nil
}

// SetGeneralSettings updates the general settings.
func (s *settingsService) SetGeneralSettings(ctx context.Context, settings *GeneralSettings) error {
	exportDir := strings.TrimSpace(settings.ExportDir)
	if exportDir != "" {
		if !filepath.IsAbs(exportDir) {
			return fmt.Errorf("%w：要写绝对路径（%s）", ErrInvalidExportDir, exportDir)
		}
		info, err := os.Stat(exportDir)
		if err != nil || !info.IsDir() {
			return fmt.Errorf("%w：不存在或不是文件夹（%s）", ErrInvalidExportDir, exportDir)
		}
	}
	autoReadabilityVal := "false"
	if settings.AutoReadability {
		autoReadabilityVal = "true"
	}
	markReadOnScrollVal := "false"
	if settings.MarkReadOnScroll {
		markReadOnScrollVal = "true"
	}

	if err := s.repo.SetMany(ctx, map[string]string{
		keyFallbackUserAgent: settings.FallbackUserAgent,
		keyAutoReadability:   autoReadabilityVal,
		keyMarkReadOnScroll:  markReadOnScrollVal,
		keyExportDir:         exportDir,
	}); err != nil {
		logger.Warn("general settings update failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set general settings: %w", err)
	}
	logger.Info("general settings updated", "module", "service", "action", "update", "resource", "settings", "result", "ok", "auto_readability", settings.AutoReadability, "mark_read_on_scroll", settings.MarkReadOnScroll)
	return nil
}

// GetFallbackUserAgent returns the fallback user agent if set.
// Returns empty string if disabled (user hasn't set one).
func (s *settingsService) GetFallbackUserAgent(ctx context.Context) string {
	val, err := s.getString(ctx, keyFallbackUserAgent)
	if err != nil || val == "" {
		return ""
	}
	return val
}

// ClearAnubisCookies deletes all Anubis cookies from settings.
func (s *settingsService) ClearAnubisCookies(ctx context.Context) (int64, error) {
	deleted, err := s.repo.DeleteByPrefix(ctx, "anubis.cookie.")
	if err != nil {
		logger.Warn("anubis cookies clear failed", "module", "service", "action", "clear", "resource", "settings", "result", "failed", "error", err)
		return 0, err
	}
	logger.Info("anubis cookies cleared", "module", "service", "action", "clear", "resource", "settings", "result", "ok", "count", deleted)
	return deleted, nil
}

// GetNetworkSettings returns the network proxy configuration.
func (s *settingsService) GetNetworkSettings(ctx context.Context) (*NetworkSettings, error) {
	settings := &NetworkSettings{
		Type:    "http",    // default
		IPStack: "default", // default
	}

	settings.Enabled = s.getBool(ctx, keyNetworkEnabled)
	if val, err := s.getString(ctx, keyNetworkType); err == nil && val != "" {
		settings.Type = val
	}
	if val, err := s.getString(ctx, keyNetworkHost); err == nil {
		settings.Host = val
	}
	if val, err := s.getInt(ctx, keyNetworkPort); err == nil && val > 0 {
		settings.Port = val
	}
	if val, err := s.getString(ctx, keyNetworkUsername); err == nil {
		settings.Username = val
	}
	if val, err := s.getString(ctx, keyNetworkPassword); err == nil && val != "" {
		settings.Password = maskAPIKey(val)
	}
	if val, err := s.getString(ctx, keyNetworkIPStack); err == nil && val != "" {
		settings.IPStack = val
	}
	if val, err := s.getString(ctx, keyNetworkMode); err == nil {
		settings.Mode = val
	}

	return settings, nil
}

// SetNetworkSettings updates the network proxy configuration.
func (s *settingsService) SetNetworkSettings(ctx context.Context, settings *NetworkSettings) error {
	enabledVal := "false"
	if settings.Enabled {
		enabledVal = "true"
	}
	if err := s.repo.Set(ctx, keyNetworkEnabled, enabledVal); err != nil {
		logger.Warn("network settings update enabled failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set network enabled: %w", err)
	}

	if settings.Type != "" {
		if err := s.repo.Set(ctx, keyNetworkType, settings.Type); err != nil {
			logger.Warn("network settings update type failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
			return fmt.Errorf("set network type: %w", err)
		}
	}

	// 全局模式（50 批 2.2）：只认 proxy / smart，其它按 proxy 存
	mode := settings.Mode
	if mode != "smart" {
		mode = "proxy"
	}
	if err := s.repo.Set(ctx, keyNetworkMode, mode); err != nil {
		logger.Warn("network settings update mode failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set network mode: %w", err)
	}

	if err := s.repo.Set(ctx, keyNetworkHost, settings.Host); err != nil {
		logger.Warn("network settings update host failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set network host: %w", err)
	}

	if err := s.repo.Set(ctx, keyNetworkPort, fmt.Sprintf("%d", settings.Port)); err != nil {
		logger.Warn("network settings update port failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set network port: %w", err)
	}

	if err := s.repo.Set(ctx, keyNetworkUsername, settings.Username); err != nil {
		logger.Warn("network settings update username failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set network username: %w", err)
	}

	// Only update password if it's not masked
	if err := s.setAPIKey(ctx, keyNetworkPassword, settings.Password); err != nil {
		logger.Warn("network settings update password failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set network password: %w", err)
	}

	// Set IP stack preference
	ipStack := settings.IPStack
	if ipStack == "" {
		ipStack = "default"
	}
	if err := s.repo.Set(ctx, keyNetworkIPStack, ipStack); err != nil {
		logger.Warn("network settings update ip stack failed", "module", "service", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return fmt.Errorf("set ip stack: %w", err)
	}

	logger.Info("network settings updated", "module", "service", "action", "update", "resource", "settings", "result", "ok", "enabled", settings.Enabled, "type", settings.Type, "ip_stack", ipStack)
	return nil
}

// GetIPStack returns the IP stack preference (default, ipv4, ipv6).
func (s *settingsService) GetIPStack(ctx context.Context) string {
	val, err := s.getString(ctx, keyNetworkIPStack)
	if err != nil || val == "" {
		return "default"
	}
	return val
}

// GetNetworkSettingsMode 全局代理模式（50 批 2.2）：空/未知 = "proxy"（旧行为）。
func (s *settingsService) GetNetworkSettingsMode(ctx context.Context) string {
	val, err := s.getString(ctx, keyNetworkMode)
	if err != nil || val == "" {
		return "proxy"
	}
	if val == "smart" {
		return "smart"
	}
	return "proxy"
}

// GetProxyURL returns the formatted proxy URL (e.g., socks5://user:pass@host:port).
// Returns empty string if proxy is disabled or not configured.
func (s *settingsService) GetProxyURL(ctx context.Context) string {
	settings, err := s.repo.GetByPrefix(ctx, "network.")
	if err != nil {
		return ""
	}

	// Build map for quick lookup
	m := make(map[string]string, len(settings))
	for _, setting := range settings {
		m[setting.Key] = setting.Value
	}

	if m[keyNetworkEnabled] != "true" {
		return ""
	}

	host := m[keyNetworkHost]
	if host == "" {
		return ""
	}

	var port int
	if portStr := m[keyNetworkPort]; portStr != "" {
		fmt.Sscanf(portStr, "%d", &port)
	}
	if port <= 0 {
		return ""
	}

	proxyType := m[keyNetworkType]
	if proxyType == "" {
		proxyType = "http"
	}

	username := m[keyNetworkUsername]
	password := m[keyNetworkPassword]

	if username != "" && password != "" {
		return fmt.Sprintf("%s://%s:%s@%s:%d",
			proxyType,
			url.QueryEscape(username),
			url.QueryEscape(password),
			host,
			port,
		)
	}
	if username != "" {
		return fmt.Sprintf("%s://%s@%s:%d",
			proxyType,
			url.QueryEscape(username),
			host,
			port,
		)
	}
	return fmt.Sprintf("%s://%s:%d", proxyType, host, port)
}

func (s *settingsService) GetAppearanceSettings(ctx context.Context) (*AppearanceSettings, error) {
	settings := &AppearanceSettings{
		ContentTypes: append([]string(nil), defaultAppearanceContentTypes...),
	}
	raw, err := s.getString(ctx, keyAppearanceContentTypes)
	if err != nil || raw == "" {
		return settings, err
	}

	var contentTypes []string
	if err := json.Unmarshal([]byte(raw), &contentTypes); err != nil {
		return settings, nil
	}
	contentTypes = normalizeContentTypes(contentTypes)
	if len(contentTypes) == 0 {
		return settings, nil
	}
	settings.ContentTypes = contentTypes
	return settings, nil
}

func (s *settingsService) SetAppearanceSettings(ctx context.Context, settings *AppearanceSettings) error {
	contentTypes := normalizeContentTypes(settings.ContentTypes)
	if len(contentTypes) == 0 {
		return ErrInvalid
	}
	payload, err := json.Marshal(contentTypes)
	if err != nil {
		return fmt.Errorf("marshal content types: %w", err)
	}
	if err := s.repo.Set(ctx, keyAppearanceContentTypes, string(payload)); err != nil {
		return fmt.Errorf("set appearance content types: %w", err)
	}
	return nil
}

func normalizeContentTypes(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	ordered := make([]string, 0, len(values))
	for _, value := range values {
		if !isValidAppearanceContentType(value) {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		ordered = append(ordered, value)
	}
	return ordered
}

var defaultAppearanceContentTypes = []string{"article", "picture", "social", "notification"}

func isValidAppearanceContentType(value string) bool {
	switch value {
	case "article", "picture", "notification", "social":
		return true
	default:
		return false
	}
}

// ---------- 21 批（2026-09-18）：界面设置整包 ----------

// GetUISettings 读界面设置整包。四个键一个都没存过时 Empty=true ——
// 前端拿这一个标志判断「是不是第一次（要把本地那份推上来）」，不用自己拼「有没有内容」。
func (s *settingsService) GetUISettings(ctx context.Context) (*UISettings, error) {
	out := &UISettings{
		UI:           json.RawMessage("{}"),
		SidebarState: json.RawMessage("{}"),
		// 默认「一条都没存过」；只要读到任意一个键就翻成 false
		Empty: true,
	}

	for _, key := range []string{keyUISettings, keyUITheme, keyUILang, keyUISidebarState} {
		item, err := s.repo.Get(ctx, key)
		if err != nil {
			return nil, err
		}
		if item == nil || item.Value == "" {
			continue
		}

		switch key {
		case keyUISettings:
			if !json.Valid([]byte(item.Value)) {
				continue
			}
			out.UI = json.RawMessage(item.Value)
		case keyUITheme:
			var theme UIThemeSettings
			if err := json.Unmarshal([]byte(item.Value), &theme); err != nil {
				continue
			}
			out.Theme = theme
		case keyUILang:
			out.Lang = item.Value
		case keyUISidebarState:
			if !json.Valid([]byte(item.Value)) {
				continue
			}
			out.SidebarState = json.RawMessage(item.Value)
		}

		out.Empty = false
		if item.UpdatedAt.After(out.UpdatedAt) {
			out.UpdatedAt = item.UpdatedAt
		}
	}

	return out, nil
}

// SetUISettings 写界面设置整包。
//
// 只写**传进来的**那几项（不传的不动）—— 与 SetFetchSettings 同一套约定，
// 免得「只改主题」这种调用把整包其余部分清空。四个键由 SetMany 一次事务落库。
func (s *settingsService) SetUISettings(ctx context.Context, settings *UISettings) error {
	if settings == nil {
		return fmt.Errorf("%w: nil ui settings", ErrInvalid)
	}

	payload := make(map[string]string, 4)

	if len(settings.UI) > 0 {
		if err := validateJSONObjectPayload(settings.UI, maxUISettingsBytes); err != nil {
			return err
		}
		payload[keyUISettings] = string(settings.UI)
	}

	if settings.Theme != (UIThemeSettings{}) {
		if err := validateUITheme(settings.Theme); err != nil {
			return err
		}
		encoded, err := json.Marshal(settings.Theme)
		if err != nil {
			return fmt.Errorf("marshal ui theme: %w", err)
		}
		payload[keyUITheme] = string(encoded)
	}

	if settings.Lang != "" {
		if !isValidShortToken(settings.Lang) {
			return fmt.Errorf("%w: invalid ui language", ErrInvalid)
		}
		payload[keyUILang] = settings.Lang
	}

	if len(settings.SidebarState) > 0 {
		if err := validateJSONObjectPayload(settings.SidebarState, maxUISettingsBytes); err != nil {
			return err
		}
		payload[keyUISidebarState] = string(settings.SidebarState)
	}

	if len(payload) == 0 {
		return fmt.Errorf("%w: empty ui settings payload", ErrInvalid)
	}

	if err := s.repo.SetMany(ctx, payload); err != nil {
		return fmt.Errorf("set ui settings: %w", err)
	}
	return nil
}

// ExportSettings 导出设置：白名单键逐个读出来，凭证类排除并列在 ExcludedKeys 里。
func (s *settingsService) ExportSettings(ctx context.Context) (*SettingsExport, error) {
	out := &SettingsExport{
		Version:      settingsExportVersion,
		ExportedAt:   time.Now().UTC(),
		Settings:     make(map[string]json.RawMessage),
		ExcludedKeys: excludedSettingKeys(),
	}

	for _, key := range importableSettingKeys() {
		item, err := s.repo.Get(ctx, key)
		if err != nil {
			return nil, err
		}
		if item == nil {
			continue
		}
		out.Settings[key] = storedValueToJSON(item.Value)
	}

	return out, nil
}

// ImportSettings 导入设置：整体覆盖白名单内的键；出现白名单外的键**直接报错**（不静默忽略），
// 因为「导入了一半、另一半没进去」是最难排查的那类问题。
func (s *settingsService) ImportSettings(ctx context.Context, payload *SettingsExport) error {
	if payload == nil || len(payload.Settings) == 0 {
		return fmt.Errorf("%w: empty settings payload", ErrInvalid)
	}

	allowed := make(map[string]struct{}, len(importableSettingKeys())+1)
	for _, key := range importableSettingKeys() {
		allowed[key] = struct{}{}
	}
	// 只允许导入、不参与导出：老版本备份里的 RSSHub 通用键。导入后同步到插件键，
	// 避免「老备份一导入就整包被拒」，也避免升级实例的 RSSHub 配置丢失。
	allowed[legacyRSSHubBaseURL] = struct{}{}

	values := make(map[string]string, len(payload.Settings))
	for key, raw := range payload.Settings {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("%w: %s", ErrUnknownSettingKey, key)
		}
		if len(raw) > maxUISettingsBytes {
			return fmt.Errorf("%w: value of %s is too large", ErrInvalid, key)
		}
		if err := validateImportedValue(key, raw); err != nil {
			return err
		}
		values[key] = jsonValueToStored(raw)
	}

	// 老备份只有 general.rsshub_base_url：导入时同步到插件键（新备份已直接带插件键）。
	if legacy, ok := values[legacyRSSHubBaseURL]; ok {
		if _, hasNew := values[pluginRSSHubBaseURL]; !hasNew {
			values[pluginRSSHubBaseURL] = legacy
		}
	}

	if len(values) == 0 {
		return fmt.Errorf("%w: empty settings payload", ErrInvalid)
	}

	if err := s.repo.SetMany(ctx, values); err != nil {
		return fmt.Errorf("import settings: %w", err)
	}
	return nil
}

// importableSettingKeys 可导出/可导入的键白名单。
//
// **新增设置键时要往这里补一条**，否则导出会漏、导入会拒 —— 这是故意的：
// 白名单把「导入一份手改坏的文件」挡在门外，代价是要记得维护。
func importableSettingKeys() []string {
	return []string{
		// AI（api_key / providers 是凭证，不在此列）
		keyAIProvider,
		keyAIBaseURL,
		keyAIModel,
		keyAIRequestOptions,
		keyAISummaryLanguage,
		keyAIAutoTranslate,
		keyAIAutoSummary,
		keyAIRateLimit,
		keyAITranslateChannel,
		keyAITranslateChannels,
		keyAIFallbackToModel,
		keyAIUseProxy,
		keyAIActiveProvider,
		keyAISceneTranslate,
		keyAISceneSummary,
		keyAISceneAutomation,
		// 通用与拉取
		keyFallbackUserAgent,
		keyAutoReadability,
		pluginRSSHubBaseURL,
		keyMarkReadOnScroll,
		keyRefreshIntervalMinutes,
		keyRefreshConcurrency,
		keyRefreshPerHostConcurrency,
		keyRefreshTimeoutSeconds,
		// 缓存清理（1123）
		keyCacheEntryRetentionDays,
		keyCacheTombstoneRetentionDays,
		// 网络（代理密码不在此列）
		keyNetworkEnabled,
		keyNetworkMode,
		keyNetworkType,
		keyNetworkHost,
		keyNetworkPort,
		keyNetworkUsername,
		keyNetworkIPStack,
		// 外观 + 界面设置（21 批）
		keyAppearanceContentTypes,
		keyUISettings,
		keyUITheme,
		keyUILang,
		keyUISidebarState,
		// 资料（密码哈希 / JWT 密钥不在此列）
		keyUserUsername,
		keyUserNickname,
		keyUserEmail,
		keyUserAvatarURL,
	}
}

// neverExportSettingKeys 账号安全类键：任何情况下都不导出/导入（随实例走，导出反而危险且无用）。
func neverExportSettingKeys() []string {
	return []string{
		keyUserPasswordHash,
		keyUserJWTSecret,
	}
}

// sensitiveSettingKeys 敏感凭证键：默认排除，仅在用户显式勾选「敏感凭证」时才导出。
// **新增插件 secret 字段时同步这里**（有守门测试 settings_plugin_secret_test.go 盯着：漏了会红）。
// 注意：这里的键必须能通过「插件 secret 声明」守门测试，故 plugin.* 类放在 extraSensitiveSettingKeys。
func sensitiveSettingKeys() []string {
	return []string{
		keyAIAPIKey,
		keyAIProviders,
		keyNetworkPassword,
		// 站点会话 cookie：按前缀整体排除（anubis.cookie.<host>）
		"anubis.cookie.*",
		// 地址里带设备 key，等同于凭证。
		"plugin.bark.url",
		// 旧键（migration 保留）：值等同 plugin.bark.url，同样含设备 key。
		"notify.bark_url",
		// Krss 对外 MCP 的 Bearer token（含前缀 / 哈希等派生值）。
		"mcp.outbound_token",
		"mcp.outbound_token_prefix",
		"mcp.outbound_token_hash",
		// RSSHub 实例 ACCESS_KEY 的旧键。
		"general.rsshub_access_key",
	}
}

// extraSensitiveSettingKeys：属于敏感凭证、但因前端需要明文拼地址而不能声明为 secret 的键。
// 不进 excludedSettingKeys（守门测试只认 secret 声明），但备份导出默认仍排除它们。
func extraSensitiveSettingKeys() []string {
	return []string{
		"plugin.rsshub.access_key",
		"rsshub.access_key",
	}
}

// excludedSettingKeys 默认导出排除清单（= 永不出导 + 敏感凭证），保留给设置导出与守门测试。
func excludedSettingKeys() []string {
	out := append([]string{}, neverExportSettingKeys()...)
	return append(out, sensitiveSettingKeys()...)
}

// validateImportedValue 对导入的结构化值做一次真校验 —— 白名单只管「键认不认」，
// 值里塞个 mode="rainbow" 的话界面会直接坏掉（主题 class 只认 light/dark/system）。
func validateImportedValue(key string, raw json.RawMessage) error {
	switch key {
	case keyUITheme:
		var theme UIThemeSettings
		if err := json.Unmarshal(raw, &theme); err != nil {
			return fmt.Errorf("%w: invalid ui theme", ErrInvalid)
		}
		return validateUITheme(theme)
	case keyUILang:
		if !isValidShortToken(jsonValueToStored(raw)) {
			return fmt.Errorf("%w: invalid ui language", ErrInvalid)
		}
	case keyUISettings, keyUISidebarState:
		if err := validateJSONObjectPayload(raw, maxUISettingsBytes); err != nil {
			return err
		}
	}
	return nil
}

// storedValueToJSON：库里的值本来就是混合形态（`true` / `zh` / 一段 JSON）。
// 能当 JSON 解析的原样带走，否则引号包成字符串；导入端按同一规则逆着来，保证可逆。
func storedValueToJSON(value string) json.RawMessage {
	if json.Valid([]byte(value)) {
		return json.RawMessage(value)
	}
	quoted, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return json.RawMessage(quoted)
}

// jsonValueToStored 与 storedValueToJSON 互逆：JSON 字符串取内容，其余取原文。
func jsonValueToStored(raw json.RawMessage) string {
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	return string(raw)
}

// validateJSONObjectPayload：只要求「是 JSON 对象 + 不超上限」，字段形状不在这里管
// （前端字段会继续长，后端跟着建模就会重蹈「DTO 少字段 → 设置静默失效」的覆辙）。
func validateJSONObjectPayload(raw json.RawMessage, limit int) error {
	if len(raw) > limit {
		return fmt.Errorf("%w: settings payload too large (limit %d bytes)", ErrInvalid, limit)
	}
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		return fmt.Errorf("%w: settings payload must be a JSON object", ErrInvalid)
	}
	return nil
}

// validateUITheme：模式是固定三档（`<html class>` 只认 light/dark/system，必须严判）；
// 配色 id 只做「短、无空格」的松校验 —— 前端以后加主题不该被后端卡住。
func validateUITheme(theme UIThemeSettings) error {
	switch theme.Mode {
	case "light", "dark", "system":
	default:
		return fmt.Errorf("%w: invalid theme mode", ErrInvalid)
	}
	if theme.LightTheme != "" && !isValidShortToken(theme.LightTheme) {
		return fmt.Errorf("%w: invalid light theme", ErrInvalid)
	}
	if theme.DarkTheme != "" && !isValidShortToken(theme.DarkTheme) {
		return fmt.Errorf("%w: invalid dark theme", ErrInvalid)
	}
	return nil
}

// isValidShortToken：短标识符（主题 id / 语言码）—— 长度受限、不允许空白与控制字符。
func isValidShortToken(value string) bool {
	if value == "" || len(value) > maxUIShortFieldLen {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}
