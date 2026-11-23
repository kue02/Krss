package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"krss/backend/internal/repository/mock"
	"krss/backend/internal/service"
	servicemock "krss/backend/internal/service/mock"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

func TestEntryService_ClearReadabilityCache(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockEntries := mock.NewMockEntryRepository(ctrl)
	svc := service.NewEntryService(mockEntries, mock.NewMockFeedRepository(ctrl), mock.NewMockFolderRepository(ctrl), nil)

	mockEntries.EXPECT().ClearAllReadableContent(context.Background()).Return(int64(5), nil)

	count, err := svc.ClearReadabilityCache(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(5), count)
}

func TestEntryService_ClearEntryCache(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockFeeds := mock.NewMockFeedRepository(ctrl)
	svc := service.NewEntryService(mockEntries, mockFeeds, mock.NewMockFolderRepository(ctrl), nil)

	mockEntries.EXPECT().DeleteReadUnstarred(context.Background(), gomock.Any(), gomock.Any()).Return(int64(3), nil)

	count, err := svc.ClearEntryCache(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(3), count)
}

func TestEntryService_ClearCaches_RepositoryError(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockEntries := mock.NewMockEntryRepository(ctrl)
	svc := service.NewEntryService(mockEntries, mock.NewMockFeedRepository(ctrl), mock.NewMockFolderRepository(ctrl), nil)

	errReadability := errors.New("clear readability failed")
	errEntries := errors.New("clear entries failed")

	mockEntries.EXPECT().ClearAllReadableContent(context.Background()).Return(int64(0), errReadability)
	_, err := svc.ClearReadabilityCache(context.Background())
	require.ErrorIs(t, err, errReadability)

	mockEntries.EXPECT().DeleteReadUnstarred(context.Background(), gomock.Any(), gomock.Any()).Return(int64(0), errEntries)
	_, err = svc.ClearEntryCache(context.Background())
	require.ErrorIs(t, err, errEntries)
}

// 1123：设置为 0/0 时，两个时间门槛都是 nil（清全部 / 墓碑永久保留，老行为）。
func TestEntryService_ClearEntryCache_ZeroRetentionMeansNoCutoff(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockSettings := servicemock.NewMockSettingsService(ctrl)
	svc := service.NewEntryService(mockEntries, mock.NewMockFeedRepository(ctrl), mock.NewMockFolderRepository(ctrl), nil).
		WithCacheSettings(mockSettings)

	mockSettings.EXPECT().GetCacheSettings(gomock.Any()).Return(&service.CacheSettings{
		EntryRetentionDays:     0,
		TombstoneRetentionDays: 0,
	}, nil)
	mockEntries.EXPECT().DeleteReadUnstarred(gomock.Any(), nil, nil).Return(int64(7), nil)

	count, err := svc.ClearEntryCache(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(7), count)
}

// 1123：非 0 保留期换算成 now-N 天的时间门槛传给仓库。
func TestEntryService_ClearEntryCache_ComputesCutoffs(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockSettings := servicemock.NewMockSettingsService(ctrl)
	svc := service.NewEntryService(mockEntries, mock.NewMockFeedRepository(ctrl), mock.NewMockFolderRepository(ctrl), nil).
		WithCacheSettings(mockSettings)

	mockSettings.EXPECT().GetCacheSettings(gomock.Any()).Return(&service.CacheSettings{
		EntryRetentionDays:     30,
		TombstoneRetentionDays: 180,
	}, nil)
	mockEntries.EXPECT().DeleteReadUnstarred(gomock.Any(), gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, entryBefore, tombstoneBefore *time.Time) (int64, error) {
			require.NotNil(t, entryBefore)
			require.NotNil(t, tombstoneBefore)
			require.WithinDuration(t, time.Now().AddDate(0, 0, -30), *entryBefore, time.Minute)
			require.WithinDuration(t, time.Now().AddDate(0, 0, -180), *tombstoneBefore, time.Minute)
			return int64(2), nil
		})

	count, err := svc.ClearEntryCache(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(2), count)
}

// 1123：设置读取失败不能拖垮清理 —— 回退默认 30/180，两个门槛都非 nil。
func TestEntryService_ClearEntryCache_SettingsErrorFallsBackToDefaults(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockSettings := servicemock.NewMockSettingsService(ctrl)
	svc := service.NewEntryService(mockEntries, mock.NewMockFeedRepository(ctrl), mock.NewMockFolderRepository(ctrl), nil).
		WithCacheSettings(mockSettings)

	mockSettings.EXPECT().GetCacheSettings(gomock.Any()).Return(nil, errors.New("settings read failed"))
	mockEntries.EXPECT().DeleteReadUnstarred(gomock.Any(), gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, entryBefore, tombstoneBefore *time.Time) (int64, error) {
			require.NotNil(t, entryBefore)
			require.NotNil(t, tombstoneBefore)
			return int64(1), nil
		})

	count, err := svc.ClearEntryCache(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(1), count)
}
