package service_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"gist/backend/internal/repository/mock"
	"gist/backend/internal/model"
	"gist/backend/internal/service"
)

func newFeedServiceForMerge(t *testing.T) (*mock.MockFeedRepository, *mock.MockEntryRepository, service.FeedService) {
	t.Helper()
	ctrl := gomock.NewController(t)
	t.Cleanup(ctrl.Finish)
	feeds := mock.NewMockFeedRepository(ctrl)
	entries := mock.NewMockEntryRepository(ctrl)
	svc := service.NewFeedService(feeds, mock.NewMockFolderRepository(ctrl), entries, nil, nil, nil, nil, nil)
	return feeds, entries, svc
}

// 用户场景（2026-09-17 第十批 10-4）：RSSHub 换实例后，两个订阅的链接变成了同一个地址。
// 改地址时必须报冲突，让前端弹「确认合并」，而不是默默变成两条同源订阅。
func TestFeedService_UpdateURL_ConflictWithAnotherFeed(t *testing.T) {
	feeds, _, svc := newFeedServiceForMerge(t)

	source := model.Feed{ID: 1, Title: "Newlearner（旧实例）", URL: "https://old.app/telegram/channel/x"}
	existing := model.Feed{ID: 2, Title: "Newlearner（新实例）", URL: "https://new.app/telegram/channel/x"}

	feeds.EXPECT().GetByID(gomock.Any(), int64(1)).Return(source, nil)
	feeds.EXPECT().FindByURL(gomock.Any(), existing.URL).Return(&existing, nil)

	_, err := svc.UpdateURL(context.Background(), 1, existing.URL)

	var conflict *service.FeedURLConflictError
	require.ErrorAs(t, err, &conflict)
	require.EqualValues(t, 2, conflict.Feed.ID)
	require.Equal(t, "Newlearner（新实例）", conflict.Feed.Title)
}

// 目标地址还是自己的（或没人用）→ 照常改
func TestFeedService_UpdateURL_SameFeedNotAConflict(t *testing.T) {
	feeds, _, svc := newFeedServiceForMerge(t)

	source := model.Feed{ID: 1, Title: "A", URL: "https://old.app/x"}
	feeds.EXPECT().GetByID(gomock.Any(), int64(1)).Return(source, nil)
	feeds.EXPECT().FindByURL(gomock.Any(), "https://new.app/x").Return(&model.Feed{ID: 1, Title: "A", URL: "https://new.app/x"}, nil)
	updated := source
	updated.URL = "https://new.app/x"
	feeds.EXPECT().Update(gomock.Any(), gomock.Any()).Return(updated, nil)

	got, err := svc.UpdateURL(context.Background(), 1, "https://new.app/x")
	require.NoError(t, err)
	require.Equal(t, "https://new.app/x", got.URL)
}

// 弹框要显示「两边各有几条」→ 预览接口给出两侧的条目数/星标数
func TestFeedService_MergePreview(t *testing.T) {
	feeds, entries, svc := newFeedServiceForMerge(t)

	source := model.Feed{ID: 1, Title: "旧链接", URL: "https://old.app/x"}
	target := model.Feed{ID: 2, Title: "新链接", URL: "https://new.app/x"}

	feeds.EXPECT().GetByID(gomock.Any(), int64(1)).Return(source, nil)
	feeds.EXPECT().FindByURL(gomock.Any(), target.URL).Return(&target, nil)
	entries.EXPECT().FeedEntryStats(gomock.Any(), int64(1)).Return(int64(12), int64(3), nil)
	entries.EXPECT().FeedEntryStats(gomock.Any(), int64(2)).Return(int64(40), int64(5), nil)

	preview, err := svc.MergePreview(context.Background(), 1, target.URL)
	require.NoError(t, err)
	require.EqualValues(t, 12, preview.Source.Entries)
	require.EqualValues(t, 3, preview.Source.Starred)
	require.NotNil(t, preview.Target)
	require.EqualValues(t, 40, preview.Target.Entries)
	require.EqualValues(t, 5, preview.Target.Starred)
}

// 合并：条目搬到目标、来源没分类时把分类补过去、最后删掉来源（保留先存在的那条 = 目标）
func TestFeedService_MergeInto_CarriesFolderAndDeletesSource(t *testing.T) {
	feeds, entries, svc := newFeedServiceForMerge(t)

	folderID := int64(7)
	source := model.Feed{ID: 1, Title: "旧链接", URL: "https://old.app/x", FolderID: &folderID}
	target := model.Feed{ID: 2, Title: "新链接", URL: "https://new.app/x"}

	feeds.EXPECT().GetByID(gomock.Any(), int64(1)).Return(source, nil)
	feeds.EXPECT().GetByID(gomock.Any(), int64(2)).Return(target, nil)
	entries.EXPECT().MoveFeedEntries(gomock.Any(), int64(1), int64(2)).Return(int64(9), int64(2), nil)
	// 目标本来没有分类 → 把来源的分类补上
	feeds.EXPECT().Update(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, f model.Feed) (model.Feed, error) {
			require.NotNil(t, f.FolderID)
			require.EqualValues(t, folderID, *f.FolderID)
			require.EqualValues(t, 2, f.ID, "只动目标那条，来源不动")
			return f, nil
		})
	feeds.EXPECT().Delete(gomock.Any(), int64(1)).Return(nil)

	result, err := svc.MergeInto(context.Background(), 1, 2)
	require.NoError(t, err)
	require.EqualValues(t, 2, result.TargetID)
	require.EqualValues(t, 9, result.MovedEntries)
	require.EqualValues(t, 2, result.DedupedEntries)
}

// 目标已有分类 → 不动它（以保留的那条为准）
func TestFeedService_MergeInto_KeepsTargetFolder(t *testing.T) {
	feeds, entries, svc := newFeedServiceForMerge(t)

	sourceFolder, targetFolder := int64(7), int64(9)
	source := model.Feed{ID: 1, Title: "旧", URL: "https://old.app/x", FolderID: &sourceFolder}
	target := model.Feed{ID: 2, Title: "新", URL: "https://new.app/x", FolderID: &targetFolder}

	feeds.EXPECT().GetByID(gomock.Any(), int64(1)).Return(source, nil)
	feeds.EXPECT().GetByID(gomock.Any(), int64(2)).Return(target, nil)
	entries.EXPECT().MoveFeedEntries(gomock.Any(), int64(1), int64(2)).Return(int64(9), int64(0), nil)
	feeds.EXPECT().Delete(gomock.Any(), int64(1)).Return(nil)
	// 注意：没有任何 Update 期望 —— 目标分类不动

	result, err := svc.MergeInto(context.Background(), 1, 2)
	require.NoError(t, err)
	require.EqualValues(t, 2, result.TargetID)
}

// 自己跟自己合并没意义
func TestFeedService_MergeInto_SameIDInvalid(t *testing.T) {
	_, _, svc := newFeedServiceForMerge(t)
	_, err := svc.MergeInto(context.Background(), 3, 3)
	require.ErrorIs(t, err, service.ErrInvalid)
}
