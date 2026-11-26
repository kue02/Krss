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
	// WithMediaCache 开启代理媒体磁盘缓存（50-2）。dir 为空则不缓存（测试/未配置时）。
	WithMediaCache(dir string, maxBytes int64) ProxyService
	// MediaCacheStats 当前缓存的文件数与总字节（没开缓存时全 0）。
	MediaCacheStats() (files int, bytes int64)
	// FetchMedia 与 FetchImage 同一条管线，但额外支持音视频类型与 Range 请求
	// （正文里的 <video> 走代理，见 frontend/src/components/ui/article-video.tsx）
	FetchMedia(ctx context.Context, mediaURL, refererURL, rangeHeader string) (*ProxyResult, error)
	// FetchMediaStream 给 Range 请求用的流式版本：上游回 206 时不等整段读完，
	// 边收边发边写缓存（首包不再等整个 4MiB 窗口）。不带 Range 的请求不要走
	// 这条 —— 图片要靠完整字节嗅探 Content-Type，见 FetchMedia。
	FetchMediaStream(ctx context.Context, mediaURL, refererURL, rangeHeader string) (*MediaStream, error)
	Close()
}

type proxyService struct {
	clientFactory *network.ClientFactory
	anubis        AnubisSolver
	// mediaCache 代理媒体（图片/音视频）的磁盘缓存：没有它每次都要重新出网取
	// （实测同一张图连取三遍 0.708 / 0.967 / 0.669 s，一点没快）
	mediaCache *mediaCache
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
	// 开放式 Range（`bytes=0-`）先收成有界窗口：上游按字面理解会回整个文件
	// （63MB 的视频就真回 63MB），收成 4MiB 窗口后上游才回 206 片段。
	// 改写后的值同时用作缓存键 —— 必须用「实际发给上游的 range」，
	// 否则同一个 bytes=0- 每次窗口可能不同，缓存永远命中不了。
	upstreamRange := clampOpenEndedRange(rangeHeader, mediaChunkBytes)
	cacheKey := mediaCacheKey(mediaURL, upstreamRange)

	// Range 片段现在也进缓存：<video> 的每个分片请求都带 Range，
	// 原来一律不缓存 ⇒ 视频永远零命中（每个片段都要重新出网）。
	cacheable := s.mediaCache != nil
	if cacheable {
		if hit, ok := s.mediaCache.Get(cacheKey); ok {
			logger.Debug("proxy media cache hit", "module", "service", "action", "fetch", "resource", "proxy", "result", "ok", "host", safeHostLog(mediaURL))
			return hit, nil
		}
	}

	// 先用标准 HTTP 客户端：它能正确走「设置 → 网络」里配置的代理，也会自动跟随图床跳转
	// （azuretls 会话在 HTTP 代理下会超时）
	result, stdErr := s.fetchWithStandardClient(ctx, mediaURL, refererURL, upstreamRange)
	if stdErr == nil {
		// 只缓存完整成功的结果（200 整段 / 206 片段），错误结果绝不入缓存
		if cacheable && isCacheableProxyStatus(result.StatusCode) {
			s.mediaCache.Put(cacheKey, result)
		}
		return result, nil
	}

	logger.Debug("proxy standard client failed, falling back", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "error", stdErr)

	// 再退到 azuretls 会话（浏览器 TLS 指纹）：反爬 / Anubis 挑战的站点靠它
	// （兜底这条路只做整段取，不带 Range —— 所以只有本来就没 Range 的请求
	// 才能按这个键缓存，否则会把整段当成片段存进片段键里）
	result, fallbackErr := s.fetchImageWithRetry(ctx, mediaURL, refererURL, "", 0)
	if fallbackErr == nil && cacheable && upstreamRange == "" {
		s.mediaCache.Put(cacheKey, result)
	}
	return result, fallbackErr
}

// isCacheableProxyStatus 只有完整成功的响应才值得落盘（200 整段 / 206 片段）。
func isCacheableProxyStatus(status int) bool {
	return status == http.StatusOK || status == http.StatusPartialContent
}

// mediaCacheKey 缓存键：无 Range 沿用 mediaURL（老键继续兼容，图片缓存不会失效）；
// 有 Range 用 mediaURL + NUL + 实际发给上游的 range —— 不同片段各存一份，
// 同一个片段（浏览器重试/重放）直接命中。
func mediaCacheKey(mediaURL, upstreamRange string) string {
	if upstreamRange == "" {
		return mediaURL
	}
	return mediaURL + "\x00" + upstreamRange
}

// WithMediaCache 挂上磁盘缓存（dir 空则不启用）。
func (s *proxyService) WithMediaCache(dir string, maxBytes int64) ProxyService {
	if dir == "" {
		return s
	}
	s.mediaCache = newMediaCache(dir, maxBytes)
	return s
}

// MediaCacheStats 当前缓存规模（排查/测试用）。
func (s *proxyService) MediaCacheStats() (int, int64) {
	return s.mediaCache.Stats()
}

// safeHostLog 日志用的主机名（拿不到就回原串的短版）
func safeHostLog(rawURL string) string {
	if parsed, err := url.Parse(rawURL); err == nil && parsed.Host != "" {
		return parsed.Host
	}
	if len(rawURL) > 48 {
		return rawURL[:48]
	}
	return rawURL
}

// fetchWithStandardClient 用 net/http 抓图：代理、跳转、cookie 都由标准栈处理。
// 拿到的不是图片（例如 Anubis 挑战页）就返回错误，交给上层退到 azuretls。
func (s *proxyService) fetchWithStandardClient(ctx context.Context, imageURL, refererURL, rangeHeader string) (*ProxyResult, error) {
	resp, parsedURL, err := s.openStandardMediaResponse(ctx, imageURL, refererURL, rangeHeader)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	return bufferStandardMediaResponse(resp, parsedURL, rangeHeader)
}

// openStandardMediaResponse 发请求并校验状态码，把 body 留给调用方关。
// 抽出来是给流式转发（FetchMediaStream）复用同一套请求构造：代理、跳转、
// Anubis cookie、Range 转发这几件事只能有一份实现，否则两条路行为会漂。
func (s *proxyService) openStandardMediaResponse(ctx context.Context, imageURL, refererURL, rangeHeader string) (*http.Response, *url.URL, error) {
	parsedURL, err := url.Parse(imageURL)
	if err != nil {
		return nil, nil, ErrInvalidURL
	}
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return nil, nil, ErrInvalidProtocol
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, nil, ErrInvalidURL
	}
	setProxyImageHeaders(req.Header, refererURL, parsedURL)
	// 把 Range 真的发给上游：原来只拿它做本地切片，上游永远回 200 + 整个文件，
	// 浏览器要 1KB 片段、后端却下载 63MB（实测 TTFB 5.5-7.8s，直连上游 0.46s）。
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}

	if cachedCookie := getCachedAnubisCookie(ctx, s.anubis, parsedURL.Host, req.Header); cachedCookie != "" {
		req.Header.Set("Cookie", cachedCookie)
	}

	// 超时保持客户端级 30s（proxyTimeout）不动：上游现在最多只回 4MiB 窗口
	// （见 clampOpenEndedRange），30s 足够 1Mbps 的弱网传完；改成按请求
	// context.WithTimeout 会与调用方 ctx 的截止时间打架，且会影响 network 包
	// 其它调用方的既有语义 —— 保守起见只在这一层用窗口限制风险。
	client := s.clientFactory.NewHTTPClient(ctx, proxyTimeout)
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrFetchFailed, err)
	}

	// 200 整段、206 片段都算成功（<video> 会带 Range 请求）
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		_ = resp.Body.Close()
		return nil, nil, fmt.Errorf("%w: %d", ErrFetchFailed, resp.StatusCode)
	}
	return resp, parsedURL, nil
}

// bufferStandardMediaResponse 把整段读进内存、嗅探类型、必要时本地切片。
// 图片代理必须走这里：Content-Type 不可信时要靠 magic bytes 兜底。
func bufferStandardMediaResponse(resp *http.Response, parsedURL *url.URL, rangeHeader string) (*ProxyResult, error) {
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
	// 上游认了 Range 就别再动它：206 与 Content-Range 原样透传，
	// 总长由上游给，浏览器据此继续要下一段。
	if statusCode != http.StatusPartialContent && rangeHeader != "" {
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
