//go:generate mockgen -source=$GOFILE -destination=mock/$GOFILE -package=mock
package service

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Noooste/azuretls-client"
	"github.com/gabriel-vasile/mimetype"

	"krss/backend/internal/config"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/network"
)

const proxyTimeout = 30 * time.Second

// maxProxyMediaBytes 单次代理回传的上限（视频可能几十 MB，别把内存吃爆）
const maxProxyMediaBytes = 64 << 20

var (
	ErrInvalidURL       = fmt.Errorf("invalid URL")
	ErrInvalidProtocol  = fmt.Errorf("invalid protocol")
	ErrRequestTimeout   = fmt.Errorf("request timeout")
	ErrFetchFailed      = fmt.Errorf("fetch failed")
	ErrUpstreamRejected = fmt.Errorf("upstream rejected")
	ErrInvalidImage     = fmt.Errorf("invalid image")
)

type ProxyResult struct {
	Data        []byte
	ContentType string
	// StatusCode 上游返回的状态码（206 表示这是 Range 请求的片段）
	StatusCode int
	// ContentRange / AcceptRanges 透传给浏览器，<video> 拖动进度条要用
	ContentRange string
	AcceptRanges string
}

type ProxyService interface {
	FetchImage(ctx context.Context, imageURL, refererURL string) (*ProxyResult, error)
	// FetchMedia 与 FetchImage 同一条管线，但额外支持音视频类型与 Range 请求
	// （正文里的 <video> 走代理，见 frontend/src/components/ui/article-video.tsx）
	FetchMedia(ctx context.Context, mediaURL, refererURL, rangeHeader string) (*ProxyResult, error)
	Close()
}

type proxyService struct {
	clientFactory *network.ClientFactory
	anubis        AnubisSolver
}

func NewProxyService(clientFactory *network.ClientFactory, anubisSolver AnubisSolver) ProxyService {
	return &proxyService{
		clientFactory: clientFactory,
		anubis:        anubisSolver,
	}
}

func (s *proxyService) Close() {
	// No persistent resources to release
}

func (s *proxyService) FetchImage(ctx context.Context, imageURL, refererURL string) (*ProxyResult, error) {
	return s.FetchMedia(ctx, imageURL, refererURL, "")
}

func (s *proxyService) FetchMedia(ctx context.Context, mediaURL, refererURL, rangeHeader string) (*ProxyResult, error) {
	// 先用标准 HTTP 客户端：它能正确走「设置 → 网络」里配置的代理，也会自动跟随图床跳转
	// （azuretls 会话在本机的 HTTP 代理下会超时，见 docs/移植笔记.md）
	result, stdErr := s.fetchWithStandardClient(ctx, mediaURL, refererURL, rangeHeader)
	if stdErr == nil {
		return result, nil
	}

	logger.Debug("proxy standard client failed, falling back", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "error", stdErr)

	// 再退到 azuretls 会话（浏览器 TLS 指纹）：反爬 / Anubis 挑战的站点靠它
	// （兜底这条路只做整段取，不带 Range）
	return s.fetchImageWithRetry(ctx, mediaURL, refererURL, "", 0)
}

// fetchWithStandardClient 用 net/http 抓图：代理、跳转、cookie 都由标准栈处理。
// 拿到的不是图片（例如 Anubis 挑战页）就返回错误，交给上层退到 azuretls。
func (s *proxyService) fetchWithStandardClient(ctx context.Context, imageURL, refererURL, rangeHeader string) (*ProxyResult, error) {
	parsedURL, err := url.Parse(imageURL)
	if err != nil {
		return nil, ErrInvalidURL
	}
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return nil, ErrInvalidProtocol
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, ErrInvalidURL
	}
	setProxyImageHeaders(req.Header, refererURL, parsedURL)

	if cachedCookie := getCachedAnubisCookie(ctx, s.anubis, parsedURL.Host, req.Header); cachedCookie != "" {
		req.Header.Set("Cookie", cachedCookie)
	}

	client := s.clientFactory.NewHTTPClient(ctx, proxyTimeout)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrFetchFailed, err)
	}
	defer resp.Body.Close()

	// 200 整段、206 片段都算成功（<video> 会带 Range 请求）
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return nil, fmt.Errorf("%w: %d", ErrFetchFailed, resp.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxProxyMediaBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrFetchFailed, err)
	}
	if len(data) > maxProxyMediaBytes {
		return nil, fmt.Errorf("%w: response too large", ErrFetchFailed)
	}

	contentType, err := detectProxyMediaContentType(resp.Header.Get("Content-Type"), data)
	if err != nil {
		logger.Debug("proxy standard client got unsupported media", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "host", parsedURL.Host, "error", err)
		return nil, err
	}

	statusCode := resp.StatusCode
	contentRange := resp.Header.Get("Content-Range")
	if statusCode == http.StatusOK && rangeHeader != "" {
		// 上游没理 Range（很常见）：我们在代理层把片段切出来并回 206，
		// 否则浏览器认为不可跳转，<video> 进度条一拖就弹回
		sliced, derivedRange, derivedStatus := sliceByRange(data, rangeHeader)
		if derivedStatus == http.StatusPartialContent {
			data = sliced
			contentRange = derivedRange
			statusCode = derivedStatus
		}
	}

	return &ProxyResult{
		Data:         data,
		ContentType:  contentType,
		StatusCode:   statusCode,
		ContentRange: contentRange,
		AcceptRanges: "bytes",
	}, nil
}

// setProxyImageHeaders 给标准客户端设置与 azuretls 那条路一致的取图请求头
func setProxyImageHeaders(header http.Header, refererURL string, parsedURL *url.URL) {
	header.Set("accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
	header.Set("accept-language", "zh-CN,zh;q=0.9")
	header.Set("referer", buildReferer(refererURL, parsedURL))
	header.Set("sec-ch-ua", config.ChromeSecChUa)
	header.Set("sec-ch-ua-mobile", "?0")
	header.Set("sec-ch-ua-platform", `"Windows"`)
	header.Set("sec-fetch-dest", "image")
	header.Set("sec-fetch-mode", "no-cors")
	header.Set("sec-fetch-site", "cross-site")
	header.Set("user-agent", config.ChromeUserAgent)
}

func (s *proxyService) fetchImageWithRetry(ctx context.Context, imageURL, refererURL, cookie string, retryCount int) (*ProxyResult, error) {
	session := s.clientFactory.NewAzureSession(ctx, proxyTimeout)
	defer session.Close()
	return s.doFetch(ctx, session, imageURL, refererURL, cookie, retryCount)
}

// fetchWithFreshSession creates a new azuretls session to avoid connection reuse after Anubis
func (s *proxyService) fetchWithFreshSession(ctx context.Context, imageURL, refererURL, cookie string, retryCount int) (*ProxyResult, error) {
	session := s.clientFactory.NewAzureSession(ctx, proxyTimeout)
	defer session.Close()
	return s.doFetch(ctx, session, imageURL, refererURL, cookie, retryCount)
}

// doFetch performs the actual HTTP request with the given session
func (s *proxyService) doFetch(ctx context.Context, session *azuretls.Session, imageURL, refererURL, cookie string, retryCount int) (*ProxyResult, error) {
	parsedURL, err := url.Parse(imageURL)
	if err != nil {
		return nil, ErrInvalidURL
	}

	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return nil, ErrInvalidProtocol
	}

	// Build Referer
	referer := buildReferer(refererURL, parsedURL)

	// Build headers
	headers := azuretls.OrderedHeaders{
		{"accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"},
		{"accept-language", "zh-CN,zh;q=0.9"},
		{"referer", referer},
		{"sec-ch-ua", config.ChromeSecChUa},
		{"sec-ch-ua-mobile", "?0"},
		{"sec-ch-ua-platform", `"Windows"`},
		{"sec-fetch-dest", "image"},
		{"sec-fetch-mode", "no-cors"},
		{"sec-fetch-site", "cross-site"},
		{"user-agent", config.ChromeUserAgent},
	}

	// Add cookie
	requestHeaders := orderedHeadersToHTTPHeader(headers)
	if cookie != "" {
		headers = append(headers, []string{"cookie", cookie})
	} else {
		if cachedCookie := getCachedAnubisCookie(ctx, s.anubis, parsedURL.Host, requestHeaders); cachedCookie != "" {
			headers = append(headers, []string{"cookie", cachedCookie})
		}
	}

	resp, err := session.Do(&azuretls.Request{
		Method:         http.MethodGet,
		Url:            imageURL,
		OrderedHeaders: headers,
	})
	if err != nil {
		logger.Warn("proxy fetch failed", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "host", parsedURL.Host, "error", err)
		return nil, fmt.Errorf("%w: %v", ErrFetchFailed, err)
	}

	if resp.StatusCode != http.StatusOK {
		logger.Error("proxy http error", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "host", parsedURL.Host, "status_code", resp.StatusCode)
		return nil, fmt.Errorf("%w: %d", ErrFetchFailed, resp.StatusCode)
	}

	data := resp.Body

	newCookie, anubisErr := trySolveAnubisChallenge(ctx, s.anubis, data, imageURL, cookiesFromMap(resp.Cookies), requestHeaders, retryCount)
	switch {
	case anubisErr == nil:
		return s.fetchWithFreshSession(ctx, imageURL, refererURL, newCookie, retryCount+1)
	case errors.Is(anubisErr, errAnubisNotPage):
		// Not an Anubis page; continue normal proxy response handling.
	case errors.Is(anubisErr, errAnubisRejected):
		logger.Warn("proxy upstream rejected", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "host", parsedURL.Host)
		return nil, ErrUpstreamRejected
	case errors.Is(anubisErr, errAnubisRetryExceeded):
		logger.Warn("proxy anubis persists", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "host", parsedURL.Host, "retry_count", retryCount)
		return nil, fmt.Errorf("%w: anubis challenge persists after %d retries", ErrFetchFailed, retryCount)
	default:
		logger.Warn("proxy anubis solve failed", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "host", parsedURL.Host, "error", anubisErr)
		return nil, ErrFetchFailed
	}

	contentType, err := detectProxyMediaContentType(resp.Header.Get("Content-Type"), data)
	if err != nil {
		logger.Warn("proxy invalid media", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "host", parsedURL.Host, "error", err)
		return nil, err
	}

	return &ProxyResult{
		Data:        data,
		ContentType: contentType,
	}, nil
}

// detectProxyMediaContentType 判定代理回来的东西能不能直接回给浏览器：
// 图片照旧，另外放行 video/* 与 audio/*（正文里的 <video> 走的就是这条代理）。
// header 优先（视频类型按内容嗅探不一定准），判定不出来再看内容。
func detectProxyMediaContentType(header string, data []byte) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(strings.Split(header, ";")[0]))
	if isProxyableMediaType(normalized) {
		return normalized, nil
	}

	contentType, err := detectProxyImageContentType(data)
	if err == nil {
		return contentType, nil
	}

	mtype := strings.ToLower(mimetype.Detect(data).String())
	if isProxyableMediaType(mtype) {
		return mtype, nil
	}

	return "", fmt.Errorf("%w: %s", ErrInvalidImage, mtype)
}

func isProxyableMediaType(contentType string) bool {
	return strings.HasPrefix(contentType, "image/") ||
		strings.HasPrefix(contentType, "video/") ||
		strings.HasPrefix(contentType, "audio/")
}

func detectProxyImageContentType(data []byte) (string, error) {
	mtype := mimetype.Detect(data)
	contentType := strings.ToLower(mtype.String())
	if strings.HasPrefix(contentType, "image/") {
		return contentType, nil
	}
	if isSVGDocument(data) {
		return "image/svg+xml", nil
	}
	return "", fmt.Errorf("%w: %s", ErrInvalidImage, contentType)
}

func isSVGDocument(data []byte) bool {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	for {
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		if start, ok := token.(xml.StartElement); ok {
			return strings.EqualFold(start.Name.Local, "svg")
		}
	}
}

// buildReferer constructs the Referer header value
func buildReferer(refererURL string, parsedURL *url.URL) string {
	if refererURL != "" {
		if parsed, err := url.Parse(refererURL); err == nil {
			return parsed.Scheme + "://" + parsed.Host + "/"
		}
	}
	return parsedURL.Scheme + "://" + parsedURL.Host + "/"
}
