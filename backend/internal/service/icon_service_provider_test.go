package service_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/service"
	"krss/backend/pkg/network"
)

// fakeFeedIconPlugin test-only 假插件：实现 plugin.FeedIconProvider，固定返回一个 URL。
type fakeFeedIconPlugin struct {
	id  string
	url string
}

func (p fakeFeedIconPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: p.id, Name: p.id, Builtin: true}
}
func (p fakeFeedIconPlugin) Actions() []plugin.Action                   { return nil }
func (p fakeFeedIconPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p fakeFeedIconPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p fakeFeedIconPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }
func (p fakeFeedIconPlugin) ID() string                                 { return p.id }
func (p fakeFeedIconPlugin) FeedIcon(_ context.Context, _ model.Feed) (string, error) {
	return p.url, nil
}

// providerHashName 是插件头像 URL 期望落盘的 hash 文件名（16 位 hex + .png）。
func providerHashName(t *testing.T, iconURL string) string {
	t.Helper()
	sum := sha256.Sum256([]byte(iconURL))
	return hex.EncodeToString(sum[:8]) + ".png"
}

// TestIconService_FetchAndSaveIconForFeed_UsesProvider 插件提供的头像 URL 优先，并按 hash 命名落盘。
func TestIconService_FetchAndSaveIconForFeed_UsesProvider(t *testing.T) {
	iconData := pngBytes(t, 3, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(iconData)
	}))
	defer server.Close()

	iconURL := server.URL + "/avatar.png"
	reg := plugin.NewRegistry()
	require.NoError(t, reg.Register(fakeFeedIconPlugin{id: "githubavatar", url: iconURL}))

	repo := &feedRepoStub{
		getByIDFn: func(_ context.Context, id int64) (model.Feed, error) {
			return model.Feed{ID: id, URL: "https://github.com/alice.atom"}, nil
		},
	}
	dataDir := t.TempDir()
	svc := service.NewIconService(dataDir, repo, network.NewClientFactoryForTest(&http.Client{}), nil,
		service.WithPluginRegistry(reg))

	got, err := svc.FetchAndSaveIconForFeed(context.Background(), 7, "", "")
	require.NoError(t, err)

	expected := providerHashName(t, iconURL)
	require.Equal(t, expected, got, "插件头像应存成 URL hash 文件名")
	_, err = os.Stat(filepath.Join(dataDir, "icons", expected))
	require.NoError(t, err, "图标文件应真实落盘")
}

// TestIconService_BackfillIcons_SyncsProviderIcon 已有通用图标的 feed 会被改成插件头像路径；
// 头像文件已存在时只改 DB，不再重复下载。
func TestIconService_BackfillIcons_SyncsProviderIcon(t *testing.T) {
	iconURL := "https://github.com/alice.png?size=120"
	expected := providerHashName(t, iconURL)

	dataDir := t.TempDir()
	iconsDir := filepath.Join(dataDir, "icons")
	require.NoError(t, os.MkdirAll(iconsDir, 0o755))
	// 预置头像文件（模拟之前已下载过），BackfillIcons 只应改 DB。
	require.NoError(t, os.WriteFile(filepath.Join(iconsDir, expected), pngBytes(t, 4, 4), 0o644))

	reg := plugin.NewRegistry()
	require.NoError(t, reg.Register(fakeFeedIconPlugin{id: "githubavatar", url: iconURL}))

	generic := "github.com.png"
	feed := model.Feed{ID: 42, URL: "https://github.com/alice.atom", IconPath: &generic}

	var mu sync.Mutex
	updates := map[int64]string{}
	repo := &feedRepoStub{
		listWithoutIconFn: func(context.Context) ([]model.Feed, error) { return nil, nil },
		listFn: func(context.Context, *int64) ([]model.Feed, error) {
			return []model.Feed{feed}, nil
		},
		getByIDFn: func(_ context.Context, id int64) (model.Feed, error) {
			return feed, nil
		},
		updateIconPathFn: func(_ context.Context, id int64, iconPath string) error {
			mu.Lock()
			defer mu.Unlock()
			updates[id] = iconPath
			return nil
		},
	}

	svc := service.NewIconService(dataDir, repo, network.NewClientFactoryForTest(&http.Client{}), nil,
		service.WithPluginRegistry(reg))

	require.NoError(t, svc.BackfillIcons(context.Background()))

	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, expected, updates[42], "应把通用图标改成插件头像的 hash 文件名")
}
