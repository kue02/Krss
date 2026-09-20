package service_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"krss/backend/internal/model"
	repomock "krss/backend/internal/repository/mock"
	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"
)

// 14 批：代理按来源生效 —— 解析顺序「订阅 → 文件夹（含父级链）→ 全局」，第一个非 NULL 说了算。
// 这些用例全部走公开 API（黑盒），断言的是「实际生效的代理 URL / 来源」。

const (
	globalProxyURL = "http://global-proxy.local:7890"
	feedProxyURL   = "socks5://feed-proxy.local:1080"
	folderProxyURL = "http://folder-proxy.local:8888"
)

func proxyModePtr(mode model.ProxyMode) *model.ProxyMode { return &mode }

// newProxySources 造一个「全局开着代理」的最小环境。
func newProxySources(t *testing.T, ctrl *gomock.Controller, globalURL string) (*repomock.MockFeedRepository, *repomock.MockFolderRepository, service.ProxySourceService) {
	t.Helper()
	feeds := repomock.NewMockFeedRepository(ctrl)
	folders := repomock.NewMockFolderRepository(ctrl)
	settings := mock.NewMockSettingsService(ctrl)
	settings.EXPECT().GetProxyURL(gomock.Any()).Return(globalURL).AnyTimes()
	return feeds, folders, service.NewProxySourceService(feeds, folders, settings)
}

func TestProxySource_FeedOverrideWins(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	feeds, folders, sources := newProxySources(t, ctrl, globalProxyURL)
	_ = feeds
	_ = folders

	feed := model.Feed{
		ID:          1,
		Title:       "GitHub Trending",
		ProxyMode:   proxyModePtr(model.ProxyModeProxy),
		ProxyConfig: &model.ProxyOverrideConfig{Type: "socks5", Host: "feed-proxy.local", Port: 1080},
	}

	effective := sources.ResolveForFeed(context.Background(), feed)
	require.Equal(t, "proxy", effective.Mode)
	require.Equal(t, service.ProxySourceFeed, effective.Source)
	require.Equal(t, feedProxyURL, effective.URL)
}

// 订阅说「直连」时不再往下找 —— 这就是「第一个非 NULL 说了算」。
func TestProxySource_FeedDirectStopsChain(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	feeds, folders, sources := newProxySources(t, ctrl, globalProxyURL)
	_ = feeds

	folderID := int64(9)
	// 文件夹是「走代理」，但订阅明确「直连」→ 不应再读文件夹（否则就是调用次数打脸）
	_ = folders

	feed := model.Feed{ID: 2, Title: "少数派", FolderID: &folderID, ProxyMode: proxyModePtr(model.ProxyModeDirect)}
	effective := sources.ResolveForFeed(context.Background(), feed)
	require.Equal(t, "direct", effective.Mode)
	require.Equal(t, service.ProxySourceFeed, effective.Source)
	require.Empty(t, effective.URL)
}

// 订阅没设，文件夹（最近一层）设了「走代理 + 单独一套」→ 用文件夹那套；来源名字要带出来给界面显示。
func TestProxySource_FolderNearestWins(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	_, folders, sources := newProxySources(t, ctrl, globalProxyURL)

	childID := int64(20)
	parentID := int64(10)
	folders.EXPECT().GetByID(gomock.Any(), childID).Return(model.Folder{
		ID:          childID,
		Name:        "技术",
		ParentID:    &parentID,
		ProxyMode:   proxyModePtr(model.ProxyModeProxy),
		ProxyConfig: &model.ProxyOverrideConfig{Type: "http", Host: "folder-proxy.local", Port: 8888},
	}, nil)

	feed := model.Feed{ID: 3, Title: "GitHub Trending", FolderID: &childID}
	effective := sources.ResolveForFeed(context.Background(), feed)
	require.Equal(t, "proxy", effective.Mode)
	require.Equal(t, service.ProxySourceFolder, effective.Source)
	require.Equal(t, "技术", effective.SourceName)
	require.Equal(t, folderProxyURL, effective.URL)
}

// 父级链：子文件夹没设 → 往上找父文件夹（含父级链那条要求）。
func TestProxySource_FolderParentChain(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	feeds, folders, sources := newProxySources(t, ctrl, globalProxyURL)
	_ = feeds

	childID := int64(20)
	parentID := int64(10)
	folders.EXPECT().GetByID(gomock.Any(), childID).Return(model.Folder{ID: childID, Name: "前端", ParentID: &parentID}, nil)
	folders.EXPECT().GetByID(gomock.Any(), parentID).Return(model.Folder{
		ID:          parentID,
		Name:        "技术",
		ProxyMode:   proxyModePtr(model.ProxyModeProxy),
		ProxyConfig: &model.ProxyOverrideConfig{Type: "http", Host: "folder-proxy.local", Port: 8888},
	}, nil)

	feed := model.Feed{ID: 4, Title: "Twitter @歸藏", FolderID: &childID}
	effective := sources.ResolveForFeed(context.Background(), feed)
	require.Equal(t, "proxy", effective.Mode)
	require.Equal(t, service.ProxySourceFolder, effective.Source)
	require.Equal(t, "技术", effective.SourceName)
	require.Equal(t, folderProxyURL, effective.URL)
}

// 订阅说「走代理 + 用全局那套」→ 用全局地址。
func TestProxySource_FeedProxyUsesGlobalConfig(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	_, _, sources := newProxySources(t, ctrl, globalProxyURL)

	feed := model.Feed{ID: 5, Title: "订阅", ProxyMode: proxyModePtr(model.ProxyModeProxy)}
	effective := sources.ResolveForFeed(context.Background(), feed)
	require.Equal(t, "proxy", effective.Mode)
	require.Equal(t, service.ProxySourceFeed, effective.Source)
	require.Equal(t, globalProxyURL, effective.URL)
	require.False(t, effective.Missing)
}

// 订阅说「走代理」但全局没配（总开关关）→ 实际直连，并且 Missing 标出来（界面要能说明原因）。
func TestProxySource_ProxyWithoutConfigFallsBackToDirect(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	_, _, sources := newProxySources(t, ctrl, "")

	feed := model.Feed{ID: 6, Title: "订阅", ProxyMode: proxyModePtr(model.ProxyModeProxy)}
	effective := sources.ResolveForFeed(context.Background(), feed)
	require.Equal(t, "direct", effective.Mode)
	require.Equal(t, service.ProxySourceFeed, effective.Source)
	require.True(t, effective.Missing)
	require.Empty(t, effective.URL)
}

// 全都没设 → 跟全局（全局开着就是走代理）。
func TestProxySource_GlobalFallback(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	_, _, sources := newProxySources(t, ctrl, globalProxyURL)

	effective := sources.ResolveForFeed(context.Background(), model.Feed{ID: 7, Title: "未设置"})
	require.Equal(t, "proxy", effective.Mode)
	require.Equal(t, service.ProxySourceGlobal, effective.Source)
	require.Equal(t, globalProxyURL, effective.URL)
}

// ProxyURLForFeed：正常解析 ok=true（空串 = 直连，调用方不能再回落全局）；
// 订阅不存在 → ok=false，调用方退回全局（老行为）。
func TestProxySource_ProxyURLForFeed(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	feeds, _, sources := newProxySources(t, ctrl, globalProxyURL)
	feeds.EXPECT().GetByID(gomock.Any(), int64(8)).Return(model.Feed{ID: 8, ProxyMode: proxyModePtr(model.ProxyModeDirect)}, nil)
	feeds.EXPECT().GetByID(gomock.Any(), int64(9)).Return(model.Feed{}, errors.New("not found"))

	url, ok := sources.ProxyURLForFeed(context.Background(), 8)
	require.True(t, ok)
	require.Empty(t, url)

	_, ok = sources.ProxyURLForFeed(context.Background(), 9)
	require.False(t, ok)
}

// 一览：计数 + 生效结果 + 密码掩码（订阅级也要脱敏）。
func TestProxySource_Overview(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	feeds := repomock.NewMockFeedRepository(ctrl)
	folders := repomock.NewMockFolderRepository(ctrl)
	settings := mock.NewMockSettingsService(ctrl)
	settings.EXPECT().GetProxyURL(gomock.Any()).Return(globalProxyURL).AnyTimes()
	settings.EXPECT().GetNetworkSettings(gomock.Any()).Return(&service.NetworkSettings{
		Enabled: true, Type: "http", Host: "global-proxy.local", Port: 7890, Password: "***",
	}, nil)

	folderID := int64(10)
	folders.EXPECT().GetByID(gomock.Any(), folderID).Return(model.Folder{ID: folderID, Name: "技术"}, nil).AnyTimes()
	folders.EXPECT().GetByID(gomock.Any(), int64(11)).Return(model.Folder{ID: 11, Name: "国内资讯"}, nil).AnyTimes()
	folders.EXPECT().List(gomock.Any()).Return([]model.Folder{
		{ID: folderID, Name: "技术", ProxyMode: proxyModePtr(model.ProxyModeDirect)},
		{ID: 11, Name: "国内资讯"},
	}, nil)
	feeds.EXPECT().List(gomock.Any(), gomock.Nil()).Return([]model.Feed{
		{
			ID:        1,
			Title:     "少数派",
			FolderID:  &folderID,
			ProxyMode: proxyModePtr(model.ProxyModeProxy),
			ProxyConfig: &model.ProxyOverrideConfig{
				Type: "http", Host: "feed-proxy.local", Port: 8888, Username: "u", Password: "super-secret-password",
			},
		},
		{ID: 2, Title: "小众软件"},
	}, nil)
	folders.EXPECT().GetByID(gomock.Any(), folderID).Return(model.Folder{ID: folderID, Name: "技术"}, nil).AnyTimes()

	sources := service.NewProxySourceService(feeds, folders, settings)
	overview, err := sources.Overview(context.Background())
	require.NoError(t, err)

	require.Equal(t, 1, overview.Counts.Folders)
	require.Equal(t, 1, overview.Counts.Feeds)
	require.Len(t, overview.Folders, 2)
	require.Len(t, overview.Feeds, 2)
	require.Equal(t, 1, overview.Folders[0].FeedCount, "文件夹要带直接挂着的订阅数")

	// 订阅 1：自己设了「走代理 + 单独一套」
	require.Equal(t, "proxy", overview.Feeds[0].Override.Mode)
	require.Equal(t, service.ProxySourceFeed, overview.Feeds[0].Effective.Source)
	require.NotNil(t, overview.Feeds[0].Override.Config)
	require.NotEqual(t, "super-secret-password", overview.Feeds[0].Override.Config.Password, "密码必须掩码")
	require.Contains(t, overview.Feeds[0].Override.Config.Password, "***")

	// 订阅 2：没设 → 跟全局
	require.Equal(t, "inherit", overview.Feeds[1].Override.Mode)
	require.Equal(t, service.ProxySourceGlobal, overview.Feeds[1].Effective.Source)
}

// 三态字符串与代理模式互转（接口层用）。
func TestProxyModeStringRoundTrip(t *testing.T) {
	require.Equal(t, "inherit", service.ProxyModeToString(nil))
	require.Equal(t, "direct", service.ProxyModeToString(proxyModePtr(model.ProxyModeDirect)))
	require.Equal(t, "proxy", service.ProxyModeToString(proxyModePtr(model.ProxyModeProxy)))

	mode, ok := service.ProxyModeFromString("inherit")
	require.True(t, ok)
	require.Nil(t, mode)

	_, ok = service.ProxyModeFromString("bogus")
	require.False(t, ok)
}
