package service_test

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
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
