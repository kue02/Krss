package service

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"

	"krss/backend/pkg/logger"
)

// 流式转发（fix/video-proxy-stream 第三轮）。
//
// 为什么改纯流式：第一轮把 Range 真发给上游、第二轮改成边收边发，但都留着「4MiB 人工窗口」。
// 审查实测两个后果：① 每个窗口都新建 http.Client 且其 transport DisableKeepAlives，
// 63MB 视频 16 个分片 = 16 次 TCP+TLS 握手；② 按任意起点切窗让磁盘缓存按片段碎片化，
// 一个视频被存成 230MB（放大 3.82×）。改成「Range 原样转发 + 不切片 + 长连接」后，
// 首包只等上游首字节，播放不再卡在磁盘/握手开销上。
//
// 不带 Range 的请求（图片全走这条）**完全不碰这里**：图片要靠
// detectProxyMediaContentType 嗅探 magic bytes 兜底源站错误的 Content-Type，必须拿到完整字节，
// 仍旧走 FetchMedia 的缓冲实现。

// MediaStream 流式转发的结果：Body 直接是上游的响应体，调用方边读边下发。
type MediaStream struct {
	Body        io.ReadCloser
	ContentType string
	// StatusCode 上游状态码：206 片段 / 200 整段 / 416 越界（也用于缓存命中回放）
	StatusCode int
	// ContentRange 206 / 416 原样带给浏览器（`bytes 0-4194303/63176469` 或 `bytes */63176469`）
	ContentRange string
	// ContentLength 本段字节数；-1 表示上游没给（分块传输），此时不要设 Content-Length
	ContentLength int64
	AcceptRanges  string
}

// FetchMediaStream 与 FetchMedia 同一条请求管线，区别是上游回 206/200 时直接把 body
// 交出去，不 ReadAll、不切片、不改 Content-Range —— 边收边发，首包只等上游首字节。
//
// 缓存策略：只有「无 Range 的 200 整段」查/写缓存；任何 Range 请求都不缓存
// （按片段缓存会碎片化放大，见 FetchMedia 注释）。Range 不落盘也就不会回放脏数据。
func (s *proxyService) FetchMediaStream(ctx context.Context, mediaURL, refererURL, rangeHeader string) (*MediaStream, error) {
	// 先校验 Range：畸形/多段/未知单位一律返回 ErrRangeNotSatisfiable，
	// 由 handler 回 416，绝不把它们转发给上游换来一次整段下载。
	forwardRange, err := normalizeProxyRange(rangeHeader)
	if err != nil {
		return nil, err
	}

	var cacheable bool
	if forwardRange == "" && s.mediaCache != nil {
		if hit, ok := s.mediaCache.Get(mediaURL); ok {
			logger.Debug("proxy media cache hit", "module", "service", "action", "fetch", "resource", "proxy", "result", "ok", "host", safeHostLog(mediaURL))
			return &MediaStream{
				Body:          io.NopCloser(bytes.NewReader(hit.Data)),
				ContentType:   hit.ContentType,
				StatusCode:    hit.StatusCode,
				ContentRange:  hit.ContentRange,
				ContentLength: int64(len(hit.Data)),
				AcceptRanges:  hit.AcceptRanges,
			}, nil
		}
		cacheable = true
	}

	resp, _, err := s.openStandardMediaResponse(ctx, mediaURL, refererURL, forwardRange)
	if err != nil {
		// 标准客户端失败（反爬 / Anubis 挑战页）：退回 azuretls 缓冲取整段。
		// 这条路没有流式可言，但至少「能播」——与 FetchMedia 的兜底同一套行为。
		logger.Debug("proxy stream standard client failed, falling back", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "error", err)
		return s.fetchMediaStreamFallback(ctx, mediaURL, refererURL, cacheable)
	}

	// 416 越界：原样透传上游的 416 与 `Content-Range: bytes */total`，
	// 不再当成 ErrFetchFailed（否则 handler default 分支会回 500）。
	if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		contentType := resp.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "text/plain; charset=utf-8"
		}
		return &MediaStream{
			Body:          resp.Body,
			ContentType:   contentType,
			StatusCode:    resp.StatusCode,
			ContentRange:  resp.Header.Get("Content-Range"),
			ContentLength: resp.ContentLength,
			AcceptRanges:  "bytes",
		}, nil
	}

	contentType, body, err := streamContentType(resp)
	if err != nil {
		_ = resp.Body.Close()
		return nil, err
	}

	// 边发边写缓存：只有 200 整段才落盘；读到 EOF 才 rename，客户端中途断开就丢临时文件。
	var writer *mediaCacheWriter
	if cacheable && resp.StatusCode == http.StatusOK {
		// 建 writer 失败（磁盘满/无权限）不影响播放：拿不到就纯转发
		writer, _ = s.mediaCache.newWriter(mediaURL, mediaCacheMeta{
			ContentType:  contentType,
			StatusCode:   resp.StatusCode,
			AcceptRanges: "bytes",
		})
	}

	return &MediaStream{
		Body:          newCacheWritingBody(body, resp.Body, writer),
		ContentType:   contentType,
		StatusCode:    resp.StatusCode,
		ContentRange:  resp.Header.Get("Content-Range"),
		ContentLength: resp.ContentLength,
		AcceptRanges:  "bytes",
	}, nil
}

// streamContentType 定 Content-Type，尽量不消费 body：
// 上游 header 可信（video/*、audio/*、image/*）就直接用，一个字节都不 Peek，
// 首包延迟完全交给网络；只有 header 不可信（application/octet-stream 之类）
// 才 Peek 512 字节嗅探 —— Peek 不消费数据，返回的 reader 仍从第一字节开始。
func streamContentType(resp *http.Response) (string, io.Reader, error) {
	header := resp.Header.Get("Content-Type")
	normalized := strings.ToLower(strings.TrimSpace(strings.Split(header, ";")[0]))
	if isProxyableMediaType(normalized) {
		return normalized, resp.Body, nil
	}

	br := bufio.NewReaderSize(resp.Body, 512)
	peek, _ := br.Peek(512)
	contentType, err := detectProxyMediaContentType(header, peek)
	if err != nil {
		return "", nil, err
	}
	return contentType, br, nil
}

// cacheWritingBody 把「边读边写缓存」包在响应体外面。
//
// reader 与 closer 分开传：嗅探分支下 reader 是 bufio.Reader，真正要关的
// 还是上游的 resp.Body。
type cacheWritingBody struct {
	reader io.Reader
	closer io.Closer
	writer *mediaCacheWriter
	done   bool
}

func newCacheWritingBody(reader io.Reader, closer io.Closer, writer *mediaCacheWriter) *cacheWritingBody {
	return &cacheWritingBody{reader: reader, closer: closer, writer: writer}
}

func (b *cacheWritingBody) Read(p []byte) (int, error) {
	n, err := b.reader.Read(p)
	if n > 0 && b.writer != nil {
		if _, werr := b.writer.Write(p[:n]); werr != nil {
			// 写盘失败或超过单件上限：放弃缓存，但这一段的字节照旧回给客户端
			// （writer.Write 内部已经 Abort 掉临时文件）。
			b.writer = nil
		}
	}
	switch {
	case err == io.EOF:
		b.finish()
	case err != nil:
		b.abort()
	}
	return n, err
}

// Close 在没读到 EOF 时被调用 = 客户端提前断开（拖动进度条/关页面）：
// 丢弃临时文件，绝不把半截片段 rename 成缓存条目 —— 否则下次命中会回一段
// 短于 Content-Range 的数据，播放器直接卡死。
func (b *cacheWritingBody) Close() error {
	b.abort()
	return b.closer.Close()
}

func (b *cacheWritingBody) finish() {
	if b.done {
		return
	}
	b.done = true
	if b.writer != nil {
		b.writer.Commit()
		b.writer = nil
	}
}

func (b *cacheWritingBody) abort() {
	if b.done {
		return
	}
	b.done = true
	if b.writer != nil {
		b.writer.Abort()
		b.writer = nil
	}
}

// fetchMediaStreamFallback 标准客户端失败时的兜底：azuretls 会话取整段、整段回放。
// 这条路不带 Range（azuretls 不转发客户端 Range），所以只能给 200 整段——
// 浏览器能播，只是不能精确 seek。只在反爬站点上走到，宁可让步 seek 也不能让这类源站播不了。
func (s *proxyService) fetchMediaStreamFallback(ctx context.Context, mediaURL, refererURL string, cacheable bool) (*MediaStream, error) {
	result, err := s.fetchImageWithRetry(ctx, mediaURL, refererURL, "", 0)
	if err != nil {
		return nil, err
	}
	if cacheable && result.StatusCode == http.StatusOK {
		s.mediaCache.Put(mediaURL, result)
	}
	return &MediaStream{
		Body:          io.NopCloser(bytes.NewReader(result.Data)),
		ContentType:   result.ContentType,
		StatusCode:    result.StatusCode,
		ContentRange:  result.ContentRange,
		ContentLength: int64(len(result.Data)),
		AcceptRanges:  "bytes",
	}, nil
}
