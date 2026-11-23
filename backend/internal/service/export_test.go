package service

import (
	"context"
	"net/http"
	"time"
)

// Export for testing
var IsValidURL = isValidURL
var HasDynamicTime = hasDynamicTime
var ExtractDateFromSummary = extractDateFromSummary
var ExtractPublishedAt = extractPublishedAt
var ExtractThumbnail = extractThumbnail
var ComputeEntryHash = computeEntryHash
var OptionalString = optionalString
var BuildPreviewEntries = buildPreviewEntries
var WalkTree = walkTree
var BuildReferer = buildReferer
var IsValidHost = isValidHost
var DefaultAppearanceContentTypes = defaultAppearanceContentTypes
var MaskAPIKey = maskAPIKey
var IsMaskedKey = isMaskedKey

const (
	KeyAISummaryLanguage   = keyAISummaryLanguage
	KeyUserUsername        = keyUserUsername
	KeyUserNickname        = keyUserNickname
	KeyUserEmail           = keyUserEmail
	KeyUserPasswordHash    = keyUserPasswordHash
	KeyUserJWTSecret       = keyUserJWTSecret
	KeyAIProvider          = keyAIProvider
	KeyAIProviders         = keyAIProviders
	KeyAIActiveProvider    = keyAIActiveProvider
	KeyAIAPIKey            = keyAIAPIKey
	KeyAIBaseURL           = keyAIBaseURL
	KeyAIModel             = keyAIModel
	KeyAIRequestOptions    = keyAIRequestOptions
	KeyAIAutoTranslate     = keyAIAutoTranslate
	KeyAIAutoSummary       = keyAIAutoSummary
	KeyAIRateLimit         = keyAIRateLimit
	KeyAITranslateChannel  = keyAITranslateChannel
	KeyAITranslateChannels = keyAITranslateChannels
	KeyAIUseProxy          = keyAIUseProxy
	KeyMarkReadOnScroll    = keyMarkReadOnScroll
	KeyNetworkEnabled      = keyNetworkEnabled
	KeyNetworkType         = keyNetworkType
	KeyNetworkHost         = keyNetworkHost
	KeyNetworkPort         = keyNetworkPort
	KeyNetworkUsername     = keyNetworkUsername
	KeyNetworkPassword     = keyNetworkPassword
	KeyNetworkIPStack      = keyNetworkIPStack
	KeyFallbackUserAgent   = keyFallbackUserAgent
	// 21 批：界面设置整包（键名是对外契约，测试里钉死）
	KeyUISettings     = keyUISettings
	KeyUITheme        = keyUITheme
	KeyUILang         = keyUILang
	KeyUISidebarState = keyUISidebarState
	// 1123：缓存清理设置键（对外契约，测试里钉死）
	KeyCacheEntryRetentionDays     = keyCacheEntryRetentionDays
	KeyCacheTombstoneRetentionDays = keyCacheTombstoneRetentionDays
)

var (
	ErrUsernameRequiredHelper        = ErrUsernameRequired
	ErrInvalidUsernameHelper         = ErrInvalidUsername
	ErrEmailRequiredHelper           = ErrEmailRequired
	ErrPasswordRequiredHelper        = ErrPasswordRequired
	ErrPasswordTooShortHelper        = ErrPasswordTooShort
	ErrUserExistsHelper              = ErrUserExists
	ErrUserNotFoundHelper            = ErrUserNotFound
	ErrInvalidPasswordHelper         = ErrInvalidPassword
	ErrCurrentPasswordRequiredHelper = ErrCurrentPasswordRequired
	ErrSamePasswordHelper            = ErrSamePassword
	ErrInvalidTokenHelper            = ErrInvalidToken
)

// ProbeHTTPClientForTest exposes the settings probe client (nil = 直连) for tests.
func ProbeHTTPClientForTest(svc SettingsService, ctx context.Context, timeout time.Duration) *http.Client {
	if ss, ok := svc.(*settingsService); ok {
		return ss.probeHTTPClient(ctx, timeout)
	}
	return nil
}

// AIProxyEnabledForTest exposes aiService.aiProxyEnabled for tests.
func AIProxyEnabledForTest(svc AIService, ctx context.Context) bool {
	if s, ok := svc.(*aiService); ok {
		return s.aiProxyEnabled(ctx)
	}
	return false
}

// Refresh service helpers for tests.
func SetRefreshServiceRefreshing(s RefreshService, v bool) {
	if rs, ok := s.(*refreshService); ok {
		rs.isRefreshing = v
	}
}

func BuildAISummarizeSystemPromptForTest(s AIService, ctx context.Context, entryID int64, title string) string {
	if svc, ok := s.(*aiService); ok {
		return svc.buildSummarizeSystemPrompt(ctx, entryID, title)
	}
	return ""
}

// Export for testing
var SliceByRange = sliceByRange

// 插件运行时安全（fix/plugin-runtime）：黑盒测试用的窄口。
var PluginChildEnv = pluginChildEnv
var OpenPluginLog = openPluginLog

// PluginLogMaxBytesForTest 读当前 plugin.log 轮转阈值。
func PluginLogMaxBytesForTest() int64 { return pluginLogMaxBytes }

// SetPluginLogMaxBytesForTest 改 plugin.log 轮转阈值（返回还原函数，测试结束调）。
func SetPluginLogMaxBytesForTest(n int64) (restore func()) {
	old := pluginLogMaxBytes
	pluginLogMaxBytes = n
	return func() { pluginLogMaxBytes = old }
}

// ExcludedSettingKeysForTest 导出排除名单（55-22 守门测试：插件 secret 键必须都在里面）。
func ExcludedSettingKeysForTest() []string { return excludedSettingKeys() }
