package service_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"gist/backend/internal/model"
	"gist/backend/internal/repository/mock"
	"gist/backend/internal/service"
	"gist/backend/pkg/network"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

func strptr(s string) *string { return &s }

// 22-4：「更新」只数内容真变了的 —— 同一份 RSS 刷两遍，第二遍 updated 必须是 0。
func TestRefreshService_SecondRefreshUnchangedCountsZeroUpdate(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feed := model.Feed{ID: 30, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(30)).Return(feed, nil).Times(2)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(30), nil).Return(nil).Times(2)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(30)).Return(nil).Times(2)
	mockFeeds.EXPECT().UpdateSiteURL(gomock.Any(), int64(30), "https://example.com").Return(nil).Times(2)

	stored := &model.Entry{
		Title:   strptr("Item 1"),
		URL:     strptr("https://example.com/1"),
		Content: strptr("Content 1"),
	}
	mockEntries.EXPECT().GetExistingEntry(gomock.Any(), int64(30), gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, _ string, _ string) (*model.Entry, error) {
			return nil, nil
		},
	).Times(1)
	mockEntries.EXPECT().GetExistingEntry(gomock.Any(), int64(30), gomock.Any(), gomock.Any()).Return(stored, nil).Times(1)
	mockEntries.EXPECT().CreateOrUpdate(gomock.Any(), gomock.Any()).Return(nil).Times(2)

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(sampleRSS)),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	svc := service.NewRefreshService(
		mockFeeds,
		mockEntries,
		nil,
		nil,
		network.NewClientFactoryForTest(client),
		nil,
		nil,
		nil,
	)

	require.NoError(t, svc.RefreshFeed(context.Background(), 30))
	results := svc.LastRefreshResults()
	require.Len(t, results, 1)
	require.Equal(t, 1, results[0].New)
	require.Equal(t, 0, results[0].Updated)

	require.NoError(t, svc.RefreshFeed(context.Background(), 30))
	results = svc.LastRefreshResults()
	require.Len(t, results, 1)
	require.Equal(t, 0, results[0].New)
	require.Equal(t, 0, results[0].Updated, "内容没变就不该数更新")
}

// 22-4：标题真变了才数更新。
func TestRefreshService_ChangedTitleCountsAsUpdate(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feed := model.Feed{ID: 31, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(31)).Return(feed, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(31), nil).Return(nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(31)).Return(nil)
	mockFeeds.EXPECT().UpdateSiteURL(gomock.Any(), int64(31), "https://example.com").Return(nil)

	stored := &model.Entry{
		Title:   strptr("Item 1 （旧标题）"),
		URL:     strptr("https://example.com/1"),
		Content: strptr("Content 1"),
	}
	mockEntries.EXPECT().GetExistingEntry(gomock.Any(), int64(31), gomock.Any(), gomock.Any()).Return(stored, nil)
	mockEntries.EXPECT().CreateOrUpdate(gomock.Any(), gomock.Any()).Return(nil)

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(sampleRSS)),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	svc := service.NewRefreshService(
		mockFeeds,
		mockEntries,
		nil,
		nil,
		network.NewClientFactoryForTest(client),
		nil,
		nil,
		nil,
	)

	require.NoError(t, svc.RefreshFeed(context.Background(), 31))
	results := svc.LastRefreshResults()
	require.Len(t, results, 1)
	require.Equal(t, 0, results[0].New)
	require.Equal(t, 1, results[0].Updated)
}

// 22-4：连着断两次、第三次好 ⇒ 照样成功，且不记连续失败。
func TestRefreshService_FetchRetryThenSuccess(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feed := model.Feed{ID: 32, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(32)).Return(feed, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(32), nil).Return(nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(32)).Return(nil)
	mockFeeds.EXPECT().UpdateSiteURL(gomock.Any(), int64(32), "https://example.com").Return(nil)
	mockEntries.EXPECT().GetExistingEntry(gomock.Any(), int64(32), gomock.Any(), gomock.Any()).Return(nil, nil)
	mockEntries.EXPECT().CreateOrUpdate(gomock.Any(), gomock.Any()).Return(nil)

	var calls int
	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			calls++
			if calls < 3 {
				return nil, errors.New("connection reset by peer")
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(sampleRSS)),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	svc := service.NewRefreshService(
		mockFeeds,
		mockEntries,
		nil,
		nil,
		network.NewClientFactoryForTest(client),
		nil,
		nil,
		nil,
	)

	require.NoError(t, svc.RefreshFeed(context.Background(), 32))
	require.Equal(t, 3, calls)
	results := svc.LastRefreshResults()
	require.Len(t, results, 1)
	require.Equal(t, 1, results[0].New)
	require.Empty(t, results[0].Error)
}

// 22-4：三次全断 ⇒ 报错 + 记一次连续失败（只记一次，不是一次尝试记一次）。
func TestRefreshService_FetchRetryExhaustedRecordsFailure(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feed := model.Feed{ID: 33, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(33)).Return(feed, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(33), gomock.Any()).Return(nil)
	mockFeeds.EXPECT().RecordRefreshFailure(gomock.Any(), int64(33), gomock.Any()).Return(nil).Times(1)

	var calls int
	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			calls++
			return nil, errors.New("connection reset by peer")
		}),
	}

	svc := service.NewRefreshService(
		mockFeeds,
		mockEntries,
		nil,
		nil,
		network.NewClientFactoryForTest(client),
		nil,
		nil,
		nil,
	)

	require.Error(t, svc.RefreshFeed(context.Background(), 33))
	require.Equal(t, 3, calls, "同一轮里最多试 3 次")
}

// 22-4：5xx 也重试（对端过载是常态）；三次 503 ⇒ 失败 + 记连败。
func TestRefreshService_FetchRetryOnServerError(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feed := model.Feed{ID: 34, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(34)).Return(feed, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(34), gomock.Any()).Return(nil)
	mockFeeds.EXPECT().RecordRefreshFailure(gomock.Any(), int64(34), gomock.Any()).Return(nil).Times(1)

	var calls int
	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			calls++
			return &http.Response{
				StatusCode: http.StatusServiceUnavailable,
				Body:       http.NoBody,
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	svc := service.NewRefreshService(
		mockFeeds,
		mockEntries,
		nil,
		nil,
		network.NewClientFactoryForTest(client),
		nil,
		nil,
		nil,
	)

	require.Error(t, svc.RefreshFeed(context.Background(), 34))
	require.Equal(t, 3, calls)
}

// 22-4：定时刷新跳过退避中的源（手动不跳 —— 由 RefreshFeed 本身不调退避保证）。
func TestRefreshService_RefreshAllAuto_SkipsBackedOffFeed(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	lastFail := time.Now().UTC()
	good := model.Feed{ID: 40, URL: "https://good.example/rss", Title: "Good"}
	bad := model.Feed{
		ID: 41, URL: "https://bad.example/rss", Title: "Bad",
		RefreshFailCount: 5, RefreshLastFailAt: &lastFail,
	}
	mockFeeds.EXPECT().List(gomock.Any(), (*int64)(nil)).Return([]model.Feed{good, bad}, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(40), nil).Return(nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(40)).Return(nil)

	var calls int
	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			calls++
			require.NotContains(t, req.URL.Host, "bad.example", "退避中的源这轮不该被抓")
			return &http.Response{
				StatusCode: http.StatusNotModified,
				Body:       http.NoBody,
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	svc := service.NewRefreshService(
		mockFeeds,
		mockEntries,
		nil,
		nil,
		network.NewClientFactoryForTest(client),
		nil,
		nil,
		nil,
	)

	require.NoError(t, svc.RefreshAllAuto(context.Background()))
	require.Equal(t, 1, calls)
	results := svc.LastRefreshResults()
	require.Len(t, results, 2)
	byID := map[int64]service.RefreshFeedResult{}
	for _, r := range results {
		byID[r.FeedID] = r
	}
	require.True(t, byID[41].Skipped)
	require.False(t, byID[40].Skipped)
	require.Empty(t, byID[41].Error, "跳过不是失败，不该有 error")
}

// 退避时长表：5min 起翻倍，6h 封顶。
func TestRefreshService_BackoffDurations(t *testing.T) {
	require.Equal(t, time.Duration(0), service.BackoffForFailCountForTest(0))
	require.Equal(t, 5*time.Minute, service.BackoffForFailCountForTest(1))
	require.Equal(t, 10*time.Minute, service.BackoffForFailCountForTest(2))
	require.Equal(t, 20*time.Minute, service.BackoffForFailCountForTest(3))
	require.Equal(t, 6*time.Hour, service.BackoffForFailCountForTest(10))
	require.Equal(t, 6*time.Hour, service.BackoffForFailCountForTest(100))
}
