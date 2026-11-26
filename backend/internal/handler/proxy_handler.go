package handler

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/labstack/echo/v4"

	"krss/backend/internal/service"
	"krss/backend/pkg/logger"
)

func safeHost(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return parsed.Host
}

const cacheMaxAge = 86400 // 1 day
const svgContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; sandbox"

type ProxyHandler struct {
	proxyService service.ProxyService
}

func NewProxyHandler(proxyService service.ProxyService) *ProxyHandler {
	return &ProxyHandler{
		proxyService: proxyService,
	}
}

func (h *ProxyHandler) RegisterRoutes(g *echo.Group) {
	g.GET("/proxy/image/:encoded", h.ProxyImage)
}

// ProxyImage godoc
// @Summary Proxy external image
// @Description Proxies external images to avoid triggering anti-crawling mechanisms
// @Tags proxy
// @Produce octet-stream
// @Param encoded path string true "Base64 URL-safe encoded image URL"
// @Param ref query string false "Base64 URL-safe encoded article URL (used as Referer for CDN anti-hotlinking)"
// @Success 200 {file} binary
// @Failure 400 {object} errorResponse
// @Failure 502 {object} errorResponse
// @Failure 500 {object} errorResponse
// @Failure 504 {object} errorResponse
// @Router /api/proxy/image/{encoded} [get]
func (h *ProxyHandler) ProxyImage(c echo.Context) error {
	encoded := c.Param("encoded")
	if encoded == "" {
		logger.Debug("proxy image missing url", "module", "handler", "action", "request", "resource", "proxy", "result", "failed")
		return Error(c, http.StatusBadRequest, "URL is required")
	}

	// Decode Base64 URL-safe
	decoded, err := base64.URLEncoding.DecodeString(encoded)
	if err != nil {
		logger.Debug("proxy image invalid encoding", "module", "handler", "action", "request", "resource", "proxy", "result", "failed", "error", err)
		return Error(c, http.StatusBadRequest, "Invalid encoding")
	}
	imageURL := string(decoded)

	// Decode referer URL if provided (for CDN anti-hotlinking)
	var refererURL string
	if refEncoded := c.QueryParam("ref"); refEncoded != "" {
		if refDecoded, err := base64.URLEncoding.DecodeString(refEncoded); err == nil {
			refererURL = string(refDecoded)
		}
	}

	// <video> 会带 Range 来取片段（拖动进度条），透传给上游并原样回 206
	rangeHeader := c.Request().Header.Get("Range")
	if rangeHeader != "" {
		return h.streamMedia(c, imageURL, refererURL, rangeHeader)
	}

	result, err := h.proxyService.FetchMedia(
		c.Request().Context(),
		imageURL,
		refererURL,
		"",
	)
	if err != nil {
		logger.Warn("proxy image fetch failed", "module", "handler", "action", "fetch", "resource", "proxy", "result", "failed", "host", safeHost(imageURL), "error", err)
		return h.handleServiceError(c, err)
	}

	logger.Debug("proxy image fetched", "module", "handler", "action", "fetch", "resource", "proxy", "result", "ok", "host", safeHost(imageURL), "content_type", strings.ToLower(result.ContentType))
	c.Response().Header().Set("Content-Type", result.ContentType)
	c.Response().Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", cacheMaxAge))
	c.Response().Header().Set("X-Content-Type-Options", "nosniff")
	c.Response().Header().Set("Accept-Ranges", "bytes")
	if result.ContentRange != "" {
		c.Response().Header().Set("Content-Range", result.ContentRange)
	}
	if strings.EqualFold(result.ContentType, "image/svg+xml") {
		c.Response().Header().Set("Content-Security-Policy", svgContentSecurityPolicy)
	}

	status := result.StatusCode
	if status != http.StatusPartialContent {
		status = http.StatusOK
	}
	return c.Blob(status, result.ContentType, result.Data)
}

// streamMedia 下发 Range 片段：上游吐一块就往下游写一块，不等整个窗口下载完。
//
// 为什么单独一条路：FetchMedia 是「读满 4MiB → 嗅探 → 回包」，首次播放要等
// 整窗（实测 TTFB 14.96s，用户看到十几秒黑屏）；流式把首包压到上游首字节
// 的时间。无 Range 的请求（图片）仍走上面的缓冲路径，不能合并 —— 图片要靠
// 完整字节嗅探 Content-Type。
func (h *ProxyHandler) streamMedia(c echo.Context, imageURL, refererURL, rangeHeader string) error {
	stream, err := h.proxyService.FetchMediaStream(c.Request().Context(), imageURL, refererURL, rangeHeader)
	if err != nil {
		// 必须先把错误回掉再碰任何 header：一旦 WriteHeader 过，状态码就改不了了
		// （echo 的 DefaultHTTPErrorHandler 在 Committed 之后直接 return）。
		logger.Warn("proxy media stream failed", "module", "handler", "action", "fetch", "resource", "proxy", "result", "failed", "host", safeHost(imageURL), "error", err)
		return h.handleServiceError(c, err)
	}
	defer stream.Body.Close()

	header := c.Response().Header()
	header.Set("Content-Type", stream.ContentType)
	header.Set("Cache-Control", fmt.Sprintf("public, max-age=%d", cacheMaxAge))
	header.Set("X-Content-Type-Options", "nosniff")
	if stream.AcceptRanges != "" {
		header.Set("Accept-Ranges", stream.AcceptRanges)
	}
	if stream.ContentRange != "" {
		header.Set("Content-Range", stream.ContentRange)
	}
	// echo 的 c.Stream 只写状态码 + io.Copy，不设 Content-Length；206 少了它
	// 浏览器就只能靠分块边界猜进度。上游没给长度（-1，分块传输）时才不设。
	if stream.ContentLength >= 0 {
		header.Set("Content-Length", strconv.FormatInt(stream.ContentLength, 10))
	}

	status := stream.StatusCode
	if status != http.StatusPartialContent {
		status = http.StatusOK
	}
	return c.Stream(status, stream.ContentType, stream.Body)
}

func (h *ProxyHandler) handleServiceError(c echo.Context, err error) error {
	switch {
	case errors.Is(err, service.ErrInvalidURL):
		return Error(c, http.StatusBadRequest, "Invalid URL")
	case errors.Is(err, service.ErrInvalidProtocol):
		return Error(c, http.StatusBadRequest, "Invalid protocol")
	case errors.Is(err, service.ErrRequestTimeout):
		return Error(c, http.StatusGatewayTimeout, "Request timeout")
	case errors.Is(err, service.ErrInvalidImage):
		return Error(c, http.StatusBadGateway, "Invalid image")
	case errors.Is(err, service.ErrUpstreamRejected):
		// Upstream rejected the request, return 502 and prevent caching
		c.Response().Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
		return Error(c, http.StatusBadGateway, "Upstream rejected")
	default:
		return Error(c, http.StatusInternalServerError, "Failed to fetch image")
	}
}
