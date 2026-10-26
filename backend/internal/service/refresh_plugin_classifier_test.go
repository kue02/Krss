package service_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/repository/mock"
	"krss/backend/internal/service"
	"krss/backend/pkg/network"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

// 55-17：抓取失败归类走插件链。
//
// 口径（与 55-13 搬 bark 一致）：本体不再认识任何「某家实例的错误页」，
// 刷新失败时先问已启用的 FetchClassifier；没人认（空串）或注册表没装 ⇒ 原样透传，
// 与「插件没装」的老行为一致。

// fakeClassifier 永远认领这次失败（返回固定分类串）。
type fakeClassifier struct{ msg string }

func (fakeClassifier) ID() string { return "fake" }

func (c fakeClassifier) Classify(_ context.Context, _ model.Feed, _ int, _ []byte, _ error) string {
	return c.msg
}

// fakeClassifierPlugin 只声明一个抓取分类器的最小插件。
type fakeClassifierPlugin struct{ classifier plugin.FetchClassifier }

func (p fakeClassifierPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: "fake-classifier", Name: "假分类器", Builtin: true}
}
func (fakeClassifierPlugin) Actions() []plugin.Action                   { return nil }
func (fakeClassifierPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (fakeClassifierPlugin) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (p fakeClassifierPlugin) FetchClassifiers() []plugin.FetchClassifier {
	return []plugin.FetchClassifier{p.classifier}
}

func newClassifierRegistry(t *testing.T, classifier plugin.FetchClassifier) *plugin.Registry {
	t.Helper()
	registry := plugin.NewRegistry()
	require.NoError(t, registry.Register(fakeClassifierPlugin{classifier: classifier}))
	return registry
}

// failingFeedClient 造一次 404（正文随便给一句，分类器不看它）。
func failingFeedClient() *http.Client {
	return &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusNotFound,
				Body:       io.NopCloser(strings.NewReader("not found")),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}
}

func TestRefreshService_ClassifyFetchFailure_UsesPluginChain(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	feed := model.Feed{ID: 9, URL: "https://rsshub.example.com/twitter/user/x", Title: "Feed"}

	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(9)).Return(feed, nil)
	var stored *string
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(9), gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, msg *string) error {
			stored = msg
			return nil
		},
	)
	mockFeeds.EXPECT().RecordRefreshFailure(gomock.Any(), int64(9), gomock.Any()).Return(nil)

	svc := service.NewRefreshService(
		mockFeeds,
		mock.NewMockEntryRepository(ctrl),
		nil,
		nil,
		network.NewClientFactoryForTest(failingFeedClient()),
		nil,
		nil,
		nil,
	).WithPlugins(newClassifierRegistry(t, fakeClassifier{msg: "classified: x"}))

	require.NoError(t, svc.RefreshFeed(context.Background(), feed.ID))
	require.NotNil(t, stored)
	require.Equal(t, "classified: x", *stored, "插件认领了这次失败 ⇒ last_error 存插件给的分类串")
}

func TestRefreshService_ClassifyFetchFailure_NoRegistryKeepsOldBehavior(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	feed := model.Feed{ID: 10, URL: "https://rsshub.example.com/twitter/user/x", Title: "Feed"}

	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(10)).Return(feed, nil)
	var stored *string
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(10), gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, msg *string) error {
			stored = msg
			return nil
		},
	)
	mockFeeds.EXPECT().RecordRefreshFailure(gomock.Any(), int64(10), gomock.Any()).Return(nil)

	// 不接注册表（nil）：老行为 —— 干巴巴的 HTTP 状态码。
	svc := service.NewRefreshService(
		mockFeeds,
		mock.NewMockEntryRepository(ctrl),
		nil,
		nil,
		network.NewClientFactoryForTest(failingFeedClient()),
		nil,
		nil,
		nil,
	)

	require.NoError(t, svc.RefreshFeed(context.Background(), feed.ID))
	require.NotNil(t, stored)
	require.Equal(t, "HTTP 404", *stored, "没装注册表 ⇒ 原样透传（老行为）")
}

func TestRefreshService_ClassifyFetchFailure_DisabledPluginNotConsulted(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	feed := model.Feed{ID: 11, URL: "https://rsshub.example.com/twitter/user/x", Title: "Feed"}

	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(11)).Return(feed, nil)
	var stored *string
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(11), gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, msg *string) error {
			stored = msg
			return nil
		},
	)
	mockFeeds.EXPECT().RecordRefreshFailure(gomock.Any(), int64(11), gomock.Any()).Return(nil)

	registry := newClassifierRegistry(t, fakeClassifier{msg: "classified: x"})
	require.True(t, registry.SetEnabled("fake-classifier", false))

	svc := service.NewRefreshService(
		mockFeeds,
		mock.NewMockEntryRepository(ctrl),
		nil,
		nil,
		network.NewClientFactoryForTest(failingFeedClient()),
		nil,
		nil,
		nil,
	).WithPlugins(registry)

	require.NoError(t, svc.RefreshFeed(context.Background(), feed.ID))
	require.NotNil(t, stored)
	require.Equal(t, "HTTP 404", *stored, "插件停用 ⇒ 不参与归类（停用即失效）")
}
