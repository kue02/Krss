package service_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

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
