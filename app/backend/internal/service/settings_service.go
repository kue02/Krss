//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"gist/backend/internal/repository"
	"gist/backend/internal/service/ai"
	"gist/backend/pkg/logger"
)

// AIProviderConfig 一个保存好的 AI 提供商配置（可存多个，随时切换当前使用）。
type AIProviderConfig struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Provider       string         `json:"provider"`
	BaseURL        string         `json:"baseUrl"`
	Model          string         `json:"model"`
	APIKey         string         `json:"apiKey"`
	RequestOptions map[string]any `json:"requestOptions,omitempty"`
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
	// TranslateChannel：翻译走哪条通道。空 = 用上面配置的模型；google/youdao = 免 key 通道
	TranslateChannel string `json:"translateChannel"`
	// FallbackToModel：免费通道失败时是否自动切回模型（默认开）
	FallbackToModel bool `json:"fallbackToModel"`
	// 保存的提供商列表 + 当前使用哪一个（上面的 Provider/APIKey/... 始终等于当前使用的那份）
	Providers        []AIProviderConfig `json:"providers"`
	ActiveProviderID string             `json:"activeProviderId"`
}

// GeneralSettings holds general application settings.
type GeneralSettings struct {
	FallbackUserAgent string `json:"fallbackUserAgent"`
	AutoReadability   bool   `json:"autoReadability"`
	MarkReadOnScroll  bool   `json:"markReadOnScroll"`
	// RSSHub 适配：自有实例域名 + 可选 ACCESS_KEY，用于添加订阅时改写地址、
	// 以及把已有订阅批量换到自己的实例
	RSSHubBaseURL   string `json:"rsshubBaseUrl"`
	RSSHubAccessKey string `json:"rsshubAccessKey"`
	// BarkURL 推送地址（Bark 兼容，形如 https://api.day.app/<你的 key>）。
	// 自动化规则的「推送到手机」动作没单独填地址时就走这里。
	BarkURL string `json:"barkUrl"`
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
// 且不报错（见 docs/变更记录.md）。前端字段有 25+ 项而且还会继续长，建模等于给自己埋雷。
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
	keyAIProvider         = "ai.provider"
	keyAIAPIKey           = "ai.api_key"
	keyAIBaseURL          = "ai.base_url"
	keyAIModel            = "ai.model"
	keyAIRequestOptions   = "ai.request_options"
	keyAISummaryLanguage  = "ai.summary_language"
	keyAIAutoTranslate    = "ai.auto_translate"
	keyAIAutoSummary      = "ai.auto_summary"
	keyAIRateLimit        = "ai.rate_limit"
	keyAITranslateChannel = "ai.translate_channel"
	keyAIFallbackToModel  = "ai.fallback_to_model"
	keyAIProviders        = "ai.providers"
	keyAIActiveProvider   = "ai.active_provider_id"

	keyFallbackUserAgent = "general.fallback_user_agent"
	keyAutoReadability   = "general.auto_readability"
	keyMarkReadOnScroll  = "general.mark_read_on_scroll"
	keyRSSHubBaseURL     = "general.rsshub_base_url"
	keyRSSHubAccessKey   = "general.rsshub_access_key"
	// keyNotifyBarkURL 推送地址（含 key，属凭证 —— 只存用户库里，不进仓库/日志明文）
	keyNotifyBarkURL = "notify.bark_url"
	keyNetworkEnabled    = "network.proxy_enabled"
	keyNetworkType       = "network.proxy_type"
	keyNetworkHost       = "network.proxy_host"
	keyNetworkPort       = "network.proxy_port"
	keyNetworkUsername   = "network.proxy_username"
	keyNetworkPassword   = "network.proxy_password"
	keyNetworkIPStack    = "network.ip_stack"

	keyAppearanceContentTypes = "appearance.content_types"

	// 拉取（11-20）：频率与并发可配置。四个值都是「下一轮生效」的读法（不缓存到进程里），
	// 用户改完不用重启；空值一律回落默认，越界值在写入时就夹紧。
	keyRefreshIntervalMinutes    = "general.refresh_interval_minutes"
	keyRefreshConcurrency        = "general.refresh_concurrency"
	keyRefreshPerHostConcurrency = "general.refresh_per_host_concurrency"
	keyRefreshTimeoutSeconds     = "general.refresh_timeout_seconds"
)

// 拉取默认值（改这里等于改「没显式配置时」的行为）。
const (
	DefaultRefreshIntervalMinutes    = 15
	DefaultRefreshConcurrency        = 8
	DefaultRefreshPerHostConcurrency = 6
	DefaultRefreshTimeoutSeconds     = 15
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
	// GetProxyURL returns the formatted proxy URL (e.g., socks5://user:pass@host:port).
	// Returns empty string if proxy is disabled.
	GetProxyURL(ctx context.Context) string
	// GetIPStack returns the IP stack preference (default, ipv4, ipv6).
	GetIPStack(ctx context.Context) string
	// GetFetchSettings 拉取设置（频率/并发/超时），未配置的字段返回默认值。
	GetFetchSettings(ctx context.Context) (*FetchSettings, error)
	// SetFetchSettings 更新拉取设置：只写传进来的字段（>0 才覆盖），写入前夹紧到合法区间。
	SetFetchSettings(ctx context.Context, settings *FetchSettings) error
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
}

// NewSettingsService creates a new settings service.
func NewSettingsService(repo repository.SettingsRepository, rateLimiter *ai.RateLimiter) SettingsService {
	return &settingsService{repo: repo, rateLimiter: rateLimiter}
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
	if val, err := s.getString(ctx, keyAITranslateChannel); err == nil {
		settings.TranslateChannel = val
	}
	settings.FallbackToModel = s.getBoolDefault(ctx, keyAIFallbackToModel, true)
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

	return settings, nil
}

// getAIProviders 读取已保存的提供商列表（密钥打码）。
// 老实例没有这个列表时，用当前配置合成一条，保证前端至少有一份可编辑的配置。
func (s *settingsService) getAIProviders(ctx context.Context, settings *AISettings) []AIProviderConfig {
	raw, err := s.getString(ctx, keyAIProviders)
	if err == nil && raw != "" {
		var saved []AIProviderConfig
		if jsonErr := json.Unmarshal([]byte(raw), &saved); jsonErr == nil && len(saved) > 0 {
			for i := range saved {
				saved[i].APIKey = maskAPIKey(saved[i].APIKey)
			}
			return saved
		}
	}

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
		APIKey:         settings.APIKey,
		RequestOptions: settings.RequestOptions,
	}}
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
	if err := s.repo.Set(ctx, keyAITranslateChannel, settings.TranslateChannel); err != nil {
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
	logger.Info("ai settings updated", "module", "service", "action", "update", "resource", "settings", "result", "ok", "provider", settings.Provider, "model", settings.Model, "rate_limit", rateLimit)
	return nil
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
	// 当前使用的配置的密钥一定在 ai.api_key 里
	if currentKey, err := s.getString(ctx, keyAIAPIKey); err == nil && currentKey != "" {
		storedKeys[settings.ActiveProviderID] = currentKey
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
		if entry.APIKey == "" || isMaskedKey(entry.APIKey) {
			entry.APIKey = storedKeys[entry.ID]
		}
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

	resp, err := http.DefaultClient.Do(req)
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
	settings.MarkReadOnScroll = s.getBool(ctx, keyMarkReadOnScroll)
	if val, err := s.getString(ctx, keyRSSHubBaseURL); err == nil {
		settings.RSSHubBaseURL = val
	}
	if val, err := s.getString(ctx, keyRSSHubAccessKey); err == nil {
		settings.RSSHubAccessKey = val
	}
	if val, err := s.getString(ctx, keyNotifyBarkURL); err == nil {
		settings.BarkURL = val
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

// SetGeneralSettings updates the general settings.
func (s *settingsService) SetGeneralSettings(ctx context.Context, settings *GeneralSettings) error {
	autoReadabilityVal := "false"
	if settings.AutoReadability {
		autoReadabilityVal = "true"
	}
	markReadOnScrollVal := "false"
	if settings.MarkReadOnScroll {
		markReadOnScrollVal = "true"
	}

	baseURL := strings.TrimRight(strings.TrimSpace(settings.RSSHubBaseURL), "/")
	if baseURL != "" {
		parsed, parseErr := url.Parse(baseURL)
		if parseErr != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return ErrInvalid
		}
	}

	// 推送地址按 URL 校验（空 = 不推送）；同样不允许留着末尾斜杠带来的歧义
	barkURL := strings.TrimSpace(settings.BarkURL)
	if barkURL != "" {
		parsed, parseErr := url.Parse(barkURL)
		if parseErr != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return ErrInvalid
		}
	}

	if err := s.repo.SetMany(ctx, map[string]string{
		keyFallbackUserAgent: settings.FallbackUserAgent,
		keyAutoReadability:   autoReadabilityVal,
		keyMarkReadOnScroll:  markReadOnScrollVal,
		keyRSSHubBaseURL:     baseURL,
		keyRSSHubAccessKey:   strings.TrimSpace(settings.RSSHubAccessKey),
		keyNotifyBarkURL:     barkURL,
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

var defaultAppearanceContentTypes = []string{"article", "picture", "notification", "social"}

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

	allowed := make(map[string]struct{}, len(importableSettingKeys()))
	for _, key := range importableSettingKeys() {
		allowed[key] = struct{}{}
	}

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
		keyAIFallbackToModel,
		keyAIActiveProvider,
		// 通用与拉取
		keyFallbackUserAgent,
		keyAutoReadability,
		keyMarkReadOnScroll,
		keyRSSHubBaseURL,
		keyRefreshIntervalMinutes,
		keyRefreshConcurrency,
		keyRefreshPerHostConcurrency,
		keyRefreshTimeoutSeconds,
		// 网络（代理密码不在此列）
		keyNetworkEnabled,
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

// excludedSettingKeys 导出时排除的键，会原样写进导出文件里（让用户知道漏了哪些、为什么）。
func excludedSettingKeys() []string {
	return []string{
		keyAIAPIKey,
		keyAIProviders,
		keyNotifyBarkURL,
		keyRSSHubAccessKey,
		keyNetworkPassword,
		keyUserPasswordHash,
		keyUserJWTSecret,
		// 站点会话 cookie：按前缀整体排除（anubis.cookie.<host>）
		"anubis.cookie.*",
	}
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
