package service

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"krss/backend/pkg/logger"
)

// 流式转发（fix/video-proxy-stream）。
//
// 为什么纯流式：Range 原样转发给上游，上游回 206 就边收边发，首包只等上游首字节；
// 回 200 就整段流式下发（能播、只是不能精确 seek）。不做任何人工窗口切片。
//
// 缓存策略（第四轮）：
//   - 「整段」才落盘。从头开始的开放式 Range（bytes=0-，浏览器首播就是它）在流式转发
//     的同时把上游字节 tee 到临时文件，读完且字节数与已知总长吻合才 Commit 成一条
//     整文件缓存。之后任何 Range 都直接从磁盘按区间切片返回 206，不再出网。
//   - 按片段缓存会按任意起点碎片化放大（实测 3.82×），所以只存整文件。
//   - 不带 Range 的请求（图片全走这条）仍走 FetchMedia 的缓冲实现（要嗅探 Content-Type）。

// fallbackMediaTimeout azuretls 兜底的整体上限：标准客户端已经失败过一次，
// 兜底再无限等下去只会让前端干等到超时（实测失败视频 36–50s 才回 500）。
const fallbackMediaTimeout = 60 * time.Second

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

// mediaStreamFromResult 把一次缓存命中（整段或磁盘切片）包成可读的 MediaStream。
func mediaStreamFromResult(r *ProxyResult) *MediaStream {
	length := int64(len(r.Data))
	if r.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		length = 0
	}
	return &MediaStream{
		Body:          io.NopCloser(bytes.NewReader(r.Data)),
		ContentType:   r.ContentType,
		StatusCode:    r.StatusCode,
		ContentRange:  r.ContentRange,
		ContentLength: length,
		AcceptRanges:  r.AcceptRanges,
	}
}

// FetchMediaStream 与 FetchMedia 同一条请求管线，区别是上游回 206/200 时直接把 body
// 交出去，不 ReadAll、不切片、不改 Content-Range —— 边收边发，首包只等上游首字节。
func (s *proxyService) FetchMediaStream(ctx context.Context, mediaURL, refererURL, rangeHeader string) (*MediaStream, error) {
	// 先校验 Range：畸形/多段/未知单位一律 ErrRangeNotSatisfiable（handler 回 416），
	// 绝不把它们转发给上游换来一次整段下载。
	forwardRange, err := normalizeProxyRange(rangeHeader)
	if err != nil {
		return nil, err
	}
	hasRange := forwardRange != ""
	var spec mediaRange
	if hasRange {
		if spec, err = parseMediaRange(forwardRange); err != nil {
			return nil, err
		}
	}

	// 1) 先查缓存：整文件缓存能同时回答「无 Range 全量」和「任意 Range 片段」，
	//    Range 直接从磁盘切片，完全不出网。
	if s.mediaCache != nil {
		if hasRange {
			if hit, ok := s.mediaCache.GetRange(mediaURL, spec); ok {
				logger.Debug("proxy media cache range hit", "module", "service", "action", "fetch", "resource", "proxy", "result", "ok", "host", safeHostLog(mediaURL))
				return mediaStreamFromResult(hit), nil
			}
		} else if hit, ok := s.mediaCache.Get(mediaURL); ok {
			logger.Debug("proxy media cache hit", "module", "service", "action", "fetch", "resource", "proxy", "result", "ok", "host", safeHostLog(mediaURL))
			return mediaStreamFromResult(hit), nil
		}
	}

	resp, _, err := s.openStandardMediaResponse(ctx, mediaURL, refererURL, forwardRange)
	if err != nil {
		// 标准客户端失败（反爬 / Anubis 挑战页）：退回 azuretls 取整段，本地按 Range 切片。
		logger.Debug("proxy stream standard client failed, falling back", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "error", err)
		return s.fetchMediaStreamFallback(ctx, mediaURL, refererURL, forwardRange, hasRange)
	}

	// 416 越界：原样透传上游的 416 与 `Content-Range: bytes */total`。
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
			AcceptRanges:  resp.Header.Get("Accept-Ranges"),
		}, nil
	}

	contentType, body, err := streamContentType(resp)
	if err != nil {
		_ = resp.Body.Close()
		return nil, err
	}

	// 2) 决定是否把整段 tee 到磁盘（只对「从头开始」的请求；见 streamCacheTotal）。
	var writer *mediaCacheWriter
	if total, ok := s.streamCacheTotal(resp, spec, hasRange); ok {
		if s.mediaCache.beginFill(mediaURL) {
			meta := mediaCacheMeta{
				ContentType:   contentType,
				StatusCode:    http.StatusOK,
				AcceptRanges:  resp.Header.Get("Accept-Ranges"),
				ContentLength: total,
				ContentRange:  fmt.Sprintf("bytes 0-%d/%d", total-1, total),
			}
			w, werr := s.mediaCache.newWriter(mediaURL, meta, total)
			if werr == nil {
				w.onDone = func() { s.mediaCache.endFill(mediaURL) }
				writer = w
			} else {
				// 建 writer 失败（磁盘满/无权限）不影响播放：释放标记，纯转发。
				s.mediaCache.endFill(mediaURL)
			}
		}
	}

	return &MediaStream{
		Body:          newCacheWritingBody(body, resp.Body, writer, resp.ContentLength, safeHostLog(mediaURL)),
		ContentType:   contentType,
		StatusCode:    resp.StatusCode,
		ContentRange:  resp.Header.Get("Content-Range"),
		ContentLength: resp.ContentLength,
		AcceptRanges:  resp.Header.Get("Accept-Ranges"),
	}, nil
}

// streamCacheTotal 判断这次响应能不能整段落盘，能就返回总字节数。
//
// 只在「从头开始」时 tee：
//   - 有 Range：必须是开放式 `bytes=0-`（start=0 且无结束），否则只是一段中间片段，
//     单存它没意义（凑不成整文件）。
//   - 无 Range：整段 200。
//
// 总长必须可信（Content-Range 的 total / Content-Length > 0）；分块传输（长度未知）不写。
func (s *proxyService) streamCacheTotal(resp *http.Response, spec mediaRange, hasRange bool) (int64, bool) {
	if s.mediaCache == nil {
		return 0, false
	}
	if hasRange {
		if spec.suffix != 0 || spec.start != 0 || spec.end != -1 {
			return 0, false
		}
		if resp.StatusCode == http.StatusPartialContent {
			if total, ok := totalFromContentRange(resp.Header.Get("Content-Range")); ok {
				if resp.ContentLength >= 0 && resp.ContentLength != total {
					return 0, false // 声明长度与 Content-Range 不一致，不可信
				}
				return total, total > 0 && total <= maxCacheableMediaBytes
			}
			// 没有 Content-Range 就退回 Content-Length（`bytes=0-` 的 206 长度就是总长）
			if resp.ContentLength > 0 {
				return resp.ContentLength, resp.ContentLength <= maxCacheableMediaBytes
			}
			return 0, false
		}
		// 上游无视 Range 回 200 整段：也能整段落盘
		if resp.StatusCode == http.StatusOK && resp.ContentLength > 0 {
			return resp.ContentLength, resp.ContentLength <= maxCacheableMediaBytes
		}
		return 0, false
	}
	if resp.StatusCode != http.StatusOK {
		return 0, false
	}
	if resp.ContentLength <= 0 {
		return 0, false // chunked 未知长度不 tee
	}
	return resp.ContentLength, resp.ContentLength <= maxCacheableMediaBytes
}

// totalFromContentRange 从 `bytes 0-4194303/63176469` 取出总长 63176469。
func totalFromContentRange(value string) (int64, bool) {
	value = strings.TrimSpace(value)
	slash := strings.LastIndexByte(value, '/')
	if slash < 0 {
		return 0, false
	}
	total, err := strconv.ParseInt(strings.TrimSpace(value[slash+1:]), 10, 64)
	if err != nil || total <= 0 {
		return 0, false
	}
	return total, true
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

// cacheWritingBody 把「边读边写缓存」和「声明长度校验」包在响应体外面。
//
// reader 与 closer 分开传：嗅探分支下 reader 是 bufio.Reader，真正要关的
// 还是上游的 resp.Body。
type cacheWritingBody struct {
	reader   io.Reader
	closer   io.Closer
	writer   *mediaCacheWriter
	declared int64 // 上游声明的 Content-Length；-1 = 未知（分块）
	host     string
	count    int64 // 实际读出的字节数
	done     bool
}

func newCacheWritingBody(reader io.Reader, closer io.Closer, writer *mediaCacheWriter, declared int64, host string) *cacheWritingBody {
	return &cacheWritingBody{reader: reader, closer: closer, writer: writer, declared: declared, host: host}
}

func (b *cacheWritingBody) Read(p []byte) (int, error) {
	n, err := b.reader.Read(p)
	if n > 0 {
		b.count += int64(n)
		if b.writer != nil {
			if _, werr := b.writer.Write(p[:n]); werr != nil {
				// 写盘失败或超过单件上限：放弃缓存，但这一段的字节照旧回给客户端
				// （writer.Write 内部已经 Abort 掉临时文件）。
				b.writer = nil
			}
		}
	}
	switch {
	case errors.Is(err, io.EOF):
		b.finish()
		// P2-2：上游声明的 Content-Length 与实际写出的不一致时，不能「安静地」短
		// 这么多就结束（客户端会以为收到了完整响应）。返回错误 → handler 的 io.Copy
		// 中止 → 连接关闭，客户端看到的是截断而不是「成功但短」。
		if b.declared >= 0 && b.count != b.declared {
			logger.Warn("proxy stream content length mismatch", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "host", b.host, "declared", b.declared, "actual", b.count)
			return n, fmt.Errorf("proxy stream content length mismatch: declared %d, got %d", b.declared, b.count)
		}
	case err != nil:
		b.abort()
	}
	return n, err
}

// Close 在没读到 EOF 时被调用 = 客户端提前断开（拖动进度条/关页面）：
// 丢弃临时文件，绝不把半截片段 rename 成缓存条目。
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

// fetchMediaStreamFallback 标准客户端失败时的兜底：azuretls 会话取整段，本地按 Range 切片。
//
// 必修1（P0 回归）：以前这里把客户端 Range 丢了，兜底固定回 200 整段 + 宣称
// Accept-Ranges: bytes —— 浏览器判定「不支持 Range」，回 0 重播、seek 失效、
// 首包等整文件下完。现在拿到整段后按同一段 Range 本地切片回 206 + Content-Range，
// 起点越界回 416 + `bytes */total`。
func (s *proxyService) fetchMediaStreamFallback(ctx context.Context, mediaURL, refererURL, forwardRange string, hasRange bool) (*MediaStream, error) {
	start := time.Now()
	fctx, cancel := context.WithTimeout(ctx, fallbackMediaTimeout)
	defer cancel()

	var result *ProxyResult
	var err error
	if s.fallbackMedia != nil {
		result, err = s.fallbackMedia(fctx, mediaURL, refererURL)
	} else {
		result, err = s.fetchImageWithRetry(fctx, mediaURL, refererURL, "", 0)
	}
	if err != nil {
		// P2-4：兜底失败以前只 Debug，失败视频要 36–50s 才回 500 且日志里看不到。
		logger.Warn("proxy media fallback failed", "module", "service", "action", "fetch", "resource", "proxy", "result", "failed", "host", safeHostLog(mediaURL), "duration_ms", time.Since(start).Milliseconds(), "error", err)
		if fctx.Err() != nil {
			return nil, ErrRequestTimeout
		}
		return nil, err
	}

	if !hasRange {
		if s.mediaCache != nil && result.StatusCode == http.StatusOK {
			s.mediaCache.Put(mediaURL, result)
		}
		return mediaStreamFromResult(result), nil
	}

	spec, perr := parseMediaRange(forwardRange)
	if perr != nil {
		return nil, perr
	}
	chunk, contentRange, status := sliceMediaBytes(result.Data, spec)
	acceptRanges := result.AcceptRanges
	if acceptRanges == "" {
		acceptRanges = "bytes"
	}
	return &MediaStream{
		Body:          io.NopCloser(bytes.NewReader(chunk)),
		ContentType:   result.ContentType,
		StatusCode:    status,
		ContentRange:  contentRange,
		ContentLength: int64(len(chunk)),
		AcceptRanges:  acceptRanges,
	}, nil
}
