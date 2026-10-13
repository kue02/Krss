package service_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/service"
	"krss/backend/pkg/network"
)

/**
 * 50-2：代理媒体加磁盘缓存。
 *
 * 改前实测（真实图源）：同一张图连取三遍 0.708 / 0.967 / 0.669 s —— 一遍都不快，
 * 因为服务端一点不留，每次都重新出网。一篇 35 图的文章等于把 35 次出网延迟叠给用户。
 */

// onePixelPNG 一张最小的合法 PNG（1×1 透明）
var onePixelPNG = []byte{
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
	0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
	0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
	0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
	0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
	0x42, 0x60, 0x82,
}

// imageUpstream 记数的假图源
func imageUpstream(t *testing.T) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(onePixelPNG)
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

func newCachingProxy(t *testing.T, cacheDir string) service.ProxyService {
	t.Helper()
	svc := service.NewProxyService(network.NewClientFactoryForTest(&http.Client{}), nil)
	if cacheDir != "" {
		svc = svc.WithMediaCache(cacheDir, 0) // 0 ⇒ 用默认上限
	}
	return svc
}

func TestFetchMedia_CachesAndSkipsUpstreamOnSecondCall(t *testing.T) {
	upstream, hits := imageUpstream(t)
	svc := newCachingProxy(t, t.TempDir())

	first, err := svc.FetchMedia(context.Background(), upstream.URL+"/a.png", "", "")
	require.NoError(t, err)
	require.Equal(t, "image/png", first.ContentType)
	require.Equal(t, int32(1), atomic.LoadInt32(hits), "第一次必须真的出网")

	second, err := svc.FetchMedia(context.Background(), upstream.URL+"/a.png", "", "")
	require.NoError(t, err)
	require.Equal(t, int32(1), atomic.LoadInt32(hits), "第二次必须命中缓存、不再出网（改前这里还是 2）")
	require.Equal(t, first.Data, second.Data, "缓存里的字节要和第一次一致")
	require.Equal(t, "image/png", second.ContentType, "content-type 也要跟着缓存")
	require.Equal(t, http.StatusOK, second.StatusCode)
}

func TestFetchMedia_NoCacheWhenDisabled(t *testing.T) {
	upstream, hits := imageUpstream(t)
	svc := newCachingProxy(t, "") // 不挂缓存

	_, err := svc.FetchMedia(context.Background(), upstream.URL+"/b.png", "", "")
	require.NoError(t, err)
	_, err = svc.FetchMedia(context.Background(), upstream.URL+"/b.png", "", "")
	require.NoError(t, err)
	require.Equal(t, int32(2), atomic.LoadInt32(hits), "没挂缓存时就该老老实实每次都出网")
}

func TestFetchMedia_RangeBypassesCache(t *testing.T) {
	upstream, hits := imageUpstream(t)
	svc := newCachingProxy(t, t.TempDir())

	// <video> 拖进度条会带 Range：这种片段不该走缓存，也不该被当成整段缓存下来
	_, err := svc.FetchMedia(context.Background(), upstream.URL+"/v.mp4", "", "bytes=0-3")
	require.NoError(t, err)
	_, err = svc.FetchMedia(context.Background(), upstream.URL+"/v.mp4", "", "bytes=0-3")
	require.NoError(t, err)
	require.Equal(t, int32(2), atomic.LoadInt32(hits), "带 Range 的请求必须每次都出网")

	// 而且别把片段当整段塞进缓存：随后一次不带 Range 的请求应当仍然出网
	_, err = svc.FetchMedia(context.Background(), upstream.URL+"/v.mp4", "", "")
	require.NoError(t, err)
	require.Equal(t, int32(3), atomic.LoadInt32(hits), "Range 请求不该污染缓存")
}

func TestMediaCache_PrunesWhenOverCap(t *testing.T) {
	upstream, _ := imageUpstream(t)
	// 上限给得非常小：每张 1×1 PNG 约 70 B，写十几张必然超
	svc := service.NewProxyService(network.NewClientFactoryForTest(&http.Client{}), nil).
		WithMediaCache(t.TempDir(), 400)

	for i := 0; i < 30; i++ {
		_, err := svc.FetchMedia(context.Background(), fmt.Sprintf("%s/p%d.png", upstream.URL, i), "", "")
		require.NoError(t, err)
	}

	files, bytes := svc.MediaCacheStats()
	require.LessOrEqual(t, bytes, int64(400), "裁剪后总量必须回到上限之内（实际 %d）", bytes)
	require.Positive(t, files, "不该把缓存删光")
}
