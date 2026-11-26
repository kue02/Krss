package http_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"krss/backend/internal/handler"
	gh "krss/backend/internal/http"
	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"
	"krss/backend/pkg/network"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

func TestNewRouter_RegistersRoutes(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	folderService := mock.NewMockFolderService(ctrl)
	feedService := mock.NewMockFeedService(ctrl)
	entryService := mock.NewMockEntryService(ctrl)
	opmlService := mock.NewMockOPMLService(ctrl)
	iconService := mock.NewMockIconService(ctrl)
	proxyService := mock.NewMockProxyService(ctrl)
	settingsService := mock.NewMockSettingsService(ctrl)
	aiService := mock.NewMockAIService(ctrl)
	authService := mock.NewMockAuthService(ctrl)
	domainRateLimitService := mock.NewMockDomainRateLimitService(ctrl)
	refreshService := mock.NewMockRefreshService(ctrl)
	readabilityService := mock.NewMockReadabilityService(ctrl)
	importTaskService := mock.NewMockImportTaskService(ctrl)

	folderHandler := handler.NewFolderHandler(folderService)
	feedHandler := handler.NewFeedHandler(feedService, refreshService)
	entryHandler := handler.NewEntryHandler(entryService, readabilityService)
	opmlHandler := handler.NewOPMLHandler(opmlService, importTaskService)
	iconHandler := handler.NewIconHandler(iconService)
	proxyHandler := handler.NewProxyHandler(proxyService)
	settingsHandler := handler.NewSettingsHandler(settingsService, network.NewClientFactoryForTest(&http.Client{}))
	aiHandler := handler.NewAIHandler(aiService)
	authHandler := handler.NewAuthHandler(authService)
	domainRateLimitHandler := handler.NewDomainRateLimitHandler(domainRateLimitService)
	filterService := mock.NewMockFilterService(ctrl)
	filterHandler := handler.NewFilterHandler(filterService)
	proxySourceHandler := handler.NewProxySourceHandler(mock.NewMockProxySourceService(ctrl))
	mcpService := mock.NewMockMCPService(ctrl)
	mcpOutboundService := mock.NewMockMCPOutboundService(ctrl)
	mcpHandler := handler.NewMCPHandler(mcpService, mcpOutboundService)
	mcpEndpointHandler := handler.NewMCPEndpointHandler(mcpOutboundService)
	pluginHandler := handler.NewPluginHandler(mock.NewMockPluginService(ctrl))
	exportHandler := handler.NewExportHandler(service.NewExportService(mock.NewMockSettingsService(ctrl)))
	backupHandler := handler.NewBackupHandler(mock.NewMockBackupService(ctrl))

	e := gh.NewRouter(
		folderHandler,
		feedHandler,
		entryHandler,
		opmlHandler,
		iconHandler,
		proxyHandler,
		settingsHandler,
		aiHandler,
		authHandler,
		domainRateLimitHandler,
		filterHandler,
		proxySourceHandler,
		mcpHandler,
		mcpEndpointHandler,
		pluginHandler,
		exportHandler,
		backupHandler,
		handler.NewUpdateHandler(nil),
		authService,
		"",
		true,
	)

	require.NotNil(t, e)
	require.True(t, hasRoute(e, http.MethodGet, "/swagger/*"))
	require.True(t, hasRoute(e, http.MethodGet, "/api/feeds"))
	require.True(t, hasRoute(e, http.MethodGet, "/icons/:filename"))
	require.True(t, hasRoute(e, http.MethodGet, "/api/proxy/image/:encoded"))
	// 16/17 批：MCP 连接管理走登录态，出向端点 /mcp 走长期 token（不挂在 JWT 组里）
	require.True(t, hasRoute(e, http.MethodGet, "/api/mcp/servers"))
	require.True(t, hasRoute(e, http.MethodPost, "/api/mcp/servers/:id/inspect"))
	require.True(t, hasRoute(e, http.MethodGet, "/api/mcp/outbound"))
	require.True(t, hasRoute(e, http.MethodPost, "/mcp"))
	// 检查自身更新
	require.True(t, hasRoute(e, http.MethodGet, "/api/update/check"))
}

func TestNewRouter_SwaggerDisabled(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	folderService := mock.NewMockFolderService(ctrl)
	feedService := mock.NewMockFeedService(ctrl)
	entryService := mock.NewMockEntryService(ctrl)
	opmlService := mock.NewMockOPMLService(ctrl)
	iconService := mock.NewMockIconService(ctrl)
	proxyService := mock.NewMockProxyService(ctrl)
	settingsService := mock.NewMockSettingsService(ctrl)
	aiService := mock.NewMockAIService(ctrl)
	authService := mock.NewMockAuthService(ctrl)
	domainRateLimitService := mock.NewMockDomainRateLimitService(ctrl)
	refreshService := mock.NewMockRefreshService(ctrl)
	readabilityService := mock.NewMockReadabilityService(ctrl)
	importTaskService := mock.NewMockImportTaskService(ctrl)

	folderHandler := handler.NewFolderHandler(folderService)
	feedHandler := handler.NewFeedHandler(feedService, refreshService)
	entryHandler := handler.NewEntryHandler(entryService, readabilityService)
	opmlHandler := handler.NewOPMLHandler(opmlService, importTaskService)
	iconHandler := handler.NewIconHandler(iconService)
	proxyHandler := handler.NewProxyHandler(proxyService)
	settingsHandler := handler.NewSettingsHandler(settingsService, network.NewClientFactoryForTest(&http.Client{}))
	aiHandler := handler.NewAIHandler(aiService)
	authHandler := handler.NewAuthHandler(authService)
	domainRateLimitHandler := handler.NewDomainRateLimitHandler(domainRateLimitService)
	filterService := mock.NewMockFilterService(ctrl)
	filterHandler := handler.NewFilterHandler(filterService)
	proxySourceHandler := handler.NewProxySourceHandler(mock.NewMockProxySourceService(ctrl))
	mcpService := mock.NewMockMCPService(ctrl)
	mcpOutboundService := mock.NewMockMCPOutboundService(ctrl)
	mcpHandler := handler.NewMCPHandler(mcpService, mcpOutboundService)
	mcpEndpointHandler := handler.NewMCPEndpointHandler(mcpOutboundService)
	pluginHandler := handler.NewPluginHandler(mock.NewMockPluginService(ctrl))
	exportHandler := handler.NewExportHandler(service.NewExportService(mock.NewMockSettingsService(ctrl)))
	backupHandler := handler.NewBackupHandler(mock.NewMockBackupService(ctrl))

	e := gh.NewRouter(
		folderHandler,
		feedHandler,
		entryHandler,
		opmlHandler,
		iconHandler,
		proxyHandler,
		settingsHandler,
		aiHandler,
		authHandler,
		domainRateLimitHandler,
		filterHandler,
		proxySourceHandler,
		mcpHandler,
		mcpEndpointHandler,
		pluginHandler,
		exportHandler,
		backupHandler,
		handler.NewUpdateHandler(nil),
		authService,
		"",
		false,
	)

	require.NotNil(t, e)
	require.False(t, hasRoute(e, http.MethodGet, "/swagger/*"))
	require.True(t, hasRoute(e, http.MethodGet, "/api/feeds"))
	require.True(t, hasRoute(e, http.MethodGet, "/icons/:filename"))
	require.True(t, hasRoute(e, http.MethodGet, "/api/proxy/image/:encoded"))
}

func TestNewRouter_LogoutRouteIsPublic(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	folderService := mock.NewMockFolderService(ctrl)
	feedService := mock.NewMockFeedService(ctrl)
	entryService := mock.NewMockEntryService(ctrl)
	opmlService := mock.NewMockOPMLService(ctrl)
	iconService := mock.NewMockIconService(ctrl)
	proxyService := mock.NewMockProxyService(ctrl)
	settingsService := mock.NewMockSettingsService(ctrl)
	aiService := mock.NewMockAIService(ctrl)
	authService := mock.NewMockAuthService(ctrl)
	domainRateLimitService := mock.NewMockDomainRateLimitService(ctrl)
	refreshService := mock.NewMockRefreshService(ctrl)
	readabilityService := mock.NewMockReadabilityService(ctrl)
	importTaskService := mock.NewMockImportTaskService(ctrl)

	folderHandler := handler.NewFolderHandler(folderService)
	feedHandler := handler.NewFeedHandler(feedService, refreshService)
	entryHandler := handler.NewEntryHandler(entryService, readabilityService)
	opmlHandler := handler.NewOPMLHandler(opmlService, importTaskService)
	iconHandler := handler.NewIconHandler(iconService)
	proxyHandler := handler.NewProxyHandler(proxyService)
	settingsHandler := handler.NewSettingsHandler(settingsService, network.NewClientFactoryForTest(&http.Client{}))
	aiHandler := handler.NewAIHandler(aiService)
	authHandler := handler.NewAuthHandler(authService)
	domainRateLimitHandler := handler.NewDomainRateLimitHandler(domainRateLimitService)
	filterService := mock.NewMockFilterService(ctrl)
	filterHandler := handler.NewFilterHandler(filterService)
	proxySourceHandler := handler.NewProxySourceHandler(mock.NewMockProxySourceService(ctrl))
	mcpService := mock.NewMockMCPService(ctrl)
	mcpOutboundService := mock.NewMockMCPOutboundService(ctrl)
	mcpHandler := handler.NewMCPHandler(mcpService, mcpOutboundService)
	mcpEndpointHandler := handler.NewMCPEndpointHandler(mcpOutboundService)
	pluginHandler := handler.NewPluginHandler(mock.NewMockPluginService(ctrl))
	exportHandler := handler.NewExportHandler(service.NewExportService(mock.NewMockSettingsService(ctrl)))
	backupHandler := handler.NewBackupHandler(mock.NewMockBackupService(ctrl))

	e := gh.NewRouter(
		folderHandler,
		feedHandler,
		entryHandler,
		opmlHandler,
		iconHandler,
		proxyHandler,
		settingsHandler,
		aiHandler,
		authHandler,
		domainRateLimitHandler,
		filterHandler,
		proxySourceHandler,
		mcpHandler,
		mcpEndpointHandler,
		pluginHandler,
		exportHandler,
		backupHandler,
		handler.NewUpdateHandler(nil),
		authService,
		"",
		false,
	)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	rec := httptest.NewRecorder()

	e.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	cookies := rec.Result().Cookies()
	var authCookie *http.Cookie
	for _, cookie := range cookies {
		if cookie.Name == gh.AuthCookieName {
			authCookie = cookie
			break
		}
	}
	require.NotNil(t, authCookie)
	require.Equal(t, -1, authCookie.MaxAge)
}

// TestNewRouter_UpdateCheckRequiresAuth 检查自身更新的接口必须挂在登录态后面：
// 它是「服务端代打 GitHub」，匿名可调就等于把匿名配额（每小时 60 次）开放给任何人。
func TestNewRouter_UpdateCheckRequiresAuth(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	folderService := mock.NewMockFolderService(ctrl)
	feedService := mock.NewMockFeedService(ctrl)
	entryService := mock.NewMockEntryService(ctrl)
	opmlService := mock.NewMockOPMLService(ctrl)
	iconService := mock.NewMockIconService(ctrl)
	proxyService := mock.NewMockProxyService(ctrl)
	settingsService := mock.NewMockSettingsService(ctrl)
	aiService := mock.NewMockAIService(ctrl)
	authService := mock.NewMockAuthService(ctrl)
	// 坏 token 会走到 ValidateToken；这里只关心「有没有被拦在 handler 之前」。
	authService.EXPECT().ValidateToken(gomock.Any()).Return(false, nil).AnyTimes()
	domainRateLimitService := mock.NewMockDomainRateLimitService(ctrl)
	refreshService := mock.NewMockRefreshService(ctrl)
	readabilityService := mock.NewMockReadabilityService(ctrl)
	importTaskService := mock.NewMockImportTaskService(ctrl)

	folderHandler := handler.NewFolderHandler(folderService)
	feedHandler := handler.NewFeedHandler(feedService, refreshService)
	entryHandler := handler.NewEntryHandler(entryService, readabilityService)
	opmlHandler := handler.NewOPMLHandler(opmlService, importTaskService)
	iconHandler := handler.NewIconHandler(iconService)
	proxyHandler := handler.NewProxyHandler(proxyService)
	settingsHandler := handler.NewSettingsHandler(settingsService, network.NewClientFactoryForTest(&http.Client{}))
	aiHandler := handler.NewAIHandler(aiService)
	authHandler := handler.NewAuthHandler(authService)
	domainRateLimitHandler := handler.NewDomainRateLimitHandler(domainRateLimitService)
	filterHandler := handler.NewFilterHandler(mock.NewMockFilterService(ctrl))
	proxySourceHandler := handler.NewProxySourceHandler(mock.NewMockProxySourceService(ctrl))
	mcpOutboundService := mock.NewMockMCPOutboundService(ctrl)
	mcpHandler := handler.NewMCPHandler(mock.NewMockMCPService(ctrl), mcpOutboundService)
	mcpEndpointHandler := handler.NewMCPEndpointHandler(mcpOutboundService)
	pluginHandler := handler.NewPluginHandler(mock.NewMockPluginService(ctrl))
	exportHandler := handler.NewExportHandler(service.NewExportService(mock.NewMockSettingsService(ctrl)))
	backupHandler := handler.NewBackupHandler(mock.NewMockBackupService(ctrl))

	e := gh.NewRouter(
		folderHandler,
		feedHandler,
		entryHandler,
		opmlHandler,
		iconHandler,
		proxyHandler,
		settingsHandler,
		aiHandler,
		authHandler,
		domainRateLimitHandler,
		filterHandler,
		proxySourceHandler,
		mcpHandler,
		mcpEndpointHandler,
		pluginHandler,
		exportHandler,
		backupHandler,
		handler.NewUpdateHandler(nil),
		authService,
		"",
		false,
	)

	for _, tc := range []struct{ name, token, wantErr string }{
		{"no token", "", "missing authentication"},
		{"bad token", "not-a-real-token", "invalid token"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/update/check", nil)
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, req)
			require.Equal(t, http.StatusUnauthorized, rec.Code)
			require.Contains(t, rec.Body.String(), tc.wantErr)
		})
	}
}

func hasRoute(e *echo.Echo, method, path string) bool {
	for _, r := range e.Routes() {
		if r.Method == method && r.Path == path {
			return true
		}
	}
	return false
}
