package service_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/service"
	"krss/backend/pkg/network"
)

// newGitHubStub 起一个假的 GitHub API；releases/latest 返回给定 JSON，并记录命中次数与收到的请求头。
func newGitHubStub(t *testing.T, status int, body string) (*httptest.Server, *int32, *http.Header) {
	t.Helper()
	var hits int32
	var lastHeader http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		lastHeader = r.Header.Clone()
		require.Contains(t, r.URL.Path, "/repos/")
		require.True(t, strings.HasSuffix(r.URL.Path, "/releases/latest"), "unexpected path: %s", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits, &lastHeader
}

func newUpdateService(t *testing.T, srv *httptest.Server, current string) service.UpdateService {
	t.Helper()
	return service.NewUpdateService(
		network.NewClientFactoryForTest(srv.Client()),
		service.WithUpdateAPIBase(srv.URL),
		service.WithUpdateCurrentVersion(current),
	)
}

const sampleReleaseJSON = `{
  "tag_name": "v9.9.9",
  "name": "v9.9.9",
  "html_url": "https://github.com/kue02/krss/releases/tag/v9.9.9",
  "published_at": "2026-12-01T10:00:00Z",
  "body_html": "<h2>9.9.9</h2><ul><li>新功能</li></ul>",
  "assets": [
    {"name": "krss-linux-amd64", "browser_download_url": "https://example.com/dl/krss-linux-amd64", "size": 12345678}
  ]
}`

func TestUpdateService_Check_UpdateAvailable(t *testing.T) {
	srv, hits, lastHeader := newGitHubStub(t, http.StatusOK, sampleReleaseJSON)
	svc := newUpdateService(t, srv, "1.4.0")

	info, err := svc.Check(context.Background())
	require.NoError(t, err)
	require.NotNil(t, info)

	require.Equal(t, "1.4.0", info.CurrentVersion)
	require.Equal(t, "v9.9.9", info.LatestVersion)
	require.True(t, info.HasUpdate)
	require.Equal(t, "v9.9.9", info.ReleaseName)
	require.Equal(t, "https://github.com/kue02/krss/releases/tag/v9.9.9", info.ReleaseURL)
	require.Equal(t, "2026-12-01T10:00:00Z", info.PublishedAt)
	require.Contains(t, info.ReleaseNotesHTML, "新功能")
	require.Len(t, info.Assets, 1)
	require.Equal(t, "krss-linux-amd64", info.Assets[0].Name)
	require.Equal(t, "https://example.com/dl/krss-linux-amd64", info.Assets[0].URL)
	require.Equal(t, int64(12345678), info.Assets[0].Size)

	// 必须用 html 媒体类型，才能拿到渲染好的 body_html
	require.Equal(t, "application/vnd.github.html+json", lastHeader.Get("Accept"))
	require.Equal(t, int32(1), atomic.LoadInt32(hits))
}

func TestUpdateService_Check_UpToDate(t *testing.T) {
	body := `{"tag_name":"v1.4.0","name":"v1.4.0","html_url":"x","published_at":"2026-11-25T12:06:17Z","body_html":"","assets":[]}`
	srv, _, _ := newGitHubStub(t, http.StatusOK, body)
	svc := newUpdateService(t, srv, "1.4.0")

	info, err := svc.Check(context.Background())
	require.NoError(t, err)
	require.False(t, info.HasUpdate)
	require.Equal(t, "v1.4.0", info.LatestVersion)
}

func TestUpdateService_Check_OlderLatestIsNotUpdate(t *testing.T) {
	body := `{"tag_name":"v1.3.0","name":"","html_url":"x","published_at":"2026-01-01T00:00:00Z","body_html":"","assets":[]}`
	srv, _, _ := newGitHubStub(t, http.StatusOK, body)
	svc := newUpdateService(t, srv, "1.4.0")

	info, err := svc.Check(context.Background())
	require.NoError(t, err)
	require.False(t, info.HasUpdate)
	// name 为空时回退到 tag
	require.Equal(t, "v1.3.0", info.ReleaseName)
}

func TestUpdateService_Check_FourSegmentVersions(t *testing.T) {
	cases := []struct {
		current string
		latest  string
		want    bool
	}{
		{"1.1.9.1", "1.1.9.2", true},
		{"1.1.9.1", "1.1.9.1", false},
		{"1.1.9.1", "1.1.9", false},
		{"1.10.0", "1.9.9", false},
	}
	for _, tc := range cases {
		body := fmt.Sprintf(`{"tag_name":"%s","name":"%s","html_url":"x","published_at":"2026-01-01T00:00:00Z","body_html":"","assets":[]}`, tc.latest, tc.latest)
		srv, _, _ := newGitHubStub(t, http.StatusOK, body)
		svc := newUpdateService(t, srv, tc.current)
		info, err := svc.Check(context.Background())
		require.NoError(t, err)
		require.Equal(t, tc.want, info.HasUpdate, "current=%s latest=%s", tc.current, tc.latest)
	}
}

func TestUpdateService_Check_CachesWithinTTL(t *testing.T) {
	srv, hits, _ := newGitHubStub(t, http.StatusOK, sampleReleaseJSON)
	svc := newUpdateService(t, srv, "1.4.0")

	_, err := svc.Check(context.Background())
	require.NoError(t, err)
	_, err = svc.Check(context.Background())
	require.NoError(t, err)
	_, err = svc.Check(context.Background())
	require.NoError(t, err)

	require.Equal(t, int32(1), atomic.LoadInt32(hits), "cached result should hit GitHub only once")
}

func TestUpdateService_Check_ErrorIsNotCached(t *testing.T) {
	srv, hits, _ := newGitHubStub(t, http.StatusInternalServerError, `{"message":"boom"}`)
	svc := newUpdateService(t, srv, "1.4.0")

	_, err := svc.Check(context.Background())
	require.Error(t, err)
	require.True(t, errors.Is(err, service.ErrUpdateCheckFailed))

	_, err = svc.Check(context.Background())
	require.Error(t, err)
	require.Equal(t, int32(2), atomic.LoadInt32(hits), "failed checks must not be cached")
}

func TestUpdateService_Check_EmptyTagFails(t *testing.T) {
	body := `{"tag_name":"","name":"","html_url":"x","published_at":"","body_html":"","assets":[]}`
	srv, _, _ := newGitHubStub(t, http.StatusOK, body)
	svc := newUpdateService(t, srv, "1.4.0")

	_, err := svc.Check(context.Background())
	require.Error(t, err)
	require.True(t, errors.Is(err, service.ErrUpdateCheckFailed))
}

func TestUpdateService_Check_ConcurrentColdStartHitsGitHubOnce(t *testing.T) {
	// 冷缓存下 10 个并发请求必须只出网一次（GitHub 匿名配额每小时 60 次，
	// 多端同时打开「关于」页不能把配额打穿）。
	var hits int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		<-release // 卡住第一次请求，让其余请求都堆在 singleflight 里
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(sampleReleaseJSON))
	}))
	t.Cleanup(srv.Close)

	svc := newUpdateService(t, srv, "1.4.0")

	const n = 10
	var wg sync.WaitGroup
	errs := make([]error, n)
	infos := make([]*service.UpdateInfo, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			infos[i], errs[i] = svc.Check(context.Background())
		}(i)
	}

	// 等所有 goroutine 都进到 Check 里，再放行桩响应。
	require.Eventually(t, func() bool { return atomic.LoadInt32(&hits) == 1 }, 2*time.Second, 5*time.Millisecond)
	time.Sleep(100 * time.Millisecond)
	close(release)
	wg.Wait()

	for i := 0; i < n; i++ {
		require.NoError(t, errs[i])
		require.NotNil(t, infos[i])
		require.Equal(t, "v9.9.9", infos[i].LatestVersion)
	}
	require.Equal(t, int32(1), atomic.LoadInt32(&hits), "concurrent cold-start must collapse into one GitHub call")
}

func TestUpdateService_Check_RateLimited(t *testing.T) {
	// 403 / 429 是「被限流」，要和「连不上」分开：前端提示不同，用户也不会一直重试。
	for _, status := range []int{http.StatusForbidden, http.StatusTooManyRequests} {
		srv, _, _ := newGitHubStub(t, status, `{"message":"API rate limit exceeded"}`)
		svc := newUpdateService(t, srv, "1.4.0")

		_, err := svc.Check(context.Background())
		require.Error(t, err)
		require.True(t, errors.Is(err, service.ErrUpdateRateLimited), "status %d", status)
		// 仍然是 update check 失败的一种，兜底分支也能认
		require.True(t, errors.Is(err, service.ErrUpdateCheckFailed))
	}
}

func TestUpdateService_Check_ReleaseNotFound(t *testing.T) {
	srv, _, _ := newGitHubStub(t, http.StatusNotFound, `{"message":"Not Found"}`)
	svc := newUpdateService(t, srv, "1.4.0")

	_, err := svc.Check(context.Background())
	require.Error(t, err)
	require.True(t, errors.Is(err, service.ErrUpdateReleaseNotFound))
	require.True(t, errors.Is(err, service.ErrUpdateCheckFailed))
}

func TestUpdateService_Check_OtherStatusIsGenericFailure(t *testing.T) {
	srv, _, _ := newGitHubStub(t, http.StatusInternalServerError, `{"message":"boom"}`)
	svc := newUpdateService(t, srv, "1.4.0")

	_, err := svc.Check(context.Background())
	require.Error(t, err)
	require.True(t, errors.Is(err, service.ErrUpdateCheckFailed))
	require.False(t, errors.Is(err, service.ErrUpdateRateLimited))
	require.False(t, errors.Is(err, service.ErrUpdateReleaseNotFound))
}

func TestUpdateService_Check_NonJSONBodyFails(t *testing.T) {
	srv, _, _ := newGitHubStub(t, http.StatusOK, `<html>not json</html>`)
	svc := newUpdateService(t, srv, "1.4.0")

	_, err := svc.Check(context.Background())
	require.Error(t, err)
	require.True(t, errors.Is(err, service.ErrUpdateCheckFailed))
}

func TestUpdateService_Check_OversizedResponseFails(t *testing.T) {
	// 超过 updateMaxResponseBytes（4MiB）要明确报「响应过大」，不能塌缩成 decode 错误。
	big := strings.Repeat("x", (4<<20)+1024)
	body := `{"tag_name":"v9.9.9","body_html":"` + big + `"}`
	srv, _, _ := newGitHubStub(t, http.StatusOK, body)
	svc := newUpdateService(t, srv, "1.4.0")

	_, err := svc.Check(context.Background())
	require.Error(t, err)
	require.True(t, errors.Is(err, service.ErrUpdateCheckFailed))
	require.Contains(t, err.Error(), "too large")
}

func TestUpdateService_Check_ContextCanceled(t *testing.T) {
	srv, _, _ := newGitHubStub(t, http.StatusOK, sampleReleaseJSON)
	svc := newUpdateService(t, srv, "1.4.0")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := svc.Check(ctx)
	require.Error(t, err)
	require.True(t, errors.Is(err, service.ErrUpdateCheckFailed))
}

func TestUpdateService_Check_CachedResultIsIndependent(t *testing.T) {
	// 缓存返回的 Assets 不能和内部缓存共享底层数组，否则调用方一改就污染后续请求。
	srv, _, _ := newGitHubStub(t, http.StatusOK, sampleReleaseJSON)
	svc := newUpdateService(t, srv, "1.4.0")

	first, err := svc.Check(context.Background())
	require.NoError(t, err)
	require.Len(t, first.Assets, 1)
	first.Assets[0].Name = "mutated"

	second, err := svc.Check(context.Background())
	require.NoError(t, err)
	require.Equal(t, "krss-linux-amd64", second.Assets[0].Name)
}

func TestUpdateService_Check_EmptyAssetsStaysEmptySlice(t *testing.T) {
	// Release 没有附件时（当前 release.yml 就是只发 Release 不传二进制），
	// Assets 必须序列化成 []，不能是 null——前端拿到 null 读 .length 会直接崩。
	srv, _, _ := newGitHubStub(t, http.StatusOK, `{
  "tag_name": "v9.9.9",
  "name": "v9.9.9",
  "html_url": "https://github.com/kue02/krss/releases/tag/v9.9.9",
  "body_html": "<h2>9.9.9</h2>",
  "assets": []
}`)
	svc := newUpdateService(t, srv, "1.4.0")

	info, err := svc.Check(context.Background())
	require.NoError(t, err)
	require.NotNil(t, info.Assets)
	require.Empty(t, info.Assets)

	// 走缓存克隆的那条路径同样不能变成 nil
	cached, err := svc.Check(context.Background())
	require.NoError(t, err)
	require.NotNil(t, cached.Assets)

	raw, err := json.Marshal(cached)
	require.NoError(t, err)
	require.Contains(t, string(raw), `"assets":[]`)
	require.NotContains(t, string(raw), `"assets":null`)
}
