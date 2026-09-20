package http_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"krss/backend/internal/handler"
	gh "krss/backend/internal/http"
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

func hasRoute(e *echo.Echo, method, path string) bool {
	for _, r := range e.Routes() {
		if r.Method == method && r.Path == path {
			return true
		}
	}
	return false
}
