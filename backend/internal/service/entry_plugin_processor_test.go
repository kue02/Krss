package service_test

import (
	"context"
	"errors"
	"testing"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
	"krss/backend/internal/repository/mock"
	"krss/backend/internal/service"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

// 55-21：条目详情读取路径跑阅读期处理器（「某订阅源特别优化」的落点）。
//
// 口径（照计划 §9 / D4）：
//   - 处理器挂在读路径上，**不写库** —— 入库数据永远保持源站原样；
//   - 处理器出错只记日志、返回原条目：阅读体验不能被一个插件搞坏；
//   - 注册表没装（nil）⇒ 老行为，连 feed 都不查。

// fakeTitleSuffixProcessor 给标题加一个后缀；err 非空时模拟插件炸了。
type fakeTitleSuffixProcessor struct {
	suffix string
	err    error
}

func (fakeTitleSuffixProcessor) ID() string { return "fake-title-suffix" }

func (fakeTitleSuffixProcessor) Matches(model.Feed, model.Entry) bool { return true }

func (p fakeTitleSuffixProcessor) Process(entry model.Entry) (model.Entry, error) {
	if p.err != nil {
		return model.Entry{}, p.err
	}
	if entry.Title == nil {
		title := p.suffix
		entry.Title = &title
		return entry, nil
	}
	merged := *entry.Title + p.suffix
	entry.Title = &merged
	return entry, nil
}

// fakeProcessorPlugin 只声明一个阅读期处理器的最小插件。
type fakeProcessorPlugin struct{ processor plugin.EntryProcessor }

func (p fakeProcessorPlugin) Meta() plugin.Meta {
	return plugin.Meta{ID: "fake-processor", Name: "假处理器", Builtin: true}
}
func (fakeProcessorPlugin) Actions() []plugin.Action                   { return nil }
func (fakeProcessorPlugin) SettingsSections() []plugin.SettingsSection { return nil }
func (p fakeProcessorPlugin) EntryProcessors() []plugin.EntryProcessor {
	return []plugin.EntryProcessor{p.processor}
}
func (fakeProcessorPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

func newProcessorRegistry(t *testing.T, processor plugin.EntryProcessor) *plugin.Registry {
	t.Helper()
	registry := plugin.NewRegistry()
	require.NoError(t, registry.Register(fakeProcessorPlugin{processor: processor}))
	return registry
}

// entryServiceWithMocks 造一个 entryService + 它的两个关键仓储 mock（严格模式：
// 任何「没预期的写库调用」都会让测试失败，正好用来钉「读路径不写库」）。
func entryServiceWithMocks(ctrl *gomock.Controller) (service.EntryService, *mock.MockEntryRepository, *mock.MockFeedRepository) {
	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockFeeds := mock.NewMockFeedRepository(ctrl)
	svc := service.NewEntryService(mockEntries, mockFeeds, mock.NewMockFolderRepository(ctrl), nil)
	return svc, mockEntries, mockFeeds
}

func TestGetByID_PluginProcessorReturnsProcessedEntry(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc, mockEntries, mockFeeds := entryServiceWithMocks(ctrl)
	title := "原题目"
	mockEntries.EXPECT().GetByID(gomock.Any(), int64(7)).
		Return(model.Entry{ID: 7, FeedID: 3, Title: &title}, nil)
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(3)).
		Return(model.Feed{ID: 3, Title: "某订阅源"}, nil)

	svc = svc.WithPlugins(newProcessorRegistry(t, fakeTitleSuffixProcessor{suffix: " [已优化]"}))

	entry, err := svc.GetByID(context.Background(), 7)
	require.NoError(t, err)
	require.NotNil(t, entry.Title)
	require.Equal(t, "原题目 [已优化]", *entry.Title, "详情读取走插件处理器（返回处理后的条目）")
}

func TestGetByID_PluginProcessorErrorFallsBackToOriginal(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc, mockEntries, mockFeeds := entryServiceWithMocks(ctrl)
	title := "原题目"
	mockEntries.EXPECT().GetByID(gomock.Any(), int64(8)).
		Return(model.Entry{ID: 8, FeedID: 3, Title: &title}, nil)
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(3)).
		Return(model.Feed{ID: 3, Title: "某订阅源"}, nil)

	svc = svc.WithPlugins(newProcessorRegistry(t, fakeTitleSuffixProcessor{err: errors.New("插件崩了")}))

	entry, err := svc.GetByID(context.Background(), 8)
	require.NoError(t, err, "插件出错不许把详情读取搞挂")
	require.NotNil(t, entry.Title)
	require.Equal(t, "原题目", *entry.Title, "插件出错 ⇒ 返回原条目")
}

func TestGetByID_NoPluginRegistryKeepsOriginal(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// 不接注册表：连 feed 都不该查（严格 mock 没给 feeds.GetByID 预期）。
	svc, mockEntries, _ := entryServiceWithMocks(ctrl)
	title := "原题目"
	mockEntries.EXPECT().GetByID(gomock.Any(), int64(9)).
		Return(model.Entry{ID: 9, FeedID: 3, Title: &title}, nil)

	entry, err := svc.GetByID(context.Background(), 9)
	require.NoError(t, err)
	require.NotNil(t, entry.Title)
	require.Equal(t, "原题目", *entry.Title, "没装注册表 ⇒ 老行为（原样返回）")
}
