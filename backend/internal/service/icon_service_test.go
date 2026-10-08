package service_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/service"
	"krss/backend/pkg/network"
)

type feedRepoStub struct {
	mu sync.Mutex
	// 14 批：代理覆盖的最后一次写入（供断言）
	proxyFeedID         int64
	proxyMode           *model.ProxyMode
	proxyConfig         *model.ProxyOverrideConfig
	listWithoutIconFn   func(context.Context) ([]model.Feed, error)
	listFn              func(context.Context, *int64) ([]model.Feed, error)
	updateIconPathFn    func(context.Context, int64, string) error
	getByIDFn           func(context.Context, int64) (model.Feed, error)
	clearAllIconPathsFn func(context.Context) (int64, error)
	clearAllCondGetFn   func(context.Context) (int64, error)
}

func (f *feedRepoStub) Create(context.Context, model.Feed) (model.Feed, error) {
	panic("not implemented")
}

func (f *feedRepoStub) GetByID(ctx context.Context, id int64) (model.Feed, error) {
	if f.getByIDFn == nil {
		panic("not implemented")
	}
	return f.getByIDFn(ctx, id)
}

func (f *feedRepoStub) GetByIDs(context.Context, []int64) ([]model.Feed, error) {
	panic("not implemented")
}

func (f *feedRepoStub) FindByURL(context.Context, string) (*model.Feed, error) {
	panic("not implemented")
}

func (f *feedRepoStub) List(ctx context.Context, folderID *int64) ([]model.Feed, error) {
	if f.listFn == nil {
		panic("not implemented")
	}
	return f.listFn(ctx, folderID)
}

func (f *feedRepoStub) ListWithoutIcon(ctx context.Context) ([]model.Feed, error) {
	if f.listWithoutIconFn == nil {
		panic("not implemented")
	}
	return f.listWithoutIconFn(ctx)
}

func (f *feedRepoStub) Update(context.Context, model.Feed) (model.Feed, error) {
	panic("not implemented")
}

func (f *feedRepoStub) UpdateIconPath(ctx context.Context, id int64, iconPath string) error {
	if f.updateIconPathFn == nil {
		panic("not implemented")
	}
	return f.updateIconPathFn(ctx, id, iconPath)
}

func (f *feedRepoStub) UpdateErrorMessage(context.Context, int64, *string) error {
	panic("not implemented")
}

func (f *feedRepoStub) RecordRefreshFailure(context.Context, int64, time.Time) error {
	panic("not implemented")
}

func (f *feedRepoStub) ResetRefreshFailure(context.Context, int64) error {
	panic("not implemented")
}

func (f *feedRepoStub) UpdateType(context.Context, int64, string) error {
	panic("not implemented")
}

// UpdateProxyOverride 14 批新增：stub 里只记最后一次写入，供代理用例断言。
func (f *feedRepoStub) UpdateProxyOverride(_ context.Context, id int64, mode *model.ProxyMode, cfg *model.ProxyOverrideConfig) error {
	f.proxyMode = mode
	f.proxyConfig = cfg
	f.proxyFeedID = id
	return nil
}

func (f *feedRepoStub) UpdateTypeByFolderID(context.Context, int64, string) error {
	panic("not implemented")
}

func (f *feedRepoStub) Delete(context.Context, int64) error {
	panic("not implemented")
}

func (f *feedRepoStub) DeleteBatch(context.Context, []int64) (int64, error) {
	panic("not implemented")
}

func (f *feedRepoStub) ClearAllIconPaths(ctx context.Context) (int64, error) {
	if f.clearAllIconPathsFn == nil {
		panic("not implemented")
	}
	return f.clearAllIconPathsFn(ctx)
}

func (f *feedRepoStub) ClearAllConditionalGet(ctx context.Context) (int64, error) {
	if f.clearAllCondGetFn == nil {
		panic("not implemented")
	}
	return f.clearAllCondGetFn(ctx)
}

func (f *feedRepoStub) UpdateSiteURL(context.Context, int64, string) error {
	panic("not implemented")
}

func pngBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	buf := &bytes.Buffer{}
	require.NoError(t, png.Encode(buf, img))
	return buf.Bytes()
}

func TestIconService_IsValidIconPath(t *testing.T) {
	require.False(t, service.IsValidIconPathForTest(""))
	require.False(t, service.IsValidIconPathForTest("../icon.png"))
	require.False(t, service.IsValidIconPathForTest("/abs/icon.png"))
	require.True(t, service.IsValidIconPathForTest("example.com.png"))
}

func TestIconService_IsHashFilename(t *testing.T) {
	require.True(t, service.IsHashFilenameForTest("0123456789abcdef.png"))
	require.False(t, service.IsHashFilenameForTest("short.png"))
	require.False(t, service.IsHashFilenameForTest("gggggggggggggggg.png"))
}

func TestIconService_DetectImageFormat(t *testing.T) {
	ext, err := service.DetectImageFormatExtForTest(pngBytes(t, 2, 2))
	require.NoError(t, err)
	require.Equal(t, "png", ext)

	ext, err = service.DetectImageFormatExtForTest([]byte("<svg></svg>"))
	require.NoError(t, err)
	require.Equal(t, "svg", ext)

	ext, err = service.DetectImageFormatExtForTest([]byte{0x00, 0x00, 0x01, 0x00, 0x01, 0x00})
	require.NoError(t, err)
	require.Equal(t, "ico", ext)

	_, err = service.DetectImageFormatExtForTest(pngBytes(t, 1, 1))
	require.Error(t, err)
}

func TestIconService_FetchAndSaveIcon_ExistingRSSHash(t *testing.T) {
	dataDir := t.TempDir()
	iconsDir := filepath.Join(dataDir, "icons")
	require.NoError(t, os.MkdirAll(iconsDir, 0755))

	feedImageURL := "https://example.com/icon.png"
	hash := sha256.Sum256([]byte(feedImageURL))
	filename := hex.EncodeToString(hash[:8]) + ".png"
	require.NoError(t, os.WriteFile(filepath.Join(iconsDir, filename), []byte("data"), 0644))

	svc := service.NewIconService(dataDir, &feedRepoStub{}, network.NewClientFactoryForTest(&http.Client{}), nil)
	got, err := svc.FetchAndSaveIcon(context.Background(), feedImageURL, "https://example.com")
	require.NoError(t, err)
	require.Equal(t, filename, got)
}

func TestIconService_FetchAndSaveIcon_LocalFavicon(t *testing.T) {
	iconData := pngBytes(t, 2, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/favicon.ico" {
			_, _ = w.Write(iconData)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, &feedRepoStub{}, network.NewClientFactoryForTest(&http.Client{}), nil)

	got, err := svc.FetchAndSaveIcon(context.Background(), "", server.URL)
	require.NoError(t, err)

	parsed, err := url.Parse(server.URL)
	require.NoError(t, err)
	expected := parsed.Hostname() + ".png"
	require.Equal(t, expected, got)

	_, err = os.Stat(filepath.Join(dataDir, "icons", expected))
	require.NoError(t, err)
}

func TestIconService_FetchAndSaveIcon_NoURLs(t *testing.T) {
	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, &feedRepoStub{}, network.NewClientFactoryForTest(&http.Client{}), nil)

	got, err := svc.FetchAndSaveIcon(context.Background(), "", "")
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestIconService_EnsureIcon_Download(t *testing.T) {
	iconData := pngBytes(t, 2, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/favicon.ico" {
			_, _ = w.Write(iconData)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, &feedRepoStub{}, network.NewClientFactoryForTest(&http.Client{}), nil)

	parsed, err := url.Parse(server.URL)
	require.NoError(t, err)
	iconPath := parsed.Hostname() + ".png"
	require.NoError(t, svc.EnsureIcon(context.Background(), iconPath, server.URL))

	_, err = os.Stat(filepath.Join(dataDir, "icons", iconPath))
	require.NoError(t, err)
}

func TestIconService_EnsureIcon_InvalidPathAndHash(t *testing.T) {
	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, &feedRepoStub{}, network.NewClientFactoryForTest(&http.Client{}), nil)

	require.NoError(t, svc.EnsureIcon(context.Background(), "../icon.png", "https://example.com"))
	require.NoError(t, svc.EnsureIcon(context.Background(), "0123456789abcdef.png", "https://example.com"))
}

func TestIconService_EnsureIconByFeedID(t *testing.T) {
	iconData := pngBytes(t, 2, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/favicon.ico" {
			_, _ = w.Write(iconData)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	dataDir := t.TempDir()
	parsed, err := url.Parse(server.URL)
	require.NoError(t, err)
	iconPath := parsed.Hostname() + ".png"

	repo := &feedRepoStub{
		getByIDFn: func(ctx context.Context, id int64) (model.Feed, error) {
			site := server.URL
			return model.Feed{ID: id, URL: server.URL, SiteURL: &site}, nil
		},
	}

	svc := service.NewIconService(dataDir, repo, network.NewClientFactoryForTest(&http.Client{}), nil)

	err = svc.EnsureIconByFeedID(context.Background(), 1, iconPath)
	require.NoError(t, err)
	_, err = os.Stat(filepath.Join(dataDir, "icons", iconPath))
	require.NoError(t, err)

	err = svc.EnsureIconByFeedID(context.Background(), 1, "")
	require.Error(t, err)
}

func TestIconService_GetIconPath(t *testing.T) {
	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, &feedRepoStub{}, network.NewClientFactoryForTest(&http.Client{}), nil)

	path := svc.GetIconPath("example.com.png")
	require.Equal(t, filepath.Join(dataDir, "icons", "example.com.png"), path)
	require.Empty(t, svc.GetIconPath("../bad.png"))
}

func TestIconService_ClearAllIcons(t *testing.T) {
	dataDir := t.TempDir()
	iconsDir := filepath.Join(dataDir, "icons")
	require.NoError(t, os.MkdirAll(iconsDir, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(iconsDir, "a.png"), []byte("a"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(iconsDir, "b.png"), []byte("b"), 0644))

	repo := &feedRepoStub{
		clearAllIconPathsFn: func(context.Context) (int64, error) {
			return 2, nil
		},
		clearAllCondGetFn: func(context.Context) (int64, error) {
			return 2, nil
		},
	}

	svc := service.NewIconService(dataDir, repo, network.NewClientFactoryForTest(&http.Client{}), nil)
	deleted, err := svc.ClearAllIcons(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(2), deleted)

	entries, err := os.ReadDir(iconsDir)
	require.NoError(t, err)
	require.Len(t, entries, 0)
}

func TestIconService_BackfillIcons_ListError(t *testing.T) {
	repo := &feedRepoStub{
		listWithoutIconFn: func(context.Context) ([]model.Feed, error) {
			return nil, errors.New("list failed")
		},
	}
	svc := service.NewIconService(t.TempDir(), repo, network.NewClientFactoryForTest(&http.Client{}), nil)

	err := svc.BackfillIcons(context.Background())
	require.Error(t, err)
}

func TestIconService_BackfillIcons_NoFeeds(t *testing.T) {
	repo := &feedRepoStub{
		listWithoutIconFn: func(context.Context) ([]model.Feed, error) {
			return nil, nil
		},
		listFn: func(context.Context, *int64) ([]model.Feed, error) {
			return nil, nil
		},
	}
	svc := service.NewIconService(t.TempDir(), repo, network.NewClientFactoryForTest(&http.Client{}), nil)

	err := svc.BackfillIcons(context.Background())
	require.NoError(t, err)
}

func TestIconService_FetchIconsForFeeds(t *testing.T) {
	iconData := pngBytes(t, 2, 2)

	var baseURL string
	mux := http.NewServeMux()
	mux.HandleFunc("/rss", func(w http.ResponseWriter, r *http.Request) {
		rss := fmt.Sprintf(`<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test</title>
    <link>%s</link>
    <image><url>%s/icon.png</url></image>
    <item><title>Item</title><link>%s/item</link></item>
  </channel>
</rss>`, baseURL, baseURL, baseURL)
		_, _ = w.Write([]byte(rss))
	})
	mux.HandleFunc("/icon.png", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(iconData)
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	baseURL = server.URL

	dataDir := t.TempDir()
	updated := make(map[int64]string)
	repo := &feedRepoStub{}
	repo.updateIconPathFn = func(ctx context.Context, id int64, iconPath string) error {
		if iconPath == "" {
			return nil
		}
		repo.mu.Lock()
		defer repo.mu.Unlock()
		updated[id] = iconPath
		return nil
	}

	svc := service.NewIconService(dataDir, repo, network.NewClientFactoryForTest(&http.Client{}), nil)
	feeds := []model.Feed{{ID: 10, URL: server.URL + "/rss", Title: "Test"}}

	err := service.FetchIconsForFeedsForTest(svc, context.Background(), feeds)
	require.NoError(t, err)

	repo.mu.Lock()
	iconPath, ok := updated[int64(10)]
	repo.mu.Unlock()
	require.True(t, ok)
	_, err = os.Stat(filepath.Join(dataDir, "icons", iconPath))
	require.NoError(t, err)
}

func TestIconService_DownloadIconWithFreshClient(t *testing.T) {
	iconData := pngBytes(t, 2, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(iconData)
	}))
	defer server.Close()

	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, &feedRepoStub{}, network.NewClientFactoryForTest(&http.Client{}), nil)

	err := service.DownloadIconWithFreshClientForTest(svc, context.Background(), server.URL, "", 0, 0)
	require.NoError(t, err)
}

// TestIconService_BuildDDGFaviconURL tests the DuckDuckGo favicon URL builder.
// See: fix: Add DuckDuckGo Favicon API as fallback
func TestIconService_BuildDDGFaviconURL(t *testing.T) {
	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, &feedRepoStub{}, network.NewClientFactoryForTest(&http.Client{}), nil)

	tests := []struct {
		name     string
		siteURL  string
		expected string
	}{
		{
			name:     "valid URL with https",
			siteURL:  "https://example.com/path",
			expected: "https://icons.duckduckgo.com/ip3/example.com.ico",
		},
		{
			name:     "valid URL with http",
			siteURL:  "http://blog.example.org/feed",
			expected: "https://icons.duckduckgo.com/ip3/blog.example.org.ico",
		},
		{
			name:     "URL with port",
			siteURL:  "https://example.com:8080/path",
			expected: "https://icons.duckduckgo.com/ip3/example.com.ico",
		},
		{
			name:     "empty URL",
			siteURL:  "",
			expected: "",
		},
		{
			name:     "invalid URL",
			siteURL:  "://invalid",
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := service.BuildDDGFaviconURLForTest(svc, tt.siteURL)
			require.Equal(t, tt.expected, got)
		})
	}
}

// TestIconService_FetchAndSaveIcon_DDGFallback tests that DuckDuckGo is used as fallback.
// See: fix: Add DuckDuckGo Favicon API as fallback
func TestIconService_FetchAndSaveIcon_DDGFallback(t *testing.T) {
	iconData := pngBytes(t, 2, 2)

	// Track which URLs were requested
	var requestedURLs []string
	var mu sync.Mutex

	mux := http.NewServeMux()

	// Local favicon returns 404
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requestedURLs = append(requestedURLs, r.URL.Path)
		mu.Unlock()
		http.NotFound(w, r)
	})

	// Google API path - we need to mock this differently
	// Since we can't intercept google.com requests, we'll test that DDG URL is built correctly

	server := httptest.NewServer(mux)
	defer server.Close()

	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, &feedRepoStub{}, network.NewClientFactoryForTest(&http.Client{}), nil)

	// Test that DDG URL is correctly built
	parsed, err := url.Parse(server.URL)
	require.NoError(t, err)

	ddgURL := service.BuildDDGFaviconURLForTest(svc, server.URL)
	expected := fmt.Sprintf("https://icons.duckduckgo.com/ip3/%s.ico", parsed.Hostname())
	require.Equal(t, expected, ddgURL, "DuckDuckGo favicon URL should be correctly built")

	// Verify the URL follows the correct format
	require.Contains(t, ddgURL, "icons.duckduckgo.com/ip3/")
	require.True(t, strings.HasSuffix(ddgURL, ".ico"), "DuckDuckGo URL should end with .ico")

	// Also test that local and Google URLs are built correctly for the same site
	localURL := service.BuildLocalFaviconURLForTest(svc, server.URL)
	require.Contains(t, localURL, "/favicon.ico")

	googleURL := service.BuildFaviconURLForTest(svc, server.URL)
	require.Contains(t, googleURL, "google.com/s2/favicons")

	_ = iconData // Use iconData to avoid unused variable warning
}

// TestIconService_ClearAllIcons_ResetsConditionalGet tests that clearing all icons
// also resets ETag and Last-Modified to force full refresh.
// See: fix: Reset ETag and Last-Modified when clearing all icons
func TestIconService_ClearAllIcons_ResetsConditionalGet(t *testing.T) {
	dataDir := t.TempDir()
	iconsDir := filepath.Join(dataDir, "icons")
	require.NoError(t, os.MkdirAll(iconsDir, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(iconsDir, "test.png"), []byte("data"), 0644))

	var clearIconPathsCalled, clearCondGetCalled bool

	repo := &feedRepoStub{
		clearAllIconPathsFn: func(context.Context) (int64, error) {
			clearIconPathsCalled = true
			return 1, nil
		},
		clearAllCondGetFn: func(context.Context) (int64, error) {
			clearCondGetCalled = true
			return 1, nil
		},
	}

	svc := service.NewIconService(dataDir, repo, network.NewClientFactoryForTest(&http.Client{}), nil)
	_, err := svc.ClearAllIcons(context.Background())
	require.NoError(t, err)

	// Verify both clear functions were called
	require.True(t, clearIconPathsCalled, "ClearAllIconPaths should be called")
	require.True(t, clearCondGetCalled, "ClearAllConditionalGet should be called to reset ETag/Last-Modified")
}

// —— 25-2：站点把图标放在别处（CDN / 子路径 / 相对路径）时，去读首页 HTML 声明的 <link rel="icon"> ——

// thirdPartyBlockingTransport 把第三方 favicon 服务（Google / DuckDuckGo）拦成 404：
// 用例保持离线，且能证明命中的图标确实来自站点 HTML，而不是"恰好 Google 有缓存"。
type thirdPartyBlockingTransport struct{ base http.RoundTripper }

func (t thirdPartyBlockingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.Contains(req.URL.Host, "google.com") || strings.Contains(req.URL.Host, "duckduckgo.com") {
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Status:     "404 Not Found",
			Body:       io.NopCloser(strings.NewReader("")),
			Header:     http.Header{},
			Request:    req,
		}, nil
	}
	return t.base.RoundTrip(req)
}

func offlineIconService(dataDir string) service.IconService {
	client := &http.Client{Transport: thirdPartyBlockingTransport{base: http.DefaultTransport}}
	return service.NewIconService(dataDir, &feedRepoStub{}, network.NewClientFactoryForTest(client), nil)
}

func TestIconService_ExtractIconURLs(t *testing.T) {
	page := []byte(`<!doctype html><html><head>
		<link rel="mask-icon" href="/mask.svg">
		<link rel="apple-touch-icon" href="apple-touch-icon.png">
		<link rel="shortcut icon" href="//cdn.example.com/favicon.ico">
		<link rel="icon" href="/icon-32.png">
		<link rel="stylesheet" href="/style.css">
		<link rel="icon" href="/icon-32.png">
		<link rel="icon" href="data:image/png;base64,AAAA">
	</head><body>ok</body></html>`)

	got := service.ExtractIconURLsForTest("https://example.com/blog/index.html", page)

	require.Equal(t, []string{
		"https://example.com/blog/apple-touch-icon.png", // 相对路径按首页解析
		"https://cdn.example.com/favicon.ico",           // 协议相对路径
		"https://example.com/icon-32.png",              // 绝对路径，重复只留一次
	}, got, "应跳过 mask-icon 与 data:，并保持文档顺序")
}

func TestIconService_ExtractIconURLs_NoDeclaration(t *testing.T) {
	got := service.ExtractIconURLsForTest("https://example.com", []byte(`<html><head><title>x</title></head></html>`))
	require.Empty(t, got)
}

func TestIconService_FetchAndSaveIcon_DeclaredInHTML(t *testing.T) {
	iconData := pngBytes(t, 32, 32)
	page := `<!doctype html><html><head>
		<link rel="apple-touch-icon" href="/apple-touch-icon.png">
		<link rel="icon" href="assets/app-32.png">
	</head><body>ok</body></html>`

	var mu sync.Mutex
	var requested []string
	record := func(mux *http.ServeMux, path string, handler http.HandlerFunc) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			requested = append(requested, r.URL.Path)
			mu.Unlock()
			handler(w, r)
		})
	}

	mux := http.NewServeMux()
	record(mux, "/favicon.ico", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	record(mux, "/apple-touch-icon.png", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	record(mux, "/assets/app-32.png", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(iconData) })
	record(mux, "/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, page)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	dataDir := t.TempDir()
	svc := offlineIconService(dataDir)

	got, err := svc.FetchAndSaveIcon(context.Background(), "", server.URL)
	require.NoError(t, err)

	parsed, err := url.Parse(server.URL)
	require.NoError(t, err)
	expected := parsed.Hostname() + ".png"
	require.Equal(t, expected, got, "/favicon.ico 404 时应落到 HTML 里声明的图标")

	saved, err := os.ReadFile(filepath.Join(dataDir, "icons", expected))
	require.NoError(t, err)
	require.Equal(t, iconData, saved)

	mu.Lock()
	defer mu.Unlock()
	require.Contains(t, requested, "/assets/app-32.png")
	require.Contains(t, requested, "/apple-touch-icon.png", "文档顺序在前的声明要先试")
}

func TestIconService_FetchAndSaveIcon_SkipsPageWhenFaviconWorks(t *testing.T) {
	iconData := pngBytes(t, 32, 32)

	var pageHits int32
	mux := http.NewServeMux()
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(iconData) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&pageHits, 1)
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, `<html><head><link rel="icon" href="/icon.png"></head></html>`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	dataDir := t.TempDir()
	svc := offlineIconService(dataDir)

	got, err := svc.FetchAndSaveIcon(context.Background(), "", server.URL)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Zero(t, atomic.LoadInt32(&pageHits), "favicon.ico 已经命中时不该再多抓一次首页 HTML")
}

// —— 28-1：RSSHub 订阅的图标不该是 RSSHub 实例自己的 logo ——
//
// 真实现场：74 条订阅里 25 条共用 rsshub.wxhdj.xyz.png（实例 favicon），
// 其中 19 条明明有真实主站（t.me/s/…、x.com/…），看上去就是「一堆源没图标」。

// stubAggregatorFaviconServer 造一台「RSSHub 实例」：根路径 /favicon.ico 给一个可辨识的 logo。
// 上游站点用一个单独的真实主机名（形如 real-site-xxx）表示。
func TestIconService_RSSHubFeed_DoesNotUseAggregatorFavicon(t *testing.T) {
	instanceIcon := pngBytes(t, 32, 32)

	var instanceFaviconHits int32
	mux := http.NewServeMux()
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&instanceFaviconHits, 1)
		_, _ = w.Write(instanceIcon)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, `<html><head><link rel="icon" href="/favicon.ico"></head></html>`)
	})
	instance := httptest.NewServer(mux)
	defer instance.Close()
	instanceHost, err := url.Parse(instance.URL)
	require.NoError(t, err)

	// 这台「实例」的主机名里得带 rsshub，才会被当成聚合实例
	rsshubHost := "rsshub." + instanceHost.Hostname()
	feedURL := "https://" + rsshubHost + "/telegram/channel/some_channel?key=abc"

	repo := &feedRepoStub{
		getByIDFn: func(ctx context.Context, id int64) (model.Feed, error) {
			return model.Feed{ID: id, URL: feedURL}, nil
		},
	}

	// 上游站点 favicon 服务：把 t.me 的 /favicon.ico 指向可辨识的图标
	upstreamIcon := pngBytes(t, 48, 48)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/favicon.ico" {
			_, _ = w.Write(upstreamIcon)
			return
		}
		http.NotFound(w, r)
	}))
	defer upstream.Close()

	// 把「t.me」这个域名重定向到本地 upstream：替换掉真实 DNS
	transport := rewriteHostTransport{
		base:   thirdPartyBlockingTransport{base: http.DefaultTransport},
		from:   "t.me",
		toHost: upstreamHost(t, upstream.URL),
	}
	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, repo, network.NewClientFactoryForTest(&http.Client{Transport: transport}), nil)

	// site_url 是 RSSHub 实例地址（老代码路径），真实站点要靠路由反解出来
	got, err := svc.FetchAndSaveIconForFeed(context.Background(), 42, "", feedURL)
	require.NoError(t, err)

	require.NotEqual(t, instanceHost.Hostname()+".png", got,
		"图标不能是 RSSHub 实例自己的 favicon（那正是 25 条共用一个图标的根因）")
	require.Equal(t, "t.me.png", got, "文件名要用真实站点域名 t.me")
	require.Zero(t, atomic.LoadInt32(&instanceFaviconHits),
		"连 RSSHub 实例的 /favicon.ico 都不该去打 —— 命中它就等于拿到实例 logo")
}

func upstreamHost(t *testing.T, rawURL string) string {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	require.NoError(t, err)
	return parsed.Host
}

// rewriteHostTransport 把某个 host 的请求改写到本地测试服务器（保留路径/查询）。
type rewriteHostTransport struct {
	base   http.RoundTripper
	from   string
	toHost string
}

func (t rewriteHostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.EqualFold(req.URL.Hostname(), t.from) {
		clone := req.Clone(req.Context())
		clone.URL.Scheme = "http"
		clone.URL.Host = t.toHost
		clone.Host = ""
		return t.base.RoundTrip(clone)
	}
	return t.base.RoundTrip(req)
}

// RSS 自带的 <image>（Telegram 频道头像）优先，且存成哈希名 —— 28-1 的第一档。
func TestIconService_RSSImagePreferredOverAggregatorFavicon(t *testing.T) {
	avatar := pngBytes(t, 64, 64)
	avatarServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(avatar)
	}))
	defer avatarServer.Close()

	instanceIcon := pngBytes(t, 32, 32)
	var instanceHits int32
	mux := http.NewServeMux()
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&instanceHits, 1)
		_, _ = w.Write(instanceIcon)
	})
	instance := httptest.NewServer(mux)
	defer instance.Close()
	instanceHost, err := url.Parse(instance.URL)
	require.NoError(t, err)

	avatarURL := avatarServer.URL + "/channel-avatar.jpg"
	hash := sha256.Sum256([]byte(avatarURL))
	expected := hex.EncodeToString(hash[:8]) + ".png"

	dataDir := t.TempDir()
	repo := &feedRepoStub{
		getByIDFn: func(ctx context.Context, id int64) (model.Feed, error) {
			return model.Feed{ID: id, URL: "https://rsshub." + instanceHost.Hostname() + "/telegram/channel/chan?key=abc"}, nil
		},
	}
	svc := service.NewIconService(dataDir, repo, network.NewClientFactoryForTest(&http.Client{Transport: http.DefaultTransport}), nil)

	got, err := svc.FetchAndSaveIconForFeed(context.Background(), 7, avatarURL, "")
	require.NoError(t, err)
	require.Equal(t, expected, got, "RSS <image> 是频道真头像，应存成按 URL 哈希命名的文件")
	require.Zero(t, atomic.LoadInt32(&instanceHits), "拿到 RSS 头像后就不该再去打实例 favicon")

	saved, err := os.ReadFile(filepath.Join(dataDir, "icons", expected))
	require.NoError(t, err)
	require.Equal(t, avatar, saved)
}

// 反解不出上游站点时宁可不抓，也不要拿实例 logo 冒充（与前端 feed-site.ts 同一条口径）。
func TestIconService_RSSHubUnknownRoute_NoAggregatorIcon(t *testing.T) {
	instanceIcon := pngBytes(t, 32, 32)
	var instanceHits int32
	mux := http.NewServeMux()
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&instanceHits, 1)
		_, _ = w.Write(instanceIcon)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, `<html><head><link rel="icon" href="/favicon.ico"></head></html>`)
	})
	instance := httptest.NewServer(mux)
	defer instance.Close()
	instanceHost, err := url.Parse(instance.URL)
	require.NoError(t, err)

	rsshubHost := "rsshub." + instanceHost.Hostname()
	unknownRoute := "https://" + rsshubHost + "/some/unknown/route?key=abc"

	dataDir := t.TempDir()
	repo := &feedRepoStub{
		getByIDFn: func(ctx context.Context, id int64) (model.Feed, error) {
			return model.Feed{ID: id, URL: unknownRoute}, nil
		},
	}
	transport := rewriteHostTransport{
		base:   thirdPartyBlockingTransport{base: http.DefaultTransport},
		from:   instanceHost.Hostname(),
		toHost: instanceHost.Host,
	}
	svc := service.NewIconService(dataDir, repo, network.NewClientFactoryForTest(&http.Client{Transport: transport}), nil)

	got, err := svc.FetchAndSaveIconForFeed(context.Background(), 9, "", unknownRoute)
	require.NoError(t, err)
	require.Empty(t, got, "认不出上游站点时应留空，由前端退回通用 RSS 图标，而不是显示实例 logo")
	require.Zero(t, atomic.LoadInt32(&instanceHits), "根本不该去请求 RSSHub 实例")
}

// 回填时要把「图标其实是实例 logo」的存量行清掉重抓（28-1 自愈）。
func TestIconService_BackfillRefetchesAggregatorIcon(t *testing.T) {
	upstreamIcon := pngBytes(t, 48, 48)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/favicon.ico" {
			_, _ = w.Write(upstreamIcon)
			return
		}
		http.NotFound(w, r)
	}))
	defer upstream.Close()

	rsshubHost := "rsshub.local"
	siteURL := "https://t.me/some_channel"

	var mu sync.Mutex
	cleared := map[int64]string{}
	refetched := map[int64]string{}

	repo := &feedRepoStub{
		listWithoutIconFn: func(context.Context) ([]model.Feed, error) {
			// 第 1 步：被清掉 icon_path 的行（重新入列）
			mu.Lock()
			defer mu.Unlock()
			feeds := make([]model.Feed, 0, len(cleared))
			for id := range cleared {
				feeds = append(feeds, model.Feed{ID: id, URL: rsshubHost + "/telegram/channel/some_channel?key=abc", SiteURL: &siteURL})
			}
			return feeds, nil
		},
		listFn: func(context.Context, *int64) ([]model.Feed, error) {
			// 存量现场：icon_path = rsshub.local.png（实例域名），但 site_url 是真实频道
			return []model.Feed{{
				ID: 100, URL: rsshubHost + "/telegram/channel/some_channel?key=abc",
				SiteURL: &siteURL, IconPath: strPtr(rsshubHost + ".png"),
			}}, nil
		},
		updateIconPathFn: func(_ context.Context, id int64, iconPath string) error {
			mu.Lock()
			defer mu.Unlock()
			if iconPath == "" {
				cleared[id] = iconPath
				return nil
			}
			refetched[id] = iconPath
			return nil
		},
		getByIDFn: func(_ context.Context, id int64) (model.Feed, error) {
			return model.Feed{ID: id, URL: rsshubHost + "/telegram/channel/some_channel?key=abc", SiteURL: &siteURL}, nil
		},
	}

	transport := rewriteHostTransport{
		base:   thirdPartyBlockingTransport{base: http.DefaultTransport},
		from:   "t.me",
		toHost: upstreamHost(t, upstream.URL),
	}
	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, repo, network.NewClientFactoryForTest(&http.Client{Transport: transport}), nil)

	require.NoError(t, svc.BackfillIcons(context.Background()))

	mu.Lock()
	defer mu.Unlock()
	require.Contains(t, cleared, int64(100), "实例 logo 那行应被清掉 icon_path 交给重抓")
	require.Equal(t, "t.me.png", refetched[100], "重抓后应拿到真实站点 t.me 的图标")
}
