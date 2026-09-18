package handler_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"gist/backend/internal/handler"
	"gist/backend/internal/model"
	"gist/backend/internal/service"
	"gist/backend/internal/service/mock"
)

// 14 批：PATCH /feeds/:id/proxy 与 PATCH /folders/:id/proxy 的接口契约。
// 订阅级/文件夹级都要：三态字符串、单独指定那套、密码掩码、以及回显的实际生效结果。

func TestFeedHandler_UpdateProxyOverride_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFeedService(ctrl)
	mockSources := mock.NewMockProxySourceService(ctrl)
	h := handler.NewFeedHandlerHelper(mockService, mock.NewMockRefreshService(ctrl), mockSources)

	proxyMode := model.ProxyModeProxy
	updated := model.Feed{
		ID:          7,
		Title:       "少数派",
		URL:         "https://sspai.com/feed",
		ProxyMode:   &proxyMode,
		ProxyConfig: &model.ProxyOverrideConfig{Type: "http", Host: "127.0.0.1", Port: 7890, Password: "abc***xyz"},
	}
	mockService.EXPECT().
		UpdateProxyOverride(gomock.Any(), int64(7), gomock.Any()).
		DoAndReturn(func(_ interface{}, _ int64, update service.ProxyOverrideUpdate) (model.Feed, error) {
			require.True(t, update.SetMode)
			require.NotNil(t, update.Mode)
			require.Equal(t, model.ProxyModeProxy, *update.Mode)
			require.True(t, update.SetConfig)
			require.NotNil(t, update.Config)
			require.Equal(t, "127.0.0.1", update.Config.Host)
			return updated, nil
		})
	mockSources.EXPECT().ResolveForFeed(gomock.Any(), gomock.Any()).Return(service.ProxyEffective{
		Mode:       "proxy",
		Source:     service.ProxySourceFeed,
		SourceName: "少数派",
	})

	e := newTestEcho()
	req := newJSONRequest(http.MethodPatch, "/feeds/7/proxy", map[string]interface{}{
		"mode":   "proxy",
		"config": map[string]interface{}{"type": "http", "host": "127.0.0.1", "port": 7890},
	})
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"id": "7"})

	require.NoError(t, h.UpdateProxyOverride(c))
	require.Equal(t, http.StatusOK, rec.Code)

	var body struct {
		Feed      map[string]interface{} `json:"feed"`
		Effective service.ProxyEffective `json:"effective"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "proxy", body.Feed["proxyMode"])
	require.Equal(t, "proxy", body.Effective.Mode)
	require.Equal(t, service.ProxySourceFeed, body.Effective.Source)
	require.Equal(t, "7", body.Feed["id"])
	// 密码只以掩码形态出现，明文不进响应
	require.NotContains(t, rec.Body.String(), "super-secret")
}

func TestFeedHandler_UpdateProxyOverride_InheritAndClearConfig(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFeedService(ctrl)
	mockSources := mock.NewMockProxySourceService(ctrl)
	h := handler.NewFeedHandlerHelper(mockService, mock.NewMockRefreshService(ctrl), mockSources)

	mockService.EXPECT().
		UpdateProxyOverride(gomock.Any(), int64(7), gomock.Any()).
		DoAndReturn(func(_ interface{}, _ int64, update service.ProxyOverrideUpdate) (model.Feed, error) {
			require.True(t, update.SetMode)
			require.Nil(t, update.Mode, "inherit = 清掉这一层的档位")
			require.True(t, update.SetConfig)
			require.Nil(t, update.Config, "config: null = 清掉单独指定那套")
			return model.Feed{ID: 7, Title: "少数派"}, nil
		})
	mockSources.EXPECT().ResolveForFeed(gomock.Any(), gomock.Any()).Return(service.ProxyEffective{
		Mode:   "direct",
		Source: service.ProxySourceGlobal,
	})

	e := newTestEcho()
	req := newJSONRequestRaw(http.MethodPatch, "/feeds/7/proxy", `{"mode":"inherit","config":null}`)
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"id": "7"})

	require.NoError(t, h.UpdateProxyOverride(c))
	require.Equal(t, http.StatusOK, rec.Code)
}

func TestFeedHandler_UpdateProxyOverride_InvalidRequests(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFeedService(ctrl)
	h := handler.NewFeedHandlerHelper(mockService, mock.NewMockRefreshService(ctrl), mock.NewMockProxySourceService(ctrl))

	cases := []struct {
		name string
		body string
	}{
		{"非法档位", `{"mode":"maybe"}`},
		{"单独指定缺地址", `{"mode":"proxy","config":{"type":"http","port":7890}}`},
		{"单独指定端口越界", `{"mode":"proxy","config":{"type":"http","host":"127.0.0.1","port":70000}}`},
		{"单独指定的类型不认识", `{"mode":"proxy","config":{"type":"ftp","host":"127.0.0.1","port":21}}`},
	}
	e := newTestEcho()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := newJSONRequestRaw(http.MethodPatch, "/feeds/7/proxy", tc.body)
			c, rec := newTestContext(e, req)
			setPathParams(c, map[string]string{"id": "7"})
			require.NoError(t, h.UpdateProxyOverride(c))
			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestFolderHandler_UpdateProxyOverride_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFolderService(ctrl)
	mockSources := mock.NewMockProxySourceService(ctrl)
	h := handler.NewFolderHandlerHelper(mockService, mockSources)

	direct := model.ProxyModeDirect
	mockService.EXPECT().
		UpdateProxyOverride(gomock.Any(), int64(10), gomock.Any()).
		DoAndReturn(func(_ interface{}, _ int64, update service.ProxyOverrideUpdate) (model.Folder, error) {
			require.True(t, update.SetMode)
			require.Equal(t, model.ProxyModeDirect, *update.Mode)
			require.False(t, update.SetConfig, "没带 config 就不动它")
			return model.Folder{ID: 10, Name: "技术", ProxyMode: &direct}, nil
		})
	mockSources.EXPECT().ResolveForFolder(gomock.Any(), int64(10)).Return(service.ProxyEffective{
		Mode:       "direct",
		Source:     service.ProxySourceFolder,
		SourceName: "技术",
	})

	e := newTestEcho()
	req := newJSONRequest(http.MethodPatch, "/folders/10/proxy", map[string]interface{}{"mode": "direct"})
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"id": "10"})

	require.NoError(t, h.UpdateProxyOverride(c))
	require.Equal(t, http.StatusOK, rec.Code)

	var body struct {
		Folder    map[string]interface{} `json:"folder"`
		Effective service.ProxyEffective `json:"effective"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "direct", body.Folder["proxyMode"])
	require.Equal(t, "direct", body.Effective.Mode)
	require.Equal(t, "技术", body.Effective.SourceName)
}

// 测试按钮的「按来源试」：这一条当前直连时直接给出结论（不发出网请求）。
func TestSettingsHandler_TestNetworkProxy_BySourceDirect(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockSettings := mock.NewMockSettingsService(ctrl)
	mockSources := mock.NewMockProxySourceService(ctrl)
	mockSources.EXPECT().ResolveForFeedID(gomock.Any(), int64(7)).Return(service.ProxyEffective{
		Mode:   "direct",
		Source: service.ProxySourceGlobal,
	})

	h := handler.NewSettingsHandlerHelper(mockSettings, nil, mockSources)
	e := newTestEcho()
	req := newJSONRequest(http.MethodPost, "/settings/network/test", map[string]interface{}{
		"enabled": false,
		"feedId":  "7",
	})
	c, rec := newTestContext(e, req)

	require.NoError(t, h.TestNetworkProxy(c))
	require.Equal(t, http.StatusOK, rec.Code)

	var body handler.NetworkTestResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.True(t, body.Success)
	require.Contains(t, body.Message, "direct")
}

// 按来源试但 id 不是 Snowflake 字符串 → 400（不静默当成全局）。
func TestSettingsHandler_TestNetworkProxy_BySourceInvalidID(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	h := handler.NewSettingsHandlerHelper(mock.NewMockSettingsService(ctrl), nil, mock.NewMockProxySourceService(ctrl))
	e := newTestEcho()
	req := newJSONRequest(http.MethodPost, "/settings/network/test", map[string]interface{}{"feedId": "abc"})
	c, rec := newTestContext(e, req)

	require.NoError(t, h.TestNetworkProxy(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// GET /api/proxy/sources：设置页「按来源覆盖」段的数据源（计数 + 每条生效结果）。
func TestProxySourceHandler_List(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockSources := mock.NewMockProxySourceService(ctrl)
	mockSources.EXPECT().Overview(gomock.Any()).Return(&service.ProxySourceOverview{
		Global: &service.NetworkSettings{Enabled: true, Type: "http", Host: "127.0.0.1", Port: 7890, Password: "***"},
		Folders: []service.ProxyFolderView{{
			ID: "10", Name: "技术", Type: "article", FeedCount: 2,
			Override:  service.ProxyOverrideView{Mode: "proxy"},
			Effective: service.ProxyEffective{Mode: "proxy", Source: service.ProxySourceFolder, SourceName: "技术"},
		}},
		Feeds: []service.ProxyFeedView{{
			ID: "7", Title: "少数派", FolderID: "10", Type: "article",
			Override:  service.ProxyOverrideView{Mode: "inherit"},
			Effective: service.ProxyEffective{Mode: "proxy", Source: service.ProxySourceFolder, SourceName: "技术"},
		}},
		Counts: service.ProxyOverrideCount{Folders: 1, Feeds: 1, ProxiedFeeds: 1, GlobalEnabled: true},
	}, nil)

	h := handler.NewProxySourceHandlerHelper(mockSources)
	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/proxy/sources", nil)
	c, rec := newTestContext(e, req)

	require.NoError(t, h.List(c))
	require.Equal(t, http.StatusOK, rec.Code)

	var body service.ProxySourceOverview
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, 1, body.Counts.Folders)
	require.Equal(t, 1, body.Counts.Feeds)
	require.Equal(t, "技术", body.Feeds[0].Effective.SourceName)
	require.Equal(t, "***", body.Global.Password, "全局密码也必须掩码")
}
