package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"

	"gist/backend/internal/service"
	"gist/backend/pkg/logger"
	"gist/backend/pkg/network"
)

// Request/Response types

type aiSettingsResponse struct {
	Provider        string         `json:"provider"`
	APIKey          string         `json:"apiKey"`
	BaseURL         string         `json:"baseUrl"`
	Model           string         `json:"model"`
	RequestOptions  map[string]any `json:"requestOptions"`
	SummaryLanguage string         `json:"summaryLanguage"`
	AutoTranslate   bool           `json:"autoTranslate"`
	AutoSummary     bool           `json:"autoSummary"`
	RateLimit       int            `json:"rateLimit"`
	// TranslateChannel：空 = 翻译走模型；google/youdao = 免 key 通道
	TranslateChannel string `json:"translateChannel"`
	// FallbackToModel：免费通道失败时是否自动切回模型
	FallbackToModel  bool                       `json:"fallbackToModel"`
	Providers        []service.AIProviderConfig `json:"providers"`
	ActiveProviderID string                     `json:"activeProviderId"`
}

type aiSettingsRequest struct {
	Provider        string         `json:"provider"`
	APIKey          string         `json:"apiKey"`
	BaseURL         string         `json:"baseUrl"`
	Model           string         `json:"model"`
	RequestOptions  map[string]any `json:"requestOptions"`
	SummaryLanguage string         `json:"summaryLanguage"`
	AutoTranslate   bool           `json:"autoTranslate"`
	AutoSummary     bool           `json:"autoSummary"`
	RateLimit       int            `json:"rateLimit"`
	// TranslateChannel：空 = 翻译走模型；google/youdao = 免 key 通道
	TranslateChannel string `json:"translateChannel"`
	// FallbackToModel：免费通道失败时是否自动切回模型
	FallbackToModel  bool                       `json:"fallbackToModel"`
	Providers        []service.AIProviderConfig `json:"providers"`
	ActiveProviderID string                     `json:"activeProviderId"`
}

type aiTestRequest struct {
	Provider       string         `json:"provider"`
	APIKey         string         `json:"apiKey"`
	BaseURL        string         `json:"baseUrl"`
	Model          string         `json:"model"`
	RequestOptions map[string]any `json:"requestOptions"`
}

type aiTestResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

type generalSettingsResponse struct {
	FallbackUserAgent string `json:"fallbackUserAgent"`
	AutoReadability   bool   `json:"autoReadability"`
	MarkReadOnScroll  bool   `json:"markReadOnScroll"`
	// RSSHub 自有实例（添加订阅时自动换域名用）——不回这两个字段的话界面每次打开都是空的
	RSSHubBaseURL   string `json:"rsshubBaseUrl"`
	RSSHubAccessKey string `json:"rsshubAccessKey"`
	// BarkURL 推送地址（自动化规则的「推送到手机」没单独填地址时用它）
	BarkURL string `json:"barkUrl"`
}

type generalSettingsRequest struct {
	FallbackUserAgent string `json:"fallbackUserAgent"`
	AutoReadability   bool   `json:"autoReadability"`
	MarkReadOnScroll  bool   `json:"markReadOnScroll"`
	RSSHubBaseURL     string `json:"rsshubBaseUrl"`
	RSSHubAccessKey   string `json:"rsshubAccessKey"`
	BarkURL           string `json:"barkUrl"`
}

type networkSettingsResponse struct {
	Enabled  bool   `json:"enabled"`
	Type     string `json:"type"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	IPStack  string `json:"ipStack"`
}

type networkSettingsRequest struct {
	Enabled  bool   `json:"enabled"`
	Type     string `json:"type"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	IPStack  string `json:"ipStack"`
}

type networkTestRequest struct {
	Enabled  bool   `json:"enabled"`
	Type     string `json:"type"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type networkTestResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}

type appearanceSettingsResponse struct {
	ContentTypes []string `json:"contentTypes"`
}

type appearanceSettingsRequest struct {
	ContentTypes []string `json:"contentTypes"`
}

// ---------- 21 批：界面设置整包 + 设置导出/导入 ----------

// uiThemePayload 主题三件套（与前端 useTheme 的三项一一对应）。
type uiThemePayload struct {
	Mode       string `json:"mode"`
	LightTheme string `json:"lightTheme"`
	DarkTheme  string `json:"darkTheme"`
}

// uiSettingsResponse 界面设置整包。
// ui / sidebarState 是**原样透传**的 JSON（后端不给前端字段建模，避免 DTO 少字段导致设置静默失效）。
type uiSettingsResponse struct {
	UI           json.RawMessage `json:"ui"`
	Theme        uiThemePayload  `json:"theme"`
	Lang         string          `json:"lang"`
	SidebarState json.RawMessage `json:"sidebarState"`
	UpdatedAt    string          `json:"updatedAt,omitempty"`
	// Empty：服务端一条都没存过（前端据此把本地那份当基线推上来）
	Empty bool `json:"empty"`
}

// uiSettingsRequest 只写传进来的项：theme / lang / sidebarState / ui 各自独立，缺省即不动。
type uiSettingsRequest struct {
	UI           json.RawMessage `json:"ui"`
	Theme        *uiThemePayload `json:"theme"`
	Lang         string          `json:"lang"`
	SidebarState json.RawMessage `json:"sidebarState"`
}

// settingsImportResponse 导入结果（imported = 实际写入的键数）。
type settingsImportResponse struct {
	Imported int `json:"imported"`
}

type SettingsHandler struct {
	service       service.SettingsService
	clientFactory *network.ClientFactory
}

// isFreeTranslateChannel：免 key 翻译通道（与 internal/service/ai 里的常量保持一致）
func isFreeTranslateChannel(channel string) bool {
	return channel == "google" || channel == "youdao"
}

func isBaseURLRequiredForProvider(provider string) bool {
	return provider == "openai" || provider == "compatible"
}

func NewSettingsHandler(service service.SettingsService, clientFactory *network.ClientFactory) *SettingsHandler {
	return &SettingsHandler{service: service, clientFactory: clientFactory}
}

type deletedCountResponse struct {
	Deleted int64 `json:"deleted"`
}

// writeSettingsSaveError 把「字段值不合法」和「真出错了」分开。
//
// 以前保存接口一律 500：用户填了个没协议头的地址（例如 `api.day.app/xxx`）时，
// 界面只会显示「保存失败/内部错误」，看不出到底哪里不对。校验本来就在 service 里做了
// （返回 ErrInvalid），这里把它翻成 400 + 一句可执行的提示。
func writeSettingsSaveError(c echo.Context, err error, action string) error {
	if errors.Is(err, service.ErrInvalid) {
		return c.JSON(http.StatusBadRequest, errorResponse{
			Error: "invalid settings value: check the URL fields (must start with http:// or https://)",
		})
	}
	logger.Error("settings save failed", "module", "handler", "action", action, "resource", "settings", "result", "failed", "error", err)
	return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to save settings"})
}

func (h *SettingsHandler) RegisterRoutes(g *echo.Group) {
	g.GET("/settings/ai", h.GetAISettings)
	g.PUT("/settings/ai", h.UpdateAISettings)
	g.POST("/settings/ai/test", h.TestAI)
	g.POST("/settings/ai/models", h.ListAIModels)
	g.GET("/settings/general", h.GetGeneralSettings)
	g.PUT("/settings/general", h.UpdateGeneralSettings)
	// 拉取（11-20）：定时频率 / 全局并发 / 同主机并发 / 单源超时
	g.GET("/settings/fetch", h.GetFetchSettings)
	g.PUT("/settings/fetch", h.UpdateFetchSettings)
	g.GET("/settings/network", h.GetNetworkSettings)
	g.PUT("/settings/network", h.UpdateNetworkSettings)
	g.POST("/settings/network/test", h.TestNetworkProxy)
	g.GET("/settings/appearance", h.GetAppearanceSettings)
	g.PUT("/settings/appearance", h.UpdateAppearanceSettings)
	// 界面设置整包（21 批）：跨设备/换浏览器/清缓存都不丢
	g.GET("/settings/ui", h.GetUISettings)
	g.PUT("/settings/ui", h.UpdateUISettings)
	// 设置导出/导入（21 批）：凭证类不导出，导入只认白名单键
	g.GET("/settings/export", h.ExportSettings)
	g.POST("/settings/import", h.ImportSettings)
	g.DELETE("/settings/anubis-cookies", h.ClearAnubisCookies)
}

// GetAISettings returns the AI configuration.
// @Summary Get AI settings
// @Description Get the AI provider configuration with masked API keys
// @Tags settings
// @Produce json
// @Success 200 {object} aiSettingsResponse
// @Failure 500 {object} errorResponse
// @Router /settings/ai [get]
func (h *SettingsHandler) GetAISettings(c echo.Context) error {
	settings, err := h.service.GetAISettings(c.Request().Context())
	if err != nil {
		logger.Error("ai settings get failed", "module", "handler", "action", "list", "resource", "settings", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to get settings"})
	}

	return c.JSON(http.StatusOK, aiSettingsResponse{
		Provider:         settings.Provider,
		APIKey:           settings.APIKey,
		BaseURL:          settings.BaseURL,
		Model:            settings.Model,
		RequestOptions:   settings.RequestOptions,
		SummaryLanguage:  settings.SummaryLanguage,
		AutoTranslate:    settings.AutoTranslate,
		AutoSummary:      settings.AutoSummary,
		RateLimit:        settings.RateLimit,
		TranslateChannel: settings.TranslateChannel,
		FallbackToModel:  settings.FallbackToModel,

		Providers:        settings.Providers,
		ActiveProviderID: settings.ActiveProviderID,
	})
}

// UpdateAISettings updates the AI configuration.
// @Summary Update AI settings
// @Description Update the AI provider configuration. Empty apiKey keeps existing key.
// @Tags settings
// @Accept json
// @Produce json
// @Param settings body aiSettingsRequest true "AI settings"
// @Success 200 {object} aiSettingsResponse
// @Failure 400 {object} errorResponse
// @Failure 500 {object} errorResponse
// @Router /settings/ai [put]
func (h *SettingsHandler) UpdateAISettings(c echo.Context) error {
	var req aiSettingsRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	// 选了免 key 翻译通道时，可以完全不配模型（翻译能用，摘要才需要模型）
	freeTranslateOnly := isFreeTranslateChannel(req.TranslateChannel) && req.Provider == "" && req.Model == ""
	if !freeTranslateOnly {
		if req.Provider == "" {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "provider is required"})
		}
		if req.Model == "" {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "model is required"})
		}
		if isBaseURLRequiredForProvider(req.Provider) && req.BaseURL == "" {
			return c.JSON(http.StatusBadRequest, errorResponse{Error: "baseUrl is required"})
		}
	}

	settings := &service.AISettings{
		Provider:         req.Provider,
		APIKey:           req.APIKey,
		BaseURL:          req.BaseURL,
		Model:            req.Model,
		RequestOptions:   req.RequestOptions,
		SummaryLanguage:  req.SummaryLanguage,
		AutoTranslate:    req.AutoTranslate,
		AutoSummary:      req.AutoSummary,
		RateLimit:        req.RateLimit,
		TranslateChannel: req.TranslateChannel,
		FallbackToModel:  req.FallbackToModel,

		Providers:        req.Providers,
		ActiveProviderID: req.ActiveProviderID,
	}

	if err := h.service.SetAISettings(c.Request().Context(), settings); err != nil {
		return writeSettingsSaveError(c, err, "update")
	}

	logger.Info("ai settings updated", "module", "handler", "action", "update", "resource", "settings", "result", "ok", "provider", req.Provider)
	// Return updated settings (with masked keys)
	return h.GetAISettings(c)
}

// TestAI tests the AI connection.
// @Summary Test AI connection
// @Description Test the AI provider connection with a "Hello world" message
// @Tags settings
// @Accept json
// @Produce json
// @Param config body aiTestRequest true "AI test configuration"
// @Success 200 {object} aiTestResponse
// @Failure 400 {object} errorResponse
// @Router /settings/ai/test [post]
func (h *SettingsHandler) TestAI(c echo.Context) error {
	var req aiTestRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}

	if req.Provider == "" {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "provider is required"})
	}
	if req.Model == "" {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "model is required"})
	}
	if isBaseURLRequiredForProvider(req.Provider) && req.BaseURL == "" {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "baseUrl is required"})
	}
	response, err := h.service.TestAI(c.Request().Context(), req.Provider, req.APIKey, req.BaseURL, req.Model, req.RequestOptions)
	if err != nil {
		logger.Warn("ai settings test failed", "module", "handler", "action", "test", "resource", "settings", "result", "failed", "provider", req.Provider, "error", err)
		return c.JSON(http.StatusOK, aiTestResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	logger.Info("ai settings test ok", "module", "handler", "action", "test", "resource", "settings", "result", "ok", "provider", req.Provider)
	return c.JSON(http.StatusOK, aiTestResponse{
		Success: true,
		Message: response,
	})
}

type aiModelsRequest struct {
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey"`
	BaseURL  string `json:"baseUrl"`
}

type aiModelsResponse struct {
	Models []string `json:"models"`
}

// ListAIModels 查询提供商可用模型（用于设置页的「探测模型」）。
//
// @Summary List provider models
// @Description Fetch the model list from an OpenAI-compatible / Anthropic endpoint
// @Tags settings
// @Accept json
// @Produce json
// @Param config body aiModelsRequest true "Provider credentials"
// @Success 200 {object} aiModelsResponse
// @Failure 400 {object} errorResponse
// @Router /settings/ai/models [post]
func (h *SettingsHandler) ListAIModels(c echo.Context) error {
	var req aiModelsRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	if req.Provider == "" {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "provider is required"})
	}

	models, err := h.service.ListAIModels(c.Request().Context(), req.Provider, req.APIKey, req.BaseURL)
	if err != nil {
		logger.Warn("ai models probe failed", "module", "handler", "action", "list", "resource", "settings", "result", "failed", "provider", req.Provider, "error", err)
		return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
	}

	logger.Info("ai models probed", "module", "handler", "action", "list", "resource", "settings", "result", "ok", "provider", req.Provider, "count", len(models))
	return c.JSON(http.StatusOK, aiModelsResponse{Models: models})
}

// GetGeneralSettings returns the general settings.
// @Summary Get general settings
// @Description Get general application settings including fallback user agent, auto readability, and mark-read-on-scroll
// @Tags settings
// @Produce json
// @Success 200 {object} generalSettingsResponse
// @Failure 500 {object} errorResponse
// @Router /settings/general [get]
func (h *SettingsHandler) GetGeneralSettings(c echo.Context) error {
	settings, err := h.service.GetGeneralSettings(c.Request().Context())
	if err != nil {
		logger.Error("general settings get failed", "module", "handler", "action", "list", "resource", "settings", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to get settings"})
	}

	return c.JSON(http.StatusOK, generalSettingsResponse{
		FallbackUserAgent: settings.FallbackUserAgent,
		AutoReadability:   settings.AutoReadability,
		MarkReadOnScroll:  settings.MarkReadOnScroll,
		RSSHubBaseURL:     settings.RSSHubBaseURL,
		RSSHubAccessKey:   settings.RSSHubAccessKey,
		BarkURL:           settings.BarkURL,
	})
}

// UpdateGeneralSettings updates the general settings.
// @Summary Update general settings
// @Description Update general application settings
// @Tags settings
// @Accept json
// @Produce json
// @Param settings body generalSettingsRequest true "General settings"
// @Success 200 {object} generalSettingsResponse
// @Failure 400 {object} errorResponse
// @Failure 500 {object} errorResponse
// @Router /settings/general [put]
func (h *SettingsHandler) UpdateGeneralSettings(c echo.Context) error {
	var req generalSettingsRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}

	settings := &service.GeneralSettings{
		FallbackUserAgent: req.FallbackUserAgent,
		AutoReadability:   req.AutoReadability,
		MarkReadOnScroll:  req.MarkReadOnScroll,
		RSSHubBaseURL:     req.RSSHubBaseURL,
		RSSHubAccessKey:   req.RSSHubAccessKey,
		BarkURL:           req.BarkURL,
	}

	if err := h.service.SetGeneralSettings(c.Request().Context(), settings); err != nil {
		return writeSettingsSaveError(c, err, "update")
	}

	logger.Info("general settings updated", "module", "handler", "action", "update", "resource", "settings", "result", "ok")
	return h.GetGeneralSettings(c)
}

// fetchSettingsResponse 拉取设置（11-20）。
type fetchSettingsResponse struct {
	IntervalMinutes    int `json:"intervalMinutes"`
	Concurrency        int `json:"concurrency"`
	PerHostConcurrency int `json:"perHostConcurrency"`
	TimeoutSeconds     int `json:"timeoutSeconds"`
}

// GetFetchSettings 读拉取设置（未配置的字段为默认值）。
// @Summary Get fetch settings
// @Description Refresh interval / concurrency / timeout. Values take effect on the next round.
// @Tags settings
// @Produce json
// @Success 200 {object} fetchSettingsResponse
// @Failure 500 {object} errorResponse
// @Router /settings/fetch [get]
func (h *SettingsHandler) GetFetchSettings(c echo.Context) error {
	settings, err := h.service.GetFetchSettings(c.Request().Context())
	if err != nil {
		logger.Error("fetch settings get failed", "module", "handler", "action", "list", "resource", "settings", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to get settings"})
	}
	return c.JSON(http.StatusOK, fetchSettingsResponse{
		IntervalMinutes:    settings.IntervalMinutes,
		Concurrency:        settings.Concurrency,
		PerHostConcurrency: settings.PerHostConcurrency,
		TimeoutSeconds:     settings.TimeoutSeconds,
	})
}

// UpdateFetchSettings 改拉取设置：只写传进来的字段（>0），越界会被夹到合法区间。
// @Summary Update fetch settings
// @Description Partial update: only fields > 0 are written. Applies from the next refresh round.
// @Tags settings
// @Accept json
// @Produce json
// @Param settings body fetchSettingsResponse true "Fetch settings"
// @Success 200 {object} fetchSettingsResponse
// @Failure 400 {object} errorResponse
// @Router /settings/fetch [put]
func (h *SettingsHandler) UpdateFetchSettings(c echo.Context) error {
	var req fetchSettingsResponse
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}
	if err := h.service.SetFetchSettings(c.Request().Context(), &service.FetchSettings{
		IntervalMinutes:    req.IntervalMinutes,
		Concurrency:        req.Concurrency,
		PerHostConcurrency: req.PerHostConcurrency,
		TimeoutSeconds:     req.TimeoutSeconds,
	}); err != nil {
		return writeSettingsSaveError(c, err, "update")
	}
	logger.Info("fetch settings updated", "module", "handler", "action", "update", "resource", "settings", "result", "ok")
	return h.GetFetchSettings(c)
}

// ClearAnubisCookies deletes all Anubis cookies from settings.
// @Summary Clear Anubis cookies
// @Description Delete all Anubis challenge cookies used for bypassing protection
// @Tags settings
// @Produce json
// @Success 200 {object} deletedCountResponse
// @Failure 500 {object} errorResponse
// @Router /settings/anubis-cookies [delete]
func (h *SettingsHandler) ClearAnubisCookies(c echo.Context) error {
	deleted, err := h.service.ClearAnubisCookies(c.Request().Context())
	if err != nil {
		logger.Error("anubis cookies clear failed", "module", "handler", "action", "clear", "resource", "settings", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: err.Error()})
	}

	logger.Info("anubis cookies cleared", "module", "handler", "action", "clear", "resource", "settings", "result", "ok", "count", deleted)
	return c.JSON(http.StatusOK, deletedCountResponse{Deleted: deleted})
}

// GetNetworkSettings returns the network proxy configuration.
// @Summary Get network settings
// @Description Get the network proxy configuration with masked password
// @Tags settings
// @Produce json
// @Success 200 {object} networkSettingsResponse
// @Failure 500 {object} errorResponse
// @Router /settings/network [get]
func (h *SettingsHandler) GetNetworkSettings(c echo.Context) error {
	settings, err := h.service.GetNetworkSettings(c.Request().Context())
	if err != nil {
		logger.Error("network settings get failed", "module", "handler", "action", "list", "resource", "settings", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to get settings"})
	}

	return c.JSON(http.StatusOK, networkSettingsResponse{
		Enabled:  settings.Enabled,
		Type:     settings.Type,
		Host:     settings.Host,
		Port:     settings.Port,
		Username: settings.Username,
		Password: settings.Password,
		IPStack:  settings.IPStack,
	})
}

// UpdateNetworkSettings updates the network proxy configuration.
// @Summary Update network settings
// @Description Update the network proxy configuration. Empty password keeps existing password.
// @Tags settings
// @Accept json
// @Produce json
// @Param settings body networkSettingsRequest true "Network settings"
// @Success 200 {object} networkSettingsResponse
// @Failure 400 {object} errorResponse
// @Failure 500 {object} errorResponse
// @Router /settings/network [put]
func (h *SettingsHandler) UpdateNetworkSettings(c echo.Context) error {
	var req networkSettingsRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}

	settings := &service.NetworkSettings{
		Enabled:  req.Enabled,
		Type:     req.Type,
		Host:     req.Host,
		Port:     req.Port,
		Username: req.Username,
		Password: req.Password,
		IPStack:  req.IPStack,
	}

	if err := h.service.SetNetworkSettings(c.Request().Context(), settings); err != nil {
		return writeSettingsSaveError(c, err, "update")
	}

	logger.Info("network settings updated", "module", "handler", "action", "update", "resource", "settings", "result", "ok", "enabled", req.Enabled, "type", req.Type)
	return h.GetNetworkSettings(c)
}

// GetAppearanceSettings returns the appearance settings.
// @Summary Get appearance settings
// @Description Get appearance settings including visible content types
// @Tags settings
// @Produce json
// @Success 200 {object} appearanceSettingsResponse
// @Failure 500 {object} errorResponse
// @Router /settings/appearance [get]
func (h *SettingsHandler) GetAppearanceSettings(c echo.Context) error {
	settings, err := h.service.GetAppearanceSettings(c.Request().Context())
	if err != nil {
		logger.Error("appearance settings get failed", "module", "handler", "action", "list", "resource", "settings", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to get settings"})
	}

	return c.JSON(http.StatusOK, appearanceSettingsResponse{ContentTypes: settings.ContentTypes})
}

// UpdateAppearanceSettings updates the appearance settings.
// @Summary Update appearance settings
// @Description Update appearance settings including visible content types
// @Tags settings
// @Accept json
// @Produce json
// @Param settings body appearanceSettingsRequest true "Appearance settings"
// @Success 200 {object} appearanceSettingsResponse
// @Failure 400 {object} errorResponse
// @Failure 500 {object} errorResponse
// @Router /settings/appearance [put]
func (h *SettingsHandler) UpdateAppearanceSettings(c echo.Context) error {
	var req appearanceSettingsRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}

	settings := &service.AppearanceSettings{ContentTypes: req.ContentTypes}
	if err := h.service.SetAppearanceSettings(c.Request().Context(), settings); err != nil {
		logger.Error("appearance settings update failed", "module", "handler", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return writeServiceError(c, err)
	}

	logger.Info("appearance settings updated", "module", "handler", "action", "update", "resource", "settings", "result", "ok")
	return h.GetAppearanceSettings(c)
}

// TestNetworkProxy tests the network proxy connection.
// @Summary Test network proxy
// @Description Test the network proxy connection by accessing https://captive.apple.com/
// @Tags settings
// @Accept json
// @Produce json
// @Param config body networkTestRequest true "Network test configuration"
// @Success 200 {object} networkTestResponse
// @Failure 400 {object} errorResponse
// @Router /settings/network/test [post]
func (h *SettingsHandler) TestNetworkProxy(c echo.Context) error {
	var req networkTestRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}

	if !req.Enabled {
		return c.JSON(http.StatusOK, networkTestResponse{
			Success: true,
			Message: "Proxy is disabled, direct connection will be used",
		})
	}

	if req.Host == "" {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "host is required"})
	}
	if req.Port <= 0 {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "valid port is required"})
	}

	// Build proxy URL from request
	proxyType := req.Type
	if proxyType == "" {
		proxyType = "http"
	}
	var proxyURL string
	if req.Username != "" && req.Password != "" {
		proxyURL = proxyType + "://" + req.Username + ":" + req.Password + "@" + req.Host + ":" + itoa(req.Port)
	} else {
		proxyURL = proxyType + "://" + req.Host + ":" + itoa(req.Port)
	}

	// Test proxy connection using https://captive.apple.com/
	const testURL = "https://captive.apple.com/"
	err := h.clientFactory.TestProxyWithConfig(c.Request().Context(), proxyURL, testURL)
	if err != nil {
		logger.Warn("network proxy test failed", "module", "handler", "action", "test", "resource", "settings", "result", "failed", "type", proxyType, "host", req.Host, "error", err)
		return c.JSON(http.StatusOK, networkTestResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	logger.Info("network proxy test ok", "module", "handler", "action", "test", "resource", "settings", "result", "ok", "type", proxyType, "host", req.Host)
	return c.JSON(http.StatusOK, networkTestResponse{
		Success: true,
		Message: "Proxy connection successful",
	})
}

// GetUISettings 读界面设置整包（21 批）。
// @Summary Get UI settings
// @Description Get the UI settings package (shared fields + per-device sizes)
// @Tags settings
// @Produce json
// @Success 200 {object} uiSettingsResponse
// @Failure 500 {object} errorResponse
// @Router /settings/ui [get]
func (h *SettingsHandler) GetUISettings(c echo.Context) error {
	settings, err := h.service.GetUISettings(c.Request().Context())
	if err != nil {
		logger.Error("ui settings get failed", "module", "handler", "action", "list", "resource", "settings", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to get settings"})
	}

	return c.JSON(http.StatusOK, uiSettingsToResponse(settings))
}

// UpdateUISettings 写界面设置整包（只写传进来的项）。
// @Summary Update UI settings
// @Description Update the UI settings package; omitted fields are left untouched
// @Tags settings
// @Accept json
// @Produce json
// @Param settings body uiSettingsRequest true "UI settings"
// @Success 200 {object} uiSettingsResponse
// @Failure 400 {object} errorResponse
// @Failure 500 {object} errorResponse
// @Router /settings/ui [put]
func (h *SettingsHandler) UpdateUISettings(c echo.Context) error {
	var req uiSettingsRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}

	payload := &service.UISettings{
		UI:           req.UI,
		Lang:         req.Lang,
		SidebarState: req.SidebarState,
	}
	if req.Theme != nil {
		payload.Theme = service.UIThemeSettings{
			Mode:       req.Theme.Mode,
			LightTheme: req.Theme.LightTheme,
			DarkTheme:  req.Theme.DarkTheme,
		}
	}

	if err := h.service.SetUISettings(c.Request().Context(), payload); err != nil {
		if errors.Is(err, service.ErrInvalid) {
			// 这里不走 writeSettingsSaveError：那句话是给「URL 字段」写的，界面设置的错因不一样
			return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
		}
		logger.Error("ui settings save failed", "module", "handler", "action", "update", "resource", "settings", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to save settings"})
	}

	logger.Info("ui settings updated", "module", "handler", "action", "update", "resource", "settings", "result", "ok")
	return h.GetUISettings(c)
}

// ExportSettings 导出设置（凭证类排除，排除的键名写在文件里）。
// @Summary Export settings
// @Description Export settings as a readable JSON file; credential keys are excluded
// @Tags settings
// @Produce json
// @Success 200 {object} service.SettingsExport
// @Failure 500 {object} errorResponse
// @Router /settings/export [get]
func (h *SettingsHandler) ExportSettings(c echo.Context) error {
	payload, err := h.service.ExportSettings(c.Request().Context())
	if err != nil {
		logger.Error("settings export failed", "module", "handler", "action", "export", "resource", "settings", "result", "failed", "error", err)
		return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to export settings"})
	}

	logger.Info("settings exported", "module", "handler", "action", "export", "resource", "settings", "result", "ok", "count", len(payload.Settings))
	// 直接命中这个地址时会存成文件（凭这个头），前端也用它做「导出文件名」
	c.Response().Header().Set("Content-Disposition", `attachment; filename="krss-settings.json"`)
	return c.JSON(http.StatusOK, payload)
}

// ImportSettings 导入设置：只接受白名单键，整体覆盖。
// @Summary Import settings
// @Description Import settings from a previously exported file; unknown keys are rejected
// @Tags settings
// @Accept json
// @Produce json
// @Param settings body service.SettingsExport true "Settings export payload"
// @Success 200 {object} settingsImportResponse
// @Failure 400 {object} errorResponse
// @Failure 500 {object} errorResponse
// @Router /settings/import [post]
func (h *SettingsHandler) ImportSettings(c echo.Context) error {
	var payload service.SettingsExport
	if err := c.Bind(&payload); err != nil {
		return c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request"})
	}

	if err := h.service.ImportSettings(c.Request().Context(), &payload); err != nil {
		switch {
		case errors.Is(err, service.ErrUnknownSettingKey):
			// 把「到底哪个键不认」说出来，别让用户猜
			return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
		case errors.Is(err, service.ErrInvalid):
			return c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
		default:
			logger.Error("settings import failed", "module", "handler", "action", "import", "resource", "settings", "result", "failed", "error", err)
			return c.JSON(http.StatusInternalServerError, errorResponse{Error: "failed to import settings"})
		}
	}

	logger.Info("settings imported", "module", "handler", "action", "import", "resource", "settings", "result", "ok", "count", len(payload.Settings))
	return c.JSON(http.StatusOK, settingsImportResponse{Imported: len(payload.Settings)})
}

func uiSettingsToResponse(settings *service.UISettings) uiSettingsResponse {
	if settings == nil {
		return uiSettingsResponse{UI: json.RawMessage("{}"), SidebarState: json.RawMessage("{}"), Empty: true}
	}

	resp := uiSettingsResponse{
		UI:           settings.UI,
		Lang:         settings.Lang,
		SidebarState: settings.SidebarState,
		Empty:        settings.Empty,
		Theme: uiThemePayload{
			Mode:       settings.Theme.Mode,
			LightTheme: settings.Theme.LightTheme,
			DarkTheme:  settings.Theme.DarkTheme,
		},
	}
	if !settings.UpdatedAt.IsZero() {
		resp.UpdatedAt = settings.UpdatedAt.UTC().Format(time.RFC3339)
	}
	if len(resp.UI) == 0 {
		resp.UI = json.RawMessage("{}")
	}
	if len(resp.SidebarState) == 0 {
		resp.SidebarState = json.RawMessage("{}")
	}
	return resp
}

func itoa(i int) string {
	return strconv.Itoa(i)
}
