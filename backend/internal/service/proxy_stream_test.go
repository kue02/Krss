package service_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/service"
	"krss/backend/pkg/network"
)

/**
 * fix/video-proxy-stream 第三轮：Range 原样转发 + 纯流式 + 只缓存整段 200。
 *
 * 前两轮的教训（真实视频 63,176,469 字节）：
 *   - 第一轮把 Range 真发给上游后，206 有了，但每片都 ReadAll 整窗 → 首包慢。
 *   - 第二轮改边收边发，但保留 4MiB 人工窗口：每个窗口新建 http.Client 且
 *     transport DisableKeepAlives，16 片 = 16 次 TCP/TLS 握手；按任意起点切窗
 *     又让磁盘缓存按片段碎片化（一个视频放大到 230MB / 3.82×）。
 * 本轮：Range 原样转发、206/200 都纯流式（不切片）、长连接复用、只缓存整段 200。
 */

// mediaUpstream 一个支持 Range 的假视频源，记录命中次数与最后一次收到的 Range 头。
type mediaUpstream struct {
	server    *httptest.Server
	body      []byte
	hits      int32
	mu        sync.Mutex
	lastRange string
}

func newMediaUpstream(t *testing.T, size int) *mediaUpstream {
	t.Helper()
	body := make([]byte, size)
	for i := range body {
		body[i] = byte(i % 251)
	}
	up := &mediaUpstream{body: body}
	up.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&up.hits, 1)
		up.mu.Lock()
		up.lastRange = r.Header.Get("Range")
		up.mu.Unlock()

		w.Header().Set("Content-Type", "video/mp4")
		// ServeContent 按标准语义处理 Range：有 Range 回 206 + Content-Range，
		// 没有就回 200 整段 —— 与真实视频 CDN 行为一致。
		http.ServeContent(w, r, "v.mp4", time.Time{}, bytes.NewReader(up.body))
	}))
	t.Cleanup(up.server.Close)
	return up
}

func (u *mediaUpstream) rangeHeader() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.lastRange
}

func (u *mediaUpstream) hitCount() int32 { return atomic.LoadInt32(&u.hits) }

func newProxy(t *testing.T, cacheDir string) service.ProxyService {
	t.Helper()
	svc := service.NewProxyService(network.NewClientFactoryForTest(&http.Client{}), nil)
	if cacheDir != "" {
		svc = svc.WithMediaCache(cacheDir, 0)
	}
	return svc
}

// ---------- FetchMedia（缓冲路径，图片 / 无 Range） ----------

// 客户端要的 Range 必须真的、原样发给上游，206 与 Content-Range 原样透传。
func TestFetchMedia_ForwardsRangeHeaderAndPassesThrough206(t *testing.T) {
	const total = 8 << 20
	up := newMediaUpstream(t, total)
	svc := newProxy(t, "")

	result, err := svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "bytes=100-199")
	require.NoError(t, err)

	require.Equal(t, "bytes=100-199", up.rangeHeader(), "Range 必须原样发给上游")
	require.Equal(t, http.StatusPartialContent, result.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes 100-199/%d", total), result.ContentRange)
	require.Equal(t, up.body[100:200], result.Data)
	require.Equal(t, "video/mp4", result.ContentType)
	require.Equal(t, "bytes", result.AcceptRanges)
}

// 开放式 bytes=0- 不再收窗口，原样发给上游；上游认 Range 就回 206 整段剩余部分。
func TestFetchMedia_OpenEndedRangeForwardedVerbatim(t *testing.T) {
	const total = 8 << 20
	up := newMediaUpstream(t, total)
	svc := newProxy(t, "")

	result, err := svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-")
	require.NoError(t, err)

	require.Equal(t, "bytes=0-", up.rangeHeader(), "不再做 4MiB 人工窗口，原样转发")
	require.Equal(t, http.StatusPartialContent, result.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes 0-%d/%d", total-1, total), result.ContentRange)
}

// 无 Range 的整段请求：200 + 完整内容（图片路径行为不变）。
func TestFetchMedia_NoRangeReturnsWhole200(t *testing.T) {
	const total = 4 << 20
	up := newMediaUpstream(t, total)
	svc := newProxy(t, "")

	result, err := svc.FetchMedia(context.Background(), up.server.URL+"/p.png", "", "")
	require.NoError(t, err)
	require.Equal(t, "", up.rangeHeader(), "无 Range 请求不该带 Range 头")
	require.Equal(t, http.StatusOK, result.StatusCode)
	require.EqualValues(t, total, len(result.Data))
}

// 上游无视 Range 回 200：不再本地切片，直接 200 整段回给浏览器（能播，只是不能精确 seek）。
func TestFetchMedia_UpstreamIgnoresRangeReturnsWhole200(t *testing.T) {
	body := make([]byte, 4096)
	for i := range body {
		body[i] = byte(i % 251)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(body) // 故意忽略 Range
	}))
	t.Cleanup(server.Close)

	svc := newProxy(t, "")
	result, err := svc.FetchMedia(context.Background(), server.URL+"/v.mp4", "", "bytes=10-19")
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, result.StatusCode, "上游不认 Range 就照 200 整段回")
	require.Empty(t, result.ContentRange)
	require.Equal(t, body, result.Data)
}

// ---------- FetchMediaStream（流式路径，Range 请求） ----------

// slowChunkUpstream 分块慢写：每块写完 Flush，然后等测试放行下一块。
// 这样「读到第一块时上游还没写完」是可断言的确定状态，不靠固定 sleep 猜。
type slowChunkUpstream struct {
	server *httptest.Server
	chunks [][]byte
	status int
	// gate[i] 收到信号后才写第 i+1 块（gate[0] 无意义，第一块立即写）
	gate  []chan struct{}
	wrote int32
	mu    sync.Mutex
	last  string
}

func newSlowChunkUpstream(t *testing.T, status int, chunks ...[]byte) *slowChunkUpstream {
	t.Helper()
	up := &slowChunkUpstream{chunks: chunks, status: status, gate: make([]chan struct{}, len(chunks))}
	for i := range up.gate {
		up.gate[i] = make(chan struct{})
	}
	up.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up.mu.Lock()
		up.last = r.Header.Get("Range")
		up.mu.Unlock()

		total := 0
		for _, c := range chunks {
			total += len(c)
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Accept-Ranges", "bytes")
		// 显式给出整段长度：真实 CDN 都会给，流式落盘也只信任可信长度（chunked 不写缓存）。
		w.Header().Set("Content-Length", strconv.Itoa(total))
		if status == http.StatusPartialContent {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", total-1, total))
		}
		w.WriteHeader(status)
		for i, chunk := range up.chunks {
			if i > 0 {
				select {
				case <-up.gate[i]:
				case <-r.Context().Done():
					return
				}
			}
			if _, err := w.Write(chunk); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			atomic.AddInt32(&up.wrote, int32(i+1))
		}
	}))
	t.Cleanup(up.server.Close)
	return up
}

func (u *slowChunkUpstream) written() int  { return int(atomic.LoadInt32(&u.wrote)) }
func (u *slowChunkUpstream) release(i int) { close(u.gate[i]) }
func (u *slowChunkUpstream) rangeHeader() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.last
}

// P2-6：流式路径必须把客户端 Range 原样发给上游（不再改写，应完全相等）。
func TestFetchMediaStream_ForwardsRangeHeaderVerbatim(t *testing.T) {
	for _, rangeHeader := range []string{"bytes=0-", "bytes=100-199", "bytes=1000000-", "bytes=-500"} {
		t.Run(rangeHeader, func(t *testing.T) {
			up := newSlowChunkUpstream(t, http.StatusPartialContent, bytes.Repeat([]byte("a"), 256))
			svc := newProxy(t, "")

			stream, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", rangeHeader)
			require.NoError(t, err)
			_, err = io.ReadAll(stream.Body)
			require.NoError(t, err)
			require.NoError(t, stream.Body.Close())

			require.Equal(t, rangeHeader, up.rangeHeader(), "Range 必须原样发给上游")
		})
	}
}

// 畸形 Range 必须在我们这层就被挡掉（ErrRangeNotSatisfiable），绝不能打到上游。
func TestFetchMediaStream_MalformedRangeRejectedWithoutUpstream(t *testing.T) {
	for _, rangeHeader := range []string{"Foo=0-", "bytes=abc-", "bytes=0-1,4-5", "bytes=-"} {
		t.Run(rangeHeader, func(t *testing.T) {
			up := newMediaUpstream(t, 1024)
			svc := newProxy(t, "")

			_, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", rangeHeader)
			require.ErrorIs(t, err, service.ErrRangeNotSatisfiable)
			require.Zero(t, up.hitCount(), "畸形 Range 不能转发给上游")
		})
	}
}

// 关键断言：FetchMediaStream 返回时只读到第一块，上游还在等放行写第二块 ——
// 也就是「没有等整个响应下载完」。
func TestFetchMediaStream_ReturnsBeforeUpstreamFinishes(t *testing.T) {
	first := bytes.Repeat([]byte("a"), 1024)
	second := bytes.Repeat([]byte("b"), 1024)
	third := bytes.Repeat([]byte("c"), 1024)
	up := newSlowChunkUpstream(t, http.StatusPartialContent, first, second, third)

	svc := newProxy(t, "")
	stream, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-")
	require.NoError(t, err)
	defer stream.Body.Close()

	require.Equal(t, http.StatusPartialContent, stream.StatusCode)
	require.Equal(t, "video/mp4", stream.ContentType)
	require.Equal(t, "bytes", stream.AcceptRanges)

	// FetchMediaStream 返回时上游可能还没写出第一块（只发出了响应头），
	// 关键是它没写完：第 2、3 块还卡在 gate 上。
	require.Less(t, up.written(), 3, "FetchMediaStream 返回时上游不该已经写完")

	got := make([]byte, len(first))
	_, err = io.ReadFull(stream.Body, got)
	require.NoError(t, err, "第一块必须立刻可读")
	require.Equal(t, first, got)
	require.Less(t, up.written(), 3, "读到第一块时上游仍在等第二、三块")

	up.release(1)
	up.release(2)
	rest, err := io.ReadAll(stream.Body)
	require.NoError(t, err)
	require.Equal(t, append(append([]byte{}, second...), third...), rest)
}

// P2-5：上游回 200 且体积很大（80MiB）时也必须流式转发成功，不能因为超过
// maxProxyMediaBytes（64MiB）就 502 —— 流式路径根本不 ReadAll。
func TestFetchMediaStream_StreamsLarge200BodyWithoutSizeLimit(t *testing.T) {
	const block = 1 << 20
	const blocks = 80 // 80 MiB
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusOK)
		buf := bytes.Repeat([]byte("q"), block)
		for i := 0; i < blocks; i++ {
			if _, err := w.Write(buf); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)

	svc := newProxy(t, "") // 不挂缓存，避免 80MiB 超 maxCacheableMediaBytes 的干扰
	stream, err := svc.FetchMediaStream(context.Background(), server.URL+"/v.mp4", "", "bytes=0-")
	require.NoError(t, err, "上游忽略 Range 回 200 时也不该 502")
	defer stream.Body.Close()

	require.Equal(t, http.StatusOK, stream.StatusCode)
	require.Equal(t, "video/mp4", stream.ContentType)

	n, err := io.Copy(io.Discard, stream.Body)
	require.NoError(t, err)
	require.EqualValues(t, block*blocks, n, "整段 80MiB 都要流式转发出去")
}

// 无 Range 的整段 200 读完后落缓存；第二次命中、不再出网。
func TestFetchMediaStream_CachesWhole200AfterFullRead(t *testing.T) {
	chunk := bytes.Repeat([]byte("x"), 2048)
	up := newSlowChunkUpstream(t, http.StatusOK, chunk)
	svc := newProxy(t, t.TempDir())

	stream, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "")
	require.NoError(t, err)
	replay, err := io.ReadAll(stream.Body)
	require.NoError(t, err)
	require.Equal(t, chunk, replay)
	require.NoError(t, stream.Body.Close())

	files, bytesCached := svc.MediaCacheStats()
	require.Equal(t, 1, files, "读完整段 200 后必须留下一个缓存条目")
	require.GreaterOrEqual(t, bytesCached, int64(len(chunk)), "落盘含元信息头，必然不小于原始字节")

	second, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "")
	require.NoError(t, err)
	defer second.Body.Close()
	replay2, err := io.ReadAll(second.Body)
	require.NoError(t, err)
	require.Equal(t, chunk, replay2)
	require.Equal(t, http.StatusOK, second.StatusCode)
	require.Equal(t, 1, up.written(), "第二次必须命中缓存、不再出网")
}

// 客户端只读一半就断开：缓存目录不能留下半截条目（.bin 与 .tmp 都不许有）。
func TestFetchMediaStream_ClientAbortLeavesNoPartialCache(t *testing.T) {
	first := bytes.Repeat([]byte("a"), 1024)
	second := bytes.Repeat([]byte("b"), 1024)
	up := newSlowChunkUpstream(t, http.StatusOK, first, second)

	cacheDir := t.TempDir()
	svc := newProxy(t, cacheDir)

	stream, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "")
	require.NoError(t, err)

	got := make([]byte, 512)
	_, err = io.ReadFull(stream.Body, got)
	require.NoError(t, err)
	require.NoError(t, stream.Body.Close(), "模拟播放器中途断开")

	// Close 是同步的：临时文件当场就该删掉，不用等 prune
	entries := collectCacheFiles(t, cacheDir)
	require.Empty(t, entries, "断开后不能留下半截缓存（实际 %v）", entries)

	files, _ := svc.MediaCacheStats()
	require.Zero(t, files)
}

// collectCacheFiles 列出缓存目录下所有文件（含 .tmp），用于断言「什么都没留下」。
func collectCacheFiles(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, relErr := filepath.Rel(dir, path)
			if relErr == nil {
				out = append(out, rel)
			}
		}
		return nil
	})
	require.NoError(t, err)
	return out
}

// 上游 header 不可信（octet-stream）时仍要嗅探出 video/mp4，且不能吃掉首字节。
func TestFetchMediaStream_SniffsContentTypeWithoutLosingBytes(t *testing.T) {
	payload := append([]byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'}, bytes.Repeat([]byte("z"), 1000)...)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(payload)-1, len(payload)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(payload)
	}))
	t.Cleanup(server.Close)

	svc := newProxy(t, "")
	stream, err := svc.FetchMediaStream(context.Background(), server.URL+"/v.mp4", "", "bytes=0-")
	require.NoError(t, err)
	defer stream.Body.Close()

	data, err := io.ReadAll(stream.Body)
	require.NoError(t, err)
	require.Equal(t, "video/mp4", stream.ContentType, "header 不可信时要靠内容嗅探")
	require.Equal(t, payload, data, "嗅探不能吞掉开头的字节")
}

// 上游对越界 Range 回 416：必须原样透传 416 + Content-Range: bytes */total。
func TestFetchMediaStream_PassesThrough416(t *testing.T) {
	const total = 1024
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", total))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
	}))
	t.Cleanup(server.Close)

	svc := newProxy(t, "")
	stream, err := svc.FetchMediaStream(context.Background(), server.URL+"/v.mp4", "", "bytes=999999999-")
	require.NoError(t, err)
	defer stream.Body.Close()

	require.Equal(t, http.StatusRequestedRangeNotSatisfiable, stream.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes */%d", total), stream.ContentRange)
}

// ---------- 第四轮新增 ----------

// 必修1（P0 回归）：标准客户端失败退 azuretls 兜底时，必须按 Range 本地切片回 206，
// 不能回 200 整段（那会让浏览器判定「不支持 Range」→ 回 0 重播、seek 失效）。
func TestFetchMediaStream_FallbackSlicesRequestedRange(t *testing.T) {
	body := make([]byte, 4096)
	for i := range body {
		body[i] = byte(i % 251)
	}
	failClient := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("standard client boom")
	})}
	svc := service.NewProxyService(network.NewClientFactoryForTest(failClient), nil)
	service.SetProxyServiceFallbackForTest(svc, func(context.Context, string, string) (*service.ProxyResult, error) {
		return &service.ProxyResult{Data: body, ContentType: "video/mp4", StatusCode: http.StatusOK, AcceptRanges: "bytes"}, nil
	})

	stream, err := svc.FetchMediaStream(context.Background(), "https://cdn.example.com/v.mp4", "", "bytes=1000-")
	require.NoError(t, err)
	defer stream.Body.Close()
	require.Equal(t, http.StatusPartialContent, stream.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes 1000-4095/%d", len(body)), stream.ContentRange)
	require.EqualValues(t, len(body)-1000, stream.ContentLength)
	got, err := io.ReadAll(stream.Body)
	require.NoError(t, err)
	require.Equal(t, body[1000:], got, "兜底也必须按 Range 切出正确的字节")

	// 起点越界：416 + `bytes */total`
	stream2, err := svc.FetchMediaStream(context.Background(), "https://cdn.example.com/v.mp4", "", "bytes=999999-")
	require.NoError(t, err)
	defer stream2.Body.Close()
	require.Equal(t, http.StatusRequestedRangeNotSatisfiable, stream2.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes */%d", len(body)), stream2.ContentRange)
}

// 必修3（P1）①：bytes=0- 首播流式并 tee 落盘；之后同 URL 的任意 Range 直接从磁盘切片，
// 上游只被调用一次。
func TestFetchMediaStream_CachesWholeFileThenServesRangeFromDisk(t *testing.T) {
	const total = 4 << 20
	up := newMediaUpstream(t, total)
	cacheDir := t.TempDir()
	svc := newProxy(t, cacheDir)

	first, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-")
	require.NoError(t, err)
	n, err := io.Copy(io.Discard, first.Body)
	require.NoError(t, err)
	require.EqualValues(t, total, n)
	require.NoError(t, first.Body.Close())
	require.Equal(t, int32(1), up.hitCount(), "首播出网一次")

	files, _ := svc.MediaCacheStats()
	require.Equal(t, 1, files, "整段读完必须落一个整文件缓存")

	// 任意中间片段：命中磁盘，206 + 正确 Content-Range，且不再出网。
	second, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "bytes=1000-2000")
	require.NoError(t, err)
	require.Equal(t, http.StatusPartialContent, second.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes 1000-2000/%d", total), second.ContentRange)
	require.EqualValues(t, 1001, second.ContentLength)
	got, err := io.ReadAll(second.Body)
	require.NoError(t, err)
	require.NoError(t, second.Body.Close())
	require.Equal(t, up.body[1000:2001], got)
	require.Equal(t, int32(1), up.hitCount(), "片段必须走磁盘，不再出网")

	// 无 Range 也能直接从整文件缓存回 200。
	third, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "")
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, third.StatusCode)
	all, err := io.ReadAll(third.Body)
	require.NoError(t, err)
	require.NoError(t, third.Body.Close())
	require.Equal(t, up.body, all)
	require.Equal(t, int32(1), up.hitCount(), "整段也命中缓存")
}

// 必修3 ③：超过 maxCacheableMediaBytes（256MiB）的整段不写缓存，但照常流式转发。
func TestFetchMediaStream_OversizeWholeNotCached(t *testing.T) {
	const declared = int64(300) << 20 // 300MiB > 256MiB 上限
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", strconv.FormatInt(declared, 10))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("x")) // 只写一点，不真发 300MiB
	}))
	t.Cleanup(server.Close)

	cacheDir := t.TempDir()
	svc := newProxy(t, cacheDir)
	stream, err := svc.FetchMediaStream(context.Background(), server.URL+"/v.mp4", "", "")
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, stream.StatusCode)
	// 返回时（还没读 body）就不该有临时文件：超上限时根本不建 writer。
	require.Empty(t, collectCacheFiles(t, cacheDir), "超上限不该建临时文件/缓存")
	require.NoError(t, stream.Body.Close())
}

// P2-2：上游声明的 Content-Length 与实际字节不符时，读取必须以错误结束（不让客户端
// 「安静地」拿到比声明短得多的内容却不报错）。
func TestFetchMediaStream_DeclaredLengthMismatchErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", "1000") // 声明 1000
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("short")) // 只给 5 字节
	}))
	t.Cleanup(server.Close)

	svc := newProxy(t, "")
	stream, err := svc.FetchMediaStream(context.Background(), server.URL+"/v.mp4", "", "")
	require.NoError(t, err)
	defer stream.Body.Close()
	_, err = io.ReadAll(stream.Body)
	require.Error(t, err, "声明长度与实际不符必须以错误结束")
}

// N5：路径里带 /video/ 但扩展名是图片的，必须判成图片（发 image 那套请求头）。
func TestMediaKindFromURL_PrefersImageExtension(t *testing.T) {
	cases := map[string]string{
		"https://x.example/video/cover.jpg":   "image",
		"https://x.example/video/thumb.png":   "image",
		"https://x.example/photo.avif":        "image",
		"https://x.example/vid/avc1/a.mp4":    "video",
		"https://x.example/clip.webm":         "video",
		"https://x.example/media/stream.m3u8": "video",
	}
	for rawURL, want := range cases {
		require.Equal(t, want, service.MediaKindFromURLForTest(rawURL), rawURL)
	}
}

// roundTripFunc 把一个函数变成 http.RoundTripper（模拟标准客户端失败）。
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
