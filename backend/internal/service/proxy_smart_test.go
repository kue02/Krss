package service_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"krss/backend/internal/model"
	repomock "krss/backend/internal/repository/mock"
	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"
)

// 50 批 2.2：智能档 —— proxy_mode=2 的解析结果编码成 smart:<url>；
// 全局模式 smart 时兜底也编码；订阅显式 direct/proxy 优先于全局模式。
func TestProxySource_SmartFeedEncodesSmartPrefix(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	feeds, folders, sources := newProxySources(t, ctrl, globalProxyURL)
	_ = feeds
	_ = folders

	feed := model.Feed{
		ID:        30,
		Title:     "智能源",
		ProxyMode: proxyModePtr(model.ProxyModeSmart),
	}

	effective := sources.ResolveForFeed(context.Background(), feed)
	require.Equal(t, "smart", effective.Mode)
	require.True(t, len(effective.URL) > len("smart:"), "smart 档要带代理地址")
	require.Equal(t, "smart:"+globalProxyURL, effective.URL)
}

func TestProxySource_SmartWithOwnConfigUsesOwnURL(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	feeds, folders, sources := newProxySources(t, ctrl, globalProxyURL)
	_ = feeds
	_ = folders

	feed := model.Feed{
		ID:          31,
		Title:       "自带配置的智能源",
		ProxyMode:   proxyModePtr(model.ProxyModeSmart),
		ProxyConfig: &model.ProxyOverrideConfig{Type: "socks5", Host: "feed-proxy.local", Port: 1080},
	}

	effective := sources.ResolveForFeed(context.Background(), feed)
	require.Equal(t, "smart", effective.Mode)
	require.Equal(t, "smart:"+feedProxyURL, effective.URL)
}

func TestProxySource_SmartNoProxyAvailableDegradedDirect(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// 全局代理没配（空 URL）
	feeds, folders, sources := newProxySources(t, ctrl, "")
	_ = feeds
	_ = folders

	feed := model.Feed{
		ID:        32,
		Title:     "没代理可切的智能源",
		ProxyMode: proxyModePtr(model.ProxyModeSmart),
	}

	effective := sources.ResolveForFeed(context.Background(), feed)
	require.Equal(t, "direct", effective.Mode)
	require.True(t, effective.Missing)
}

func TestProxySource_GlobalSmartEncodesSmartPrefix(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	feeds := repomock.NewMockFeedRepository(ctrl)
	folders := repomock.NewMockFolderRepository(ctrl)
	settings := mock.NewMockSettingsService(ctrl)
	settings.EXPECT().GetProxyURL(gomock.Any()).Return(globalProxyURL).AnyTimes()
	settings.EXPECT().GetNetworkSettingsMode(gomock.Any()).Return("smart").AnyTimes()
	sources := service.NewProxySourceService(feeds, folders, settings)
	_ = feeds
	_ = folders

	// 未覆盖的订阅 → 全局 smart
	effective := sources.ResolveForFeed(context.Background(), model.Feed{ID: 33, Title: "跟随全局 smart"})
	require.Equal(t, "smart", effective.Mode)
	require.Equal(t, "smart:"+globalProxyURL, effective.URL)
	require.Equal(t, service.ProxySourceGlobal, effective.Source)

	// 全局 smart 时，订阅显式 proxy 仍是普通代理（不是 smart）
	effective = sources.ResolveForFeed(context.Background(), model.Feed{
		ID: 34, Title: "显式代理", ProxyMode: proxyModePtr(model.ProxyModeProxy),
	})
	require.Equal(t, "proxy", effective.Mode)
	require.Equal(t, globalProxyURL, effective.URL)
}

func TestProxySource_SmartModeStringRoundTrip(t *testing.T) {
	smart := model.ProxyModeSmart
	require.Equal(t, "smart", service.ProxyModeToString(&smart))
	mode, ok := service.ProxyModeFromString("smart")
	require.True(t, ok)
	require.Equal(t, model.ProxyModeSmart, *mode)
}
