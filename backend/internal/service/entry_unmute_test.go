package service_test

import (
	"context"
	"errors"
	"testing"

	"krss/backend/internal/model"
	"krss/backend/internal/repository/mock"
	"krss/backend/internal/service"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

func TestEntryService_Unmute_ClearsMarksAndRestoresUnread(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockFolders := mock.NewMockFolderRepository(ctrl)
	svc := service.NewEntryService(mockEntries, mockFeeds, mockFolders, nil)

	ctx := context.Background()
	filterID := int64(42)
	mockEntries.EXPECT().
		GetByID(ctx, int64(7)).
		Return(model.Entry{ID: 7, FeedID: 1, Muted: true, Read: true, FilterID: &filterID}, nil)
	mockEntries.EXPECT().
		ResetFilterState(ctx, []int64{7}, true).
		Return(int64(1), nil)

	require.NoError(t, svc.Unmute(ctx, 7))
}

func TestEntryService_Unmute_NotMutedIsNoop(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockFolders := mock.NewMockFolderRepository(ctrl)
	svc := service.NewEntryService(mockEntries, mockFeeds, mockFolders, nil)

	ctx := context.Background()
	mockEntries.EXPECT().
		GetByID(ctx, int64(8)).
		Return(model.Entry{ID: 8, FeedID: 1, Muted: false}, nil)

	require.NoError(t, svc.Unmute(ctx, 8))
}

func TestEntryService_Unmute_MissingEntry(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockFolders := mock.NewMockFolderRepository(ctrl)
	svc := service.NewEntryService(mockEntries, mockFeeds, mockFolders, nil)

	ctx := context.Background()
	mockEntries.EXPECT().GetByID(ctx, int64(9)).Return(model.Entry{}, errors.New("sql: no rows in result set"))

	require.Error(t, svc.Unmute(ctx, 9))
}
