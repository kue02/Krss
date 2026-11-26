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

// 流式转发（fix/video-proxy-stream 第二轮）。
//
// 为什么还要流式：第一轮把 Range 真的发给上游、并把开放式窗口收成 4MiB 之后，
// 缓存命中的第二次请求只要 0.0037s，但**首次** `bytes=0-` 仍要等整个 4MiB
// 窗口下载完才发出第一个字节（实测 TTFB 14.96s）—— 用户看到的就是十几秒黑屏。
// 视频播放器只在乎「第一帧什么时候到」，所以这里改成边收边发：上游吐多少就
// 往下游写多少，读完再把整窗落到缓存。
//
// 不带 Range 的请求（图片全走这条）**完全不碰这条路径**：图片要靠
// detectProxyMediaContentType 嗅探 magic bytes 兜底源站错误的 Content-Type，
// 必须拿到完整字节，所以仍旧走 FetchMedia 的缓冲实现。

// MediaStream 流式转发的结果：Body 直接是上游的响应体，调用方边读边下发。
type MediaStream struct {
	Body        io.ReadCloser
	ContentType string
	// StatusCode 上游状态码：206 片段 / 200 整段（也用于缓存命中回放）
	StatusCode int
	// ContentRange 206 必须原样带给浏览器（`bytes 0-4194303/63176469`），
	// 少了它 <video> 不知道总长、也没法接着要下一段。
	ContentRange string
	// ContentLength 本段字节数；-1 表示上游没给（分块传输），此时不要设 Content-Length
	ContentLength int64
	AcceptRanges  string
}

// FetchMediaStream 与 FetchMedia 同一条管线（同样的窗口改写、同样的缓存键），
// 区别只有一个：上游认 Range 回 206 时把 body 直接交出去，不 ReadAll。
//
// 上游不认 Range（回 200）时仍退回缓冲 + sliceByRange：要自己算
// `Content-Range` 就必须知道总长，流式给不出这个数。这条分支只在少数
// 不实现 Range 的源站上走到，正常视频 CDN 都认。
func (s *proxyService) FetchMediaStream(ctx context.Context, mediaURL, refererURL, rangeHeader string) (*MediaStream, error) {
	upstreamRange := clampOpenEndedRange(rangeHeader, mediaChunkBytes)
	cacheKey := mediaCacheKey(mediaURL, upstreamRange)
	cacheable := s.mediaCache != nil

	if cacheable {
		if hit, ok := s.mediaCache.Get(cacheKey); ok {
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
	}

	resp, parsedURL, err := s.openStandardMediaResponse(ctx, mediaURL, refererURL, upstreamRange)
	if err != nil {
		// 标准客户端失败（反爬 / Anubis 挑战页）：退回 azuretls 缓冲取整段，
		// 再按 Range 本地切片。这条路没有流式可言，但至少「能播」——
		// 与 FetchMedia 的兜底保持同一套行为，别让流式入口变成新的失败点。
		logger.Debug("proxy stream standard client failed, falling back", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "error", err)
		return s.fetchMediaStreamFallback(ctx, mediaURL, refererURL, upstreamRange, cacheKey, cacheable)
	}

	// 上游没理 Range：必须缓冲后本地切片（要自己算 Content-Range 得先知道总长），
	// 这条分支没有流式可言，但它本来也只在「源站不支持 Range」时才出现。
	if upstreamRange != "" && resp.StatusCode == http.StatusOK {
		result, bufErr := bufferStandardMediaResponse(resp, parsedURL, upstreamRange)
		_ = resp.Body.Close()
		if bufErr != nil {
			return nil, bufErr
		}
		if cacheable && isCacheableProxyStatus(result.StatusCode) {
			s.mediaCache.Put(cacheKey, result)
		}
		return &MediaStream{
			Body:          io.NopCloser(bytes.NewReader(result.Data)),
			ContentType:   result.ContentType,
			StatusCode:    result.StatusCode,
			ContentRange:  result.ContentRange,
			ContentLength: int64(len(result.Data)),
			AcceptRanges:  result.AcceptRanges,
		}, nil
	}

	contentType, body, err := streamContentType(resp)
	if err != nil {
		_ = resp.Body.Close()
		return nil, err
	}

	statusCode := resp.StatusCode
	contentRange := resp.Header.Get("Content-Range")

	// 边发边写缓存：读满（EOF）才 rename 成正式条目，客户端中途断开就丢临时文件。
	var writer *mediaCacheWriter
	if cacheable && isCacheableProxyStatus(statusCode) {
		// 建 writer 失败（磁盘满/无权限）不该影响播放：拿不到 writer 就纯转发
		writer, _ = s.mediaCache.newWriter(cacheKey, mediaCacheMeta{
			ContentType:  contentType,
			StatusCode:   statusCode,
			AcceptRanges: "bytes",
			ContentRange: contentRange,
		})
	}

	return &MediaStream{
		Body:          newCacheWritingBody(body, resp.Body, writer),
		ContentType:   contentType,
		StatusCode:    statusCode,
		ContentRange:  contentRange,
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

// fetchMediaStreamFallback 标准客户端失败时的兜底：azuretls 会话取整段，
// 需要 Range 就在本地切片。这条路是缓冲的（拿不到流式 body），但它只在
// 反爬站点上走到 —— 宁可首包慢一点，也不能因为改成流式就让这类源站播不了。
func (s *proxyService) fetchMediaStreamFallback(ctx context.Context, mediaURL, refererURL, upstreamRange, cacheKey string, cacheable bool) (*MediaStream, error) {
	result, err := s.fetchImageWithRetry(ctx, mediaURL, refererURL, "", 0)
	if err != nil {
		return nil, err
	}
	// azuretls 这条路不带 Range（见 FetchMedia 里的同款注释）：只有本来就没
	// Range 的请求才能按这个键缓存，否则会把整段当成片段存进片段键里。
	if cacheable && upstreamRange == "" && isCacheableProxyStatus(result.StatusCode) {
		s.mediaCache.Put(cacheKey, result)
	}
	if upstreamRange != "" && result.StatusCode == http.StatusOK {
		if sliced, derivedRange, derivedStatus := sliceByRange(result.Data, upstreamRange); derivedStatus == http.StatusPartialContent {
			result = &ProxyResult{
				Data:         sliced,
				ContentType:  result.ContentType,
				StatusCode:   derivedStatus,
				ContentRange: derivedRange,
				AcceptRanges: "bytes",
			}
		}
	}
	return &MediaStream{
		Body:          io.NopCloser(bytes.NewReader(result.Data)),
		ContentType:   result.ContentType,
		StatusCode:    result.StatusCode,
		ContentRange:  result.ContentRange,
		ContentLength: int64(len(result.Data)),
		AcceptRanges:  result.AcceptRanges,
	}, nil
}
