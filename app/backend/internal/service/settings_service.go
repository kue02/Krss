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

// Setting keys
const (
	keyAIProvider        = "ai.provider"
	keyAIAPIKey          = "ai.api_key"
	keyAIBaseURL         = "ai.base_url"
	keyAIModel           = "ai.model"
	keyAIRequestOptions  = "ai.request_options"
	keyAISummaryLanguage = "ai.summary_language"
	keyAIAutoTranslate   = "ai.auto_translate"
	keyAIAutoSummary     = "ai.auto_summary"
	keyAIRateLimit       = "ai.rate_limit"
	keyAIProviders       = "ai.providers"
	keyAIActiveProvider  = "ai.active_provider_id"

	keyFallbackUserAgent = "general.fallback_user_agent"
	keyAutoReadability   = "general.auto_readability"
	keyMarkReadOnScroll  = "general.mark_read_on_scroll"
	keyRSSHubBaseURL     = "general.rsshub_base_url"
	keyRSSHubAccessKey   = "general.rsshub_access_key"
	keyNetworkEnabled    = "network.proxy_enabled"
	keyNetworkType       = "network.proxy_type"
	keyNetworkHost       = "network.proxy_host"
	keyNetworkPort       = "network.proxy_port"
	keyNetworkUsername   = "network.proxy_username"
	keyNetworkPassword   = "network.proxy_password"
	keyNetworkIPStack    = "network.ip_stack"

	keyAppearanceContentTypes = "appearance.content_types"
)

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
	// GetAppearanceSettings returns appearance settings.
	GetAppearanceSettings(ctx context.Context) (*AppearanceSettings, error)
	// SetAppearanceSettings updates appearance settings.
	SetAppearanceSettings(ctx context.Context, settings *AppearanceSettings) error
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
	return settings, nil
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

	if err := s.repo.SetMany(ctx, map[string]string{
		keyFallbackUserAgent: settings.FallbackUserAgent,
		keyAutoReadability:   autoReadabilityVal,
		keyMarkReadOnScroll:  markReadOnScrollVal,
		keyRSSHubBaseURL:     baseURL,
		keyRSSHubAccessKey:   strings.TrimSpace(settings.RSSHubAccessKey),
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
