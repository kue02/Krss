package http

import (
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"

	"krss/backend/internal/service"
	"krss/backend/pkg/logger"
)

// AuthCookieName is the name of the authentication cookie.
const AuthCookieName = "krss_auth"

// RequestLoggerMiddleware logs HTTP requests using logger.
func RequestLoggerMiddleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			start := time.Now()

			err := next(c)
			if err != nil {
				c.Error(err)
			}

			req := c.Request()
			res := c.Response()
			latency := time.Since(start)
			remoteIP := c.RealIP()
			userAgent := req.UserAgent()

			status := res.Status
			action := "request"
			resource := "http"
			result := "ok"
			if status >= 400 {
				result = "failed"
			}
			if status >= 500 {
				logger.Error("http request",
					"module", "http",
					"action", action,
					"resource", resource,
					"result", result,
					"method", req.Method,
					"path", req.URL.Path,
					"status_code", status,
					"duration_ms", latency.Milliseconds(),
					"remote_ip", remoteIP,
					"user_agent", userAgent,
				)
			} else if status >= 400 {
				logger.Warn("http request",
					"module", "http",
					"action", action,
					"resource", resource,
					"result", result,
					"method", req.Method,
					"path", req.URL.Path,
					"status_code", status,
					"duration_ms", latency.Milliseconds(),
					"remote_ip", remoteIP,
					"user_agent", userAgent,
				)
			} else {
				logger.Debug("http request",
					"module", "http",
					"action", action,
					"resource", resource,
					"result", result,
					"method", req.Method,
					"path", req.URL.Path,
					"status_code", status,
					"duration_ms", latency.Milliseconds(),
					"remote_ip", remoteIP,
					"user_agent", userAgent,
				)
			}

			return nil
		}
	}
}

// JWTAuthMiddleware creates a middleware that validates JWT tokens.
// It checks both Authorization header (for API calls) and Cookie (for browser resource requests like images).
type authOptions struct {
	plugintTokens func(token string) (pluginID string, ok bool)
}

// AuthOption 认证中间件的可选能力（变参，既有调用方不用改）。
type AuthOption func(*authOptions)

// WithPluginDataTokens 让插件进程用自己的 token 读写**它自己**的 data（56-32 单库数据通道）。
// 只在 /api/plugins/<id>/data/... 上生效，且 token 换回的 id 必须等于路径里的 id。
func WithPluginDataTokens(resolve func(token string) (pluginID string, ok bool)) AuthOption {
	return func(o *authOptions) { o.plugintTokens = resolve }
}

func JWTAuthMiddleware(authService service.AuthService, opts ...AuthOption) echo.MiddlewareFunc {
	options := authOptions{}
	for _, opt := range opts {
		opt(&options)
	}
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			// 插件沙箱界面资源放行（56-24）：iframe 是 sandbox="allow-scripts" 的 opaque origin，
			// 子资源请求既没有 Authorization 头、也不被浏览器带上 SameSite cookie（被当跨站），
			// 不放行的话插件的 ./bridge.js 一律 401，页面永远停在「加载中」。
			// 这里服务的是**插件代码**，不是用户数据；数据仍只能由有登录态的父窗口过 postMessage bridge 取。
			if IsPluginUIAssetPath(c.Request().URL.Path) {
				return next(c)
			}

			var token string

			// Try Authorization header first
			authHeader := c.Request().Header.Get("Authorization")
			if authHeader != "" {
				parts := strings.SplitN(authHeader, " ", 2)
				if len(parts) == 2 && strings.ToLower(parts[0]) == "bearer" {
					token = parts[1]
				}
			}

			// 插件进程的数据通道：带 X-Krss-Plugin-Token 且路径是 /api/plugins/<id>/data/…
			// token 换回的 id 必须与路径一致（一枚 token 只能碰自己那一行）。
			if token == "" && options.plugintTokens != nil {
				if pluginToken := strings.TrimSpace(c.Request().Header.Get("X-Krss-Plugin-Token")); pluginToken != "" {
					if pathID, ok := pluginDataPathID(c.Request().URL.Path); ok {
						if id, valid := options.plugintTokens(pluginToken); valid && id == pathID {
							return next(c)
						}
						logger.Warn("plugin data token rejected",
							"module", "http", "action", "request", "resource", "auth", "result", "failed",
							"path", c.Request().URL.Path, "remote_ip", c.RealIP())
						return c.JSON(http.StatusUnauthorized, map[string]string{"error": "invalid plugin token"})
					}
				}
			}

			// Fallback to cookie (for image/resource requests)
			if token == "" {
				if cookie, err := c.Cookie(AuthCookieName); err == nil && cookie.Value != "" {
					token = cookie.Value
				}
			}

			if token == "" {
				logger.Warn("auth missing",
					"module", "http",
					"action", "request",
					"resource", "auth",
					"result", "failed",
					"method", c.Request().Method,
					"path", c.Request().URL.Path,
					"remote_ip", c.RealIP(),
				)
				return c.JSON(http.StatusUnauthorized, map[string]string{
					"error": "missing authentication",
				})
			}

			// Validate token
			valid, err := authService.ValidateToken(token)
			if err != nil || !valid {
				clearAuthCookie(c)
				logger.Warn("auth invalid",
					"module", "http",
					"action", "request",
					"resource", "auth",
					"result", "failed",
					"method", c.Request().Method,
					"path", c.Request().URL.Path,
					"remote_ip", c.RealIP(),
				)
				return c.JSON(http.StatusUnauthorized, map[string]string{
					"error": "invalid token",
				})
			}

			return next(c)
		}
	}
}

func clearAuthCookie(c echo.Context) {
	cookie := &http.Cookie{
		Name:     AuthCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   c.Request().TLS != nil,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	}
	c.SetCookie(cookie)
}

// IsPluginUIAssetPath 判断路径是不是「插件自带界面资源」（/api/plugins/<id>/ui[/...]）。
// 单独提出来是为了让测试直接钉住这条豁免的边界（只放行 ui 子树，别的插件接口照旧要登录）。
func IsPluginUIAssetPath(path string) bool {
	rest, ok := strings.CutPrefix(path, "/api/plugins/")
	if !ok || rest == "" {
		return false
	}
	id, tail, ok := strings.Cut(rest, "/ui")
	if !ok || strings.TrimSpace(id) == "" || strings.Contains(id, "/") {
		return false
	}
	return tail == "" || strings.HasPrefix(tail, "/")
}

// pluginDataPathID 从 /api/plugins/<id>/data[/...] 里取出插件 id。
func pluginDataPathID(path string) (string, bool) {
	rest, ok := strings.CutPrefix(path, "/api/plugins/")
	if !ok {
		return "", false
	}
	id, tail, ok := strings.Cut(rest, "/data")
	if !ok || id == "" || strings.Contains(id, "/") {
		return "", false
	}
	if tail != "" && !strings.HasPrefix(tail, "/") {
		return "", false
	}
	return id, tail != ""
}
