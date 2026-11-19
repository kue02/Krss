package http

import (
	"net/http"
	"os"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// CORSOriginsEnv 用于追加允许的跨域来源（逗号分隔），便于换域名时无需改代码。
const CORSOriginsEnv = "KRSS_CORS_ORIGINS"

// DefaultCORSOrigins 是 MyGo App 的页面源，默认只放行这些来源，不使用 "*"。
//
//   - macOS / Linux / iOS：页面从自定义 scheme 加载，源为 mygo://localhost；
//   - Windows / Android：页面源为 https://mygo.localhost；
//   - null：WKWebView 里自定义 scheme 的页面属于不透明源（opaque origin），
//     发起的 fetch/XHR 会带 `Origin: null`。只放行 null 本身并不等于放开所有网页：
//     后端用 Authorization: Bearer 鉴权且未开启 AllowCredentials，普通网页拿不到 token。
var DefaultCORSOrigins = []string{
	"mygo://localhost",
	"https://mygo.localhost",
	"null",
}

// CORSMiddleware 返回允许 MyGo App 跨域调用后端 API 的 CORS 中间件。
// 来源为 DefaultCORSOrigins 加上 KRSS_CORS_ORIGINS 中追加的来源。
func CORSMiddleware() echo.MiddlewareFunc {
	return middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: corsAllowedOrigins(),
		AllowMethods: []string{
			http.MethodGet,
			http.MethodPost,
			http.MethodPut,
			http.MethodPatch,
			http.MethodDelete,
			http.MethodOptions,
		},
		AllowHeaders: []string{
			echo.HeaderOrigin,
			echo.HeaderContentType,
			echo.HeaderAccept,
			echo.HeaderAuthorization,
		},
		MaxAge: 86400,
	})
}

// corsAllowedOrigins 返回默认来源与环境变量追加来源的并集。
func corsAllowedOrigins() []string {
	origins := make([]string, 0, len(DefaultCORSOrigins)+1)
	origins = append(origins, DefaultCORSOrigins...)
	for _, origin := range strings.Split(os.Getenv(CORSOriginsEnv), ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			origins = append(origins, origin)
		}
	}
	return origins
}
