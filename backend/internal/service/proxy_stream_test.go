package service_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/service"
	"krss/backend/pkg/network"
)

/**
 * fix/video-proxy-stream：视频分片请求要「按需取一小段 + 命中缓存」。
 *
 * 改前实测（真实视频，63,176,469 字节）：
 *   经本代理 Range: bytes=0-1023 → 206，TTFB 7.80 / 6.13 / 5.49 s（三次几乎不变）
 *   直连上游同请求             → 206，TTFB 0.46 s
 * 根因：Range 头从没发给上游（上游永远回 200 + 整个文件），每个分片都把整段
 * 读进内存（maxProxyMediaBytes = 64MiB），而且带 Range 的请求既不查也不写缓存。
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

// 客户端要的 Range 必须真的发给上游，206 与 Content-Range 原样透传。
func TestFetchMedia_ForwardsRangeHeaderAndPassesThrough206(t *testing.T) {
	const total = 8 << 20
	up := newMediaUpstream(t, total)
	svc := newProxy(t, "")

	result, err := svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "bytes=100-199")
	require.NoError(t, err)

	require.Equal(t, "bytes=100-199", up.rangeHeader(), "Range 必须原样发给上游（改前这里永远是空串）")
	require.Equal(t, http.StatusPartialContent, result.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes 100-199/%d", total), result.ContentRange)
	require.Equal(t, up.body[100:200], result.Data)
	require.Equal(t, "video/mp4", result.ContentType)
	require.Equal(t, "bytes", result.AcceptRanges)
}

// 开放式 bytes=0- 要收成有界窗口再发给上游：否则上游回整个文件。
func TestFetchMedia_OpenEndedRangeClampedToWindow(t *testing.T) {
	const total = 8 << 20
	up := newMediaUpstream(t, total)
	svc := newProxy(t, "")

	result, err := svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-")
	require.NoError(t, err)

	chunk := service.MediaChunkBytesForTest
	wantRange := fmt.Sprintf("bytes=0-%d", chunk-1)
	require.Equal(t, wantRange, up.rangeHeader(), "开放式 Range 必须收成有界窗口")
	require.Equal(t, http.StatusPartialContent, result.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes 0-%d/%d", chunk-1, total), result.ContentRange)
	require.EqualValues(t, chunk, len(result.Data), "只该取一个窗口，不是整个文件")
	require.Less(t, len(result.Data), total, "不能把整段视频拉下来")
}

// 非零起点的开放式 Range 也要收成 [start, start+chunk-1]。
func TestFetchMedia_OpenEndedRangeWithOffset(t *testing.T) {
	const total = 8 << 20
	up := newMediaUpstream(t, total)
	svc := newProxy(t, "")

	start := int64(1000000)
	result, err := svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", fmt.Sprintf("bytes=%d-", start))
	require.NoError(t, err)

	chunk := service.MediaChunkBytesForTest
	require.Equal(t, fmt.Sprintf("bytes=%d-%d", start, start+chunk-1), up.rangeHeader())
	require.Equal(t, http.StatusPartialContent, result.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes %d-%d/%d", start, start+chunk-1, total), result.ContentRange)
	require.EqualValues(t, chunk, len(result.Data))
}

// 同一个 Range 第二次必须命中缓存：不出网，且 206 / Content-Range 仍在。
func TestFetchMedia_RangeRequestHitsCache(t *testing.T) {
	const total = 8 << 20
	up := newMediaUpstream(t, total)
	svc := newProxy(t, t.TempDir())

	first, err := svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-1023")
	require.NoError(t, err)
	require.Equal(t, int32(1), up.hitCount(), "第一次必须真的出网")
	require.Equal(t, http.StatusPartialContent, first.StatusCode)

	second, err := svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-1023")
	require.NoError(t, err)
	require.Equal(t, int32(1), up.hitCount(), "第二次必须命中缓存、不再出网（改前这里还是 2）")
	require.Equal(t, first.Data, second.Data)
	require.Equal(t, http.StatusPartialContent, second.StatusCode, "缓存命中的 206 不能退化成 200")
	require.Equal(t, fmt.Sprintf("bytes 0-1023/%d", total), second.ContentRange, "缓存必须存住 Content-Range，否则拖进度条会坏")
	require.Equal(t, "bytes", second.AcceptRanges)
	require.Equal(t, "video/mp4", second.ContentType)
}

// 不同片段各存一份：换一个 Range 要重新出网，换回来仍命中。
func TestFetchMedia_RangeCacheKeyedByChunk(t *testing.T) {
	up := newMediaUpstream(t, 8<<20)
	svc := newProxy(t, t.TempDir())

	_, err := svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-1023")
	require.NoError(t, err)
	_, err = svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "bytes=1024-2047")
	require.NoError(t, err)
	require.Equal(t, int32(2), up.hitCount(), "不同片段是不同的缓存条目")

	_, err = svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-1023")
	require.NoError(t, err)
	require.Equal(t, int32(2), up.hitCount(), "回到第一个片段应命中缓存")
}

// 片段缓存不能污染整段缓存键：随后一次无 Range 的请求仍然出网取完整内容。
func TestFetchMedia_RangeCacheDoesNotPolluteWholeFileKey(t *testing.T) {
	up := newMediaUpstream(t, 4<<20)
	svc := newProxy(t, t.TempDir())

	_, err := svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-1023")
	require.NoError(t, err)

	whole, err := svc.FetchMedia(context.Background(), up.server.URL+"/v.mp4", "", "")
	require.NoError(t, err)
	require.Equal(t, int32(2), up.hitCount(), "无 Range 的请求不能吃到片段缓存")
	require.Equal(t, http.StatusOK, whole.StatusCode)
	require.EqualValues(t, 4<<20, len(whole.Data))
}

// 上游无视 Range 回 200 时，保留本地切片兜底（浏览器照样拿到 206）。
func TestFetchMedia_UpstreamIgnoresRangeFallsBackToLocalSlice(t *testing.T) {
	body := make([]byte, 4096)
	for i := range body {
		body[i] = byte(i % 251)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 故意忽略 Range：永远回 200 整段
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)

	svc := newProxy(t, "")
	result, err := svc.FetchMedia(context.Background(), server.URL+"/v.mp4", "", "bytes=10-19")
	require.NoError(t, err)
	require.Equal(t, http.StatusPartialContent, result.StatusCode)
	require.Equal(t, "bytes 10-19/4096", result.ContentRange)
	require.Equal(t, body[10:20], result.Data)
}

/**
 * 第二轮：Range 请求改流式转发。
 *
 * 改前实测（集成树，真实视频 63MB）：首次 `Range: bytes=0-` 要等整个 4MiB
 * 窗口下载完才发首字节，TTFB 14.96s —— 缓存命中再好也救不了「第一次播放」，
 * 用户看到的就是十几秒黑屏。流式之后首包只受上游首字节影响。
 */

// slowChunkUpstream 分块慢写：每块写完后 Flush，然后等测试放行下一块。
// 这样「读到第一块时上游还没写完」是可断言的确定状态，不靠固定 sleep 猜。
type slowChunkUpstream struct {
	server *httptest.Server
	chunks [][]byte
	// gate[i] 收到信号后才写第 i+1 块（gate[0] 无意义，第一块立即写）
	gate []chan struct{}
	// wrote 已写完的块数（写完 + Flush 之后才 +1）
	wrote int32
}

func newSlowChunkUpstream(t *testing.T, chunks ...[]byte) *slowChunkUpstream {
	t.Helper()
	up := &slowChunkUpstream{chunks: chunks, gate: make([]chan struct{}, len(chunks))}
	for i := range up.gate {
		up.gate[i] = make(chan struct{})
	}
	up.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 声明成 206 + Content-Range，模拟认 Range 的视频 CDN；总长给个固定值。
		total := 0
		for _, c := range up.chunks {
			total += len(c)
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", total-1, total))
		w.WriteHeader(http.StatusPartialContent)
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

func (u *slowChunkUpstream) written() int { return int(atomic.LoadInt32(&u.wrote)) }

func (u *slowChunkUpstream) release(i int) { close(u.gate[i]) }

// 关键断言：FetchMediaStream 返回时只读到第一块，上游还在等放行写第二块 ——
// 也就是「没有等整窗下载完」。
func TestFetchMediaStream_ReturnsBeforeUpstreamFinishes(t *testing.T) {
	first := bytes.Repeat([]byte("a"), 1024)
	second := bytes.Repeat([]byte("b"), 1024)
	third := bytes.Repeat([]byte("c"), 1024)
	up := newSlowChunkUpstream(t, first, second, third)

	svc := newProxy(t, "")
	stream, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-")
	require.NoError(t, err)
	defer stream.Body.Close()

	require.Equal(t, http.StatusPartialContent, stream.StatusCode)
	require.Equal(t, "video/mp4", stream.ContentType)
	require.Equal(t, "bytes", stream.AcceptRanges)

	// 上游此刻只写完第一块（gate[1] 还没放行）
	require.Equal(t, 1, up.written(), "FetchMediaStream 返回时上游不该已经写完")

	got := make([]byte, len(first))
	_, err = io.ReadFull(stream.Body, got)
	require.NoError(t, err, "第一块必须立刻可读（改前这里要等整个窗口）")
	require.Equal(t, first, got)
	require.Equal(t, 1, up.written(), "读到第一块时上游仍在等第二块")

	up.release(1)
	up.release(2)
	rest, err := io.ReadAll(stream.Body)
	require.NoError(t, err)
	require.Equal(t, append(append([]byte{}, second...), third...), rest)
}

// 流式读完要把整段落进缓存；第二次同样的 Range 请求直接命中、不再出网。
func TestFetchMediaStream_CachesAfterFullRead(t *testing.T) {
	chunk := bytes.Repeat([]byte("x"), 2048)
	up := newSlowChunkUpstream(t, chunk)
	svc := newProxy(t, t.TempDir())

	stream, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-1023")
	require.NoError(t, err)
	_, err = io.ReadAll(stream.Body)
	require.NoError(t, err)
	require.NoError(t, stream.Body.Close())

	files, bytesCached := svc.MediaCacheStats()
	require.Equal(t, 1, files, "读完整段后必须留下一个缓存条目")
	// 落盘文件 = 元信息头 + 原始字节，所以只会比片段本身大
	require.GreaterOrEqual(t, bytesCached, int64(len(chunk)))

	second, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-1023")
	require.NoError(t, err)
	defer second.Body.Close()

	replay, err := io.ReadAll(second.Body)
	require.NoError(t, err)
	require.Equal(t, chunk, replay)
	require.Equal(t, http.StatusPartialContent, second.StatusCode, "缓存回放不能把 206 退化成 200")
	require.Equal(t, fmt.Sprintf("bytes 0-%d/%d", len(chunk)-1, len(chunk)), second.ContentRange)
	require.EqualValues(t, len(chunk), second.ContentLength)
	require.Equal(t, 1, up.written(), "第二次必须命中缓存、不再出网")
}

// 客户端只读一半就断开：缓存目录不能留下半截条目（.bin 与 .tmp 都不许有）。
func TestFetchMediaStream_ClientAbortLeavesNoPartialCache(t *testing.T) {
	first := bytes.Repeat([]byte("a"), 1024)
	second := bytes.Repeat([]byte("b"), 1024)
	up := newSlowChunkUpstream(t, first, second)

	cacheDir := t.TempDir()
	svc := newProxy(t, cacheDir)

	stream, err := svc.FetchMediaStream(context.Background(), up.server.URL+"/v.mp4", "", "bytes=0-")
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

// 上游无视 Range 回 200：流式这条路必须退回缓冲 + 本地切片，仍给 206。
func TestFetchMediaStream_UpstreamIgnoresRangeFallsBackToSlice(t *testing.T) {
	body := make([]byte, 4096)
	for i := range body {
		body[i] = byte(i % 251)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(body) // 故意忽略 Range
	}))
	t.Cleanup(server.Close)

	svc := newProxy(t, t.TempDir())
	stream, err := svc.FetchMediaStream(context.Background(), server.URL+"/v.mp4", "", "bytes=10-19")
	require.NoError(t, err)
	defer stream.Body.Close()

	data, err := io.ReadAll(stream.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusPartialContent, stream.StatusCode)
	require.Equal(t, "bytes 10-19/4096", stream.ContentRange)
	require.Equal(t, body[10:20], data)
	require.EqualValues(t, 10, stream.ContentLength)
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
