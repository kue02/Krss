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
	"path"
	"strings"
	"time"

	"github.com/Noooste/azuretls-client"
	"github.com/gabriel-vasile/mimetype"

	"krss/backend/internal/config"
	"krss/backend/pkg/logger"
	"krss/backend/pkg/network"
)

const proxyTimeout = 30 * time.Second

// mediaResponseHeaderTimeout 只约束「上游多久内得把响应头发回来」。
//
// 为什么不用 proxyTimeout 当整请求超时：视频是 206 + Content-Length 的大响应，
// http.Client.Timeout 会在 body 传到一半时把连接掐断，客户端收到残缺文件（实测
// curl --limit-rate 50k 打 63MB 时 exit=18）。body 阶段的终止交给请求 ctx：
// 浏览器断开 → ctx 取消 → io.Copy 中止，正好。
const mediaResponseHeaderTimeout = 20 * time.Second

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
	// 磁盘缓存只存「整段 200」，Range 片段一律不落盘。
	// 为什么：按任意起点切出来的片段会各存一份，实测一个 63MB 视频被存成 61 个文件 / 230MB
	// （放大 3.82×），512MB 只装得下 3.7 个视频；而响应本来就带 Cache-Control: max-age=86400，
	// 浏览器自己会缓存字节，磁盘分片缓存的收益远小于它带来的放大与一致性问题。
	cacheable := s.mediaCache != nil && rangeHeader == ""
	if cacheable {
		if hit, ok := s.mediaCache.Get(mediaURL); ok {
			logger.Debug("proxy media cache hit", "module", "service", "action", "fetch", "resource", "proxy", "result", "ok", "host", safeHostLog(mediaURL))
			return hit, nil
		}
	}

	// 先用标准 HTTP 客户端：它能正确走「设置 → 网络」里配置的代理，也会自动跟随图床跳转
	// （azuretls 会话在 HTTP 代理下会超时）
	result, stdErr := s.fetchWithStandardClient(ctx, mediaURL, refererURL, rangeHeader)
	if stdErr == nil {
		// 只缓存完整成功的 200 整段；206 片段与错误结果都不入缓存
		if cacheable && result.StatusCode == http.StatusOK {
			s.mediaCache.Put(mediaURL, result)
		}
		return result, nil
	}

	logger.Debug("proxy standard client failed, falling back", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "error", stdErr)

	// 再退到 azuretls 会话（浏览器 TLS 指纹）：反爬 / Anubis 挑战的站点靠它
	// （兜底这条路只做整段取，不带 Range）
	result, fallbackErr := s.fetchImageWithRetry(ctx, mediaURL, refererURL, "", 0)
	if fallbackErr == nil && cacheable {
		s.mediaCache.Put(mediaURL, result)
	}
	return result, fallbackErr
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
	setProxyMediaHeaders(req.Header, refererURL, parsedURL)
	// Range 原样转发给上游（不再做 4MiB 人工窗口）：上游回 206 就照 206 流式下发，
	// 回 200 就整段流式下发。切窗会按任意起点把缓存打碎（放大 3.82×），得不偿失。
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}

	if cachedCookie := getCachedAnubisCookie(ctx, s.anubis, parsedURL.Host, req.Header); cachedCookie != "" {
		req.Header.Set("Cookie", cachedCookie)
	}

	// 媒体请求用长连接 + 只限「首字节」的客户端，不能用 NewHTTPClient：
	// 它的 Timeout 是整请求超时（含读 body），206 + Content-Length 早已发出后把 body
	// 从中间掐断，客户端只会收到残缺文件（curl exit=18）；它的 transport 还
	// DisableKeepAlives，每个分片都要重新 TCP+TLS 握手。详见 network.NewMediaHTTPClient。
	client := s.clientFactory.NewMediaHTTPClient(ctx, mediaResponseHeaderTimeout)
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrFetchFailed, err)
	}

	// 200 整段、206 片段都算成功；416 也放行以便上层原样透传给客户端
	// （例如 bytes=999999999- 超出总长，必须回 416 而不是 500）。
	if resp.StatusCode != http.StatusOK &&
		resp.StatusCode != http.StatusPartialContent &&
		resp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		_ = resp.Body.Close()
		return nil, nil, fmt.Errorf("%w: %d", ErrFetchFailed, resp.StatusCode)
	}
	return resp, parsedURL, nil
}

// bufferStandardMediaResponse 把整段读进内存并嗅探类型。
// 图片代理必须走这里：Content-Type 不可信时要靠 magic bytes 兜底。
// 这里不再做本地切片 —— 上游不认 Range 时回 200 整段，就照 200 整段回给浏览器
// （能正常播放，只是不能精确 seek），比 io.ReadAll + 切片快得多。
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

	return &ProxyResult{
		Data:         data,
		ContentType:  contentType,
		StatusCode:   resp.StatusCode,
		ContentRange: resp.Header.Get("Content-Range"),
		AcceptRanges: "bytes",
	}, nil
}

// setProxyMediaHeaders 给标准客户端设置与 azuretls 那条路一致的请求头。
// 按 URL 猜资源类型只影响 accept / sec-fetch-dest 两个头：有些 CDN 会按这两个头
// 返回不同内容，视频请求带 sec-fetch-dest: image 有被当成图片处理的风险。
// 为什么按扩展名判断：发请求时还没有上游响应，只能看 URL；视频 URL 基本都以
// .mp4/.m4s/.webm 之类结尾（如 twimg 的 /vid/avc1/.../x.mp4）。判断不出就当图片，
// 保持图片路径行为完全不变。
func setProxyMediaHeaders(header http.Header, refererURL string, parsedURL *url.URL) {
	if mediaKindFromURL(parsedURL) == mediaKindVideo {
		header.Set("accept", "video/avif,video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8")
		header.Set("sec-fetch-dest", "video")
	} else {
		header.Set("accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
		header.Set("sec-fetch-dest", "image")
	}
	header.Set("accept-language", "zh-CN,zh;q=0.9")
	header.Set("referer", buildReferer(refererURL, parsedURL))
	header.Set("sec-ch-ua", config.ChromeSecChUa)
	header.Set("sec-ch-ua-mobile", "?0")
	header.Set("sec-ch-ua-platform", `"Windows"`)
	header.Set("sec-fetch-mode", "no-cors")
	header.Set("sec-fetch-site", "cross-site")
	header.Set("user-agent", config.ChromeUserAgent)
}

const (
	mediaKindImage = "image"
	mediaKindVideo = "video"
)

// mediaKindFromURL 按 URL 路径扩展名（以及 /vid/、/video/ 路径段）判断媒体类型。
func mediaKindFromURL(parsedURL *url.URL) string {
	if parsedURL == nil {
		return mediaKindImage
	}
	lowerPath := strings.ToLower(parsedURL.Path)
	switch path.Ext(lowerPath) {
	case ".mp4", ".m4v", ".m4s", ".webm", ".mov", ".mkv", ".ogv", ".avi", ".ts", ".m3u8", ".mpd":
		return mediaKindVideo
	}
	if strings.Contains(lowerPath, "/vid/") || strings.Contains(lowerPath, "/video/") {
		return mediaKindVideo
	}
	return mediaKindImage
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

	// Build headers：与标准客户端那条路一致，视频按 video 资源类型发头
	// （有些 CDN 看 sec-fetch-dest/accept 决定回什么内容）。
	accept := "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
	secFetchDest := "image"
	if mediaKindFromURL(parsedURL) == mediaKindVideo {
		accept = "video/avif,video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8"
		secFetchDest = "video"
	}
	headers := azuretls.OrderedHeaders{
		{"accept", accept},
		{"accept-language", "zh-CN,zh;q=0.9"},
		{"referer", referer},
		{"sec-ch-ua", config.ChromeSecChUa},
		{"sec-ch-ua-mobile", "?0"},
		{"sec-ch-ua-platform", `"Windows"`},
		{"sec-fetch-dest", secFetchDest},
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
