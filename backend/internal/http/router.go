package http

import (
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	echoSwagger "github.com/swaggo/echo-swagger"

	_ "krss/backend/docs"
	"krss/backend/internal/handler"
	"krss/backend/internal/service"
	"krss/backend/pkg/logger"
)

func NewRouter(
	folderHandler *handler.FolderHandler,
	feedHandler *handler.FeedHandler,
	entryHandler *handler.EntryHandler,
	opmlHandler *handler.OPMLHandler,
	iconHandler *handler.IconHandler,
	proxyHandler *handler.ProxyHandler,
	settingsHandler *handler.SettingsHandler,
	aiHandler *handler.AIHandler,
	authHandler *handler.AuthHandler,
	domainRateLimitHandler *handler.DomainRateLimitHandler,
	filterHandler *handler.FilterHandler,
	proxySourceHandler *handler.ProxySourceHandler,
	mcpHandler *handler.MCPHandler,
	mcpEndpointHandler *handler.MCPEndpointHandler,
	authService service.AuthService,
	staticDir string,
	enableSwagger bool,
) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.Use(middleware.Recover())
	e.Use(RequestLoggerMiddleware())

	logger.Info("router initialized", "module", "http", "action", "request", "resource", "http", "result", "ok", "static_dir", staticDir)

	if enableSwagger {
		e.GET("/swagger/*", echoSwagger.WrapHandler)
	}

	// Public API routes (no auth required)
	publicAPI := e.Group("/api")
	authHandler.RegisterPublicRoutes(publicAPI)

	// Protected API routes (auth required)
	api := e.Group("/api")
	api.Use(JWTAuthMiddleware(authService))

	folderHandler.RegisterRoutes(api)
	feedHandler.RegisterRoutes(api)
	entryHandler.RegisterRoutes(api)
	opmlHandler.RegisterRoutes(api)
	proxyHandler.RegisterRoutes(api)
	settingsHandler.RegisterRoutes(api)
	aiHandler.RegisterRoutes(api)
	iconHandler.RegisterAPIRoutes(api)
	authHandler.RegisterProtectedRoutes(api)
	domainRateLimitHandler.RegisterRoutes(api)
	filterHandler.RegisterRoutes(api)
	proxySourceHandler.RegisterRoutes(api)
	// MCP 连接管理 + 出向状态/令牌（16/17 批）：走登录态（JWT）
	mcpHandler.RegisterRoutes(api)

	// MCP 出向端点 /mcp：**不走 JWT** —— 它用长期 token（MCP 客户端只会带这个）
	mcpEndpointHandler.RegisterRoutes(e)

	// MCP OAuth 回调：**不走 JWT** —— 浏览器从授权服务器跳回来带不了 JWT，
	// 安全靠 state（256 位随机、单次有效、10 分钟过期），见 MCPHandler.RegisterPublicRoutes
	mcpHandler.RegisterPublicRoutes(e)

	// Icon routes with cache recovery
	iconHandler.RegisterRoutes(e)

	registerStatic(e, staticDir)

	return e
}
