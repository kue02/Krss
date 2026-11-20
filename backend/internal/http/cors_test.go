package http_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/require"
	gh "krss/backend/internal/http"
)

// newCORSTestServer 挂一个最小路由，模拟 App 调用 API 的场景。
func newCORSTestServer() *echo.Echo {
	e := echo.New()
	e.Use(gh.CORSMiddleware())
	e.GET("/api/ping", func(c echo.Context) error {
		return c.String(http.StatusOK, "pong")
	})
	return e
}

func TestCORSMiddleware(t *testing.T) {
	t.Run("PreflightFromAppOrigin", func(t *testing.T) {
		e := newCORSTestServer()
		req := httptest.NewRequest(http.MethodOptions, "/api/ping", nil)
		req.Header.Set(echo.HeaderOrigin, "mygo://localhost")
		req.Header.Set(echo.HeaderAccessControlRequestMethod, http.MethodGet)
		req.Header.Set(echo.HeaderAccessControlRequestHeaders, "authorization,content-type")
		rec := httptest.NewRecorder()

		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		require.Equal(t, "mygo://localhost", rec.Header().Get(echo.HeaderAccessControlAllowOrigin))
		require.Contains(t, rec.Header().Get(echo.HeaderAccessControlAllowHeaders), echo.HeaderAuthorization)
		require.Contains(t, rec.Header().Get(echo.HeaderAccessControlAllowMethods), http.MethodGet)
		require.Equal(t, "86400", rec.Header().Get(echo.HeaderAccessControlMaxAge))
	})

	t.Run("PreflightFromWindowsAndroidOrigin", func(t *testing.T) {
		e := newCORSTestServer()
		req := httptest.NewRequest(http.MethodOptions, "/api/ping", nil)
		req.Header.Set(echo.HeaderOrigin, "https://mygo.localhost")
		rec := httptest.NewRecorder()

		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		require.Equal(t, "https://mygo.localhost", rec.Header().Get(echo.HeaderAccessControlAllowOrigin))
	})

	t.Run("PreflightFromNullOrigin", func(t *testing.T) {
		// WKWebView 里自定义 scheme 页面是不透明源，预检会带 Origin: null，
		// 这里固定住「null 默认放行且原样回显」的语义。
		e := newCORSTestServer()
		req := httptest.NewRequest(http.MethodOptions, "/api/ping", nil)
		req.Header.Set(echo.HeaderOrigin, "null")
		rec := httptest.NewRecorder()

		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		require.Equal(t, "null", rec.Header().Get(echo.HeaderAccessControlAllowOrigin))
	})

	t.Run("ActualGETFromAppOrigin", func(t *testing.T) {
		e := newCORSTestServer()
		req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
		req.Header.Set(echo.HeaderOrigin, "mygo://localhost")
		rec := httptest.NewRecorder()

		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		require.Equal(t, "pong", rec.Body.String())
		require.Equal(t, "mygo://localhost", rec.Header().Get(echo.HeaderAccessControlAllowOrigin))
	})

	t.Run("DisallowedOriginGetsNoACAO", func(t *testing.T) {
		e := newCORSTestServer()

		preflight := httptest.NewRequest(http.MethodOptions, "/api/ping", nil)
		preflight.Header.Set(echo.HeaderOrigin, "https://evil.example")
		preflightRec := httptest.NewRecorder()
		e.ServeHTTP(preflightRec, preflight)
		require.Empty(t, preflightRec.Header().Get(echo.HeaderAccessControlAllowOrigin))

		req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
		req.Header.Set(echo.HeaderOrigin, "https://evil.example")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		require.Empty(t, rec.Header().Get(echo.HeaderAccessControlAllowOrigin))
	})

	t.Run("EnvAppendsOrigins", func(t *testing.T) {
		t.Setenv(gh.CORSOriginsEnv, "https://app.example.com , https://staging.example.com")

		e := newCORSTestServer()
		for _, origin := range []string{"https://app.example.com", "https://staging.example.com"} {
			req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
			req.Header.Set(echo.HeaderOrigin, origin)
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, req)
			require.Equal(t, origin, rec.Header().Get(echo.HeaderAccessControlAllowOrigin), "origin %s", origin)
		}

		// 环境变量是追加而非覆盖：默认 App 源仍然生效。
		req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
		req.Header.Set(echo.HeaderOrigin, "mygo://localhost")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		require.Equal(t, "mygo://localhost", rec.Header().Get(echo.HeaderAccessControlAllowOrigin))
	})

	t.Run("NoOriginIsUntouched", func(t *testing.T) {
		e := newCORSTestServer()
		req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
		rec := httptest.NewRecorder()

		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		require.Empty(t, rec.Header().Get(echo.HeaderAccessControlAllowOrigin))
	})
}
