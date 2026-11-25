package service_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"krss/backend/internal/model"
	"krss/backend/internal/repository/mock"
	"krss/backend/internal/service"
	servicemock "krss/backend/internal/service/mock"
	"krss/backend/pkg/network"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

func TestRefreshService_RefreshAll_AlreadyRefreshing(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := service.NewRefreshService(
		mock.NewMockFeedRepository(ctrl),
		mock.NewMockEntryRepository(ctrl),
		nil,
		nil,
		network.NewClientFactoryForTest(&http.Client{}),
		nil,
		nil,
		nil,
	)
	service.SetRefreshServiceRefreshing(svc, true)

	err := svc.RefreshAll(context.Background())
	require.ErrorIs(t, err, service.ErrAlreadyRefreshing)
}

func TestRefreshService_RefreshAll_ListError(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockFeeds.EXPECT().List(gomock.Any(), (*int64)(nil)).Return(nil, errors.New("list failed"))

	svc := service.NewRefreshService(
		mockFeeds,
		mock.NewMockEntryRepository(ctrl),
		nil,
		nil,
		network.NewClientFactoryForTest(&http.Client{}),
		nil,
		nil,
		nil,
	)

	err := svc.RefreshAll(context.Background())
	require.Error(t, err)
	require.False(t, svc.IsRefreshing())
}

func TestRefreshService_RefreshFeed_NotModified(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feed := model.Feed{ID: 1, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(1)).Return(feed, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(1), nil).Return(nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(1)).Return(nil)

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
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

	err := svc.RefreshFeed(context.Background(), 1)
	require.NoError(t, err)
}

func TestRefreshService_RefreshFeed_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockIcons := servicemock.NewMockIconService(ctrl)

	feed := model.Feed{ID: 10, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(10)).Return(feed, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(10), nil).Return(nil)

	mockFeeds.EXPECT().Update(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, updated model.Feed) (model.Feed, error) {
			require.NotNil(t, updated.ETag)
			require.NotNil(t, updated.LastModified)
			return updated, nil
		},
	)
	mockFeeds.EXPECT().UpdateSiteURL(gomock.Any(), int64(10), "https://example.com").Return(nil)
	mockIcons.EXPECT().EnqueueIconFetch(int64(10), "https://example.com/icon.png", "https://example.com")

	mockEntries.EXPECT().GetExistingEntry(gomock.Any(), int64(10), hashString("https://example.com/1"), "https://example.com/1").Return(nil, nil)
	mockEntries.EXPECT().CreateOrUpdateSkippingTombstones(gomock.Any(), gomock.Any()).Return(true, nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(10)).Return(nil)

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			header := make(http.Header)
			header.Set("ETag", "etag-value")
			header.Set("Last-Modified", "Mon, 02 Jan 2006 15:04:05 GMT")
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(sampleRSS)),
				Header:     header,
				Request:    req,
			}, nil
		}),
	}

	svc := service.NewRefreshService(
		mockFeeds,
		mockEntries,
		nil,
		mockIcons,
		network.NewClientFactoryForTest(client),
		nil,
		nil,
		nil,
	)

	err := svc.RefreshFeed(context.Background(), 10)
	require.NoError(t, err)
}

// TestRefreshService_RefreshFeed_RechecksExistingIcon 已有通用图标也要每次刷新交给图标服务重判：
// 这是 GitHub 头像插件能把导入时固化的 github.com.ico 换成头像的关键。
func TestRefreshService_RefreshFeed_RechecksExistingIcon(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockIcons := servicemock.NewMockIconService(ctrl)

	oldIcon := "github.com.ico"
	feed := model.Feed{ID: 11, URL: "https://example.com/rss", Title: "Feed", IconPath: &oldIcon}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(11)).Return(feed, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(11), nil).Return(nil)
	mockFeeds.EXPECT().Update(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, updated model.Feed) (model.Feed, error) {
			return updated, nil
		},
	)
	mockFeeds.EXPECT().UpdateSiteURL(gomock.Any(), int64(11), "https://example.com").Return(nil)
	mockIcons.EXPECT().EnqueueIconFetch(int64(11), "https://example.com/icon.png", "https://example.com")

	mockEntries.EXPECT().GetExistingEntry(gomock.Any(), int64(11), hashString("https://example.com/1"), "https://example.com/1").Return(nil, nil)
	mockEntries.EXPECT().CreateOrUpdateSkippingTombstones(gomock.Any(), gomock.Any()).Return(true, nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(11)).Return(nil)

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			header := make(http.Header)
			header.Set("ETag", "etag-value")
			header.Set("Last-Modified", "Mon, 02 Jan 2006 15:04:05 GMT")
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(sampleRSS)),
				Header:     header,
				Request:    req,
			}, nil
		}),
	}
	svc := service.NewRefreshService(
		mockFeeds,
		mockEntries,
		nil,
		mockIcons,
		network.NewClientFactoryForTest(client),
		nil,
		nil,
		nil,
	)
	require.NoError(t, svc.RefreshFeed(context.Background(), 11))
}

func TestRefreshService_RefreshFeed_FallbackUserAgent(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feed := model.Feed{ID: 2, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(2)).Return(feed, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(2), nil).Return(nil)
	mockFeeds.EXPECT().UpdateSiteURL(gomock.Any(), int64(2), "https://example.com").Return(nil)

	settings := &settingsServiceStub{fallbackUserAgent: "UA-Test"}

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			if req.Header.Get("User-Agent") == settings.fallbackUserAgent {
				return &http.Response{
					StatusCode: http.StatusOK,
					Body:       io.NopCloser(strings.NewReader(sampleRSS)),
					Header:     make(http.Header),
					Request:    req,
				}, nil
			}
			return &http.Response{
				StatusCode: http.StatusBadRequest,
				Body:       http.NoBody,
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	mockEntries.EXPECT().GetExistingEntry(gomock.Any(), int64(2), hashString("https://example.com/1"), "https://example.com/1").Return(nil, nil)
	mockEntries.EXPECT().CreateOrUpdateSkippingTombstones(gomock.Any(), gomock.Any()).Return(true, nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(2)).Return(nil)

	svc := service.NewRefreshService(
		mockFeeds,
		mockEntries,
		settings,
		nil,
		network.NewClientFactoryForTest(client),
		nil,
		nil,
		nil,
	)

	err := svc.RefreshFeed(context.Background(), 2)
	require.NoError(t, err)
}

func TestRefreshService_RefreshFeeds_Empty(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	svc := service.NewRefreshService(
		mock.NewMockFeedRepository(ctrl),
		mock.NewMockEntryRepository(ctrl),
		nil,
		nil,
		network.NewClientFactoryForTest(&http.Client{}),
		nil,
		nil,
		nil,
	)

	err := svc.RefreshFeeds(context.Background(), nil)
	require.NoError(t, err)
}

func TestRefreshService_RefreshFeeds_GetByIDsError(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockFeeds.EXPECT().GetByIDs(gomock.Any(), []int64{1, 2}).Return(nil, errors.New("db error"))

	svc := service.NewRefreshService(
		mockFeeds,
		mock.NewMockEntryRepository(ctrl),
		nil,
		nil,
		network.NewClientFactoryForTest(&http.Client{}),
		nil,
		nil,
		nil,
	)

	err := svc.RefreshFeeds(context.Background(), []int64{1, 2})
	require.Error(t, err)
}

func TestRefreshService_RefreshFeed_SameGUIDDifferentURL_SecondRefreshCountsAsUpdate(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feed := model.Feed{ID: 20, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(20)).Return(feed, nil).Times(2)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(20), nil).Return(nil).Times(2)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(20)).Return(nil).Times(2)
	mockFeeds.EXPECT().UpdateSiteURL(gomock.Any(), int64(20), "https://example.com").Return(nil).Times(2)

	var call int
	const rssTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Test Feed</title>
<link>https://example.com</link>
<description>Desc</description>
<item>
  <title>Item 1</title>
  <guid>v2ex-guid-1</guid>
  <link>%s</link>
  <description>Content 1</description>
</item>
</channel>
</rss>`

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			call++
			link := "https://www.v2ex.com/t/1193191#reply10"
			if call == 2 {
				link = "https://www.v2ex.com/t/1193191#reply20"
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(fmt.Sprintf(rssTemplate, link))),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	seen := make(map[string]bool)
	mockEntries.EXPECT().GetExistingEntry(gomock.Any(), int64(20), hashString("v2ex-guid-1"), gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, hash string, rawURL string) (*model.Entry, error) {
			if !seen[hash] {
				return nil, nil
			}
			// 存量行还是第一次抓到的那个链接（reply10），第二轮链接变成 reply20 ⇒ 内容变了
			title := "Item 1"
			oldURL := "https://www.v2ex.com/t/1193191#reply10"
			content := "Content 1"
			return &model.Entry{Title: &title, URL: &oldURL, Content: &content}, nil
		},
	).Times(2)
	mockEntries.EXPECT().CreateOrUpdateSkippingTombstones(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, entry model.Entry) (bool, error) {
			seen[entry.Hash] = true
			return true, nil
		},
	).Times(2)

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

	err := svc.RefreshFeed(context.Background(), 20)
	require.NoError(t, err)
	results := svc.LastRefreshResults()
	require.Len(t, results, 1)
	require.Equal(t, 1, results[0].New)
	require.Equal(t, 0, results[0].Updated)

	err = svc.RefreshFeed(context.Background(), 20)
	require.NoError(t, err)
	// 第二轮链接从 reply10 变成 reply20 ⇒ 内容真变了，Update 照数
	results = svc.LastRefreshResults()
	require.Len(t, results, 1)
	require.Equal(t, 0, results[0].New)
	require.Equal(t, 1, results[0].Updated)
}

type rateLimitStub struct {
	interval time.Duration
}

func (r *rateLimitStub) GetInterval(ctx context.Context, host string) int {
	return int(r.interval.Seconds())
}

func hashString(input string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(input)))
	return hex.EncodeToString(sum[:])
}

func (r *rateLimitStub) GetIntervalDuration(ctx context.Context, host string) time.Duration {
	return r.interval
}

func (r *rateLimitStub) SetInterval(ctx context.Context, host string, seconds int) error {
	return nil
}

func (r *rateLimitStub) DeleteInterval(ctx context.Context, host string) error {
	return nil
}

func (r *rateLimitStub) List(ctx context.Context) ([]service.DomainRateLimitDTO, error) {
	return nil, nil
}

func TestRefreshService_RefreshFeeds_WithRateLimit(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feeds := []model.Feed{
		{ID: 1, URL: "https://example.com/rss", Title: "Feed 1"},
		{ID: 2, URL: "https://example.com/rss", Title: "Feed 2"},
	}

	mockFeeds.EXPECT().GetByIDs(gomock.Any(), []int64{1, 2}).Return(feeds, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(1), nil).Return(nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(2), nil).Return(nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(1)).Return(nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(2)).Return(nil)
	// 迁移 41：批量抓取后每个真正发起过抓取的源都会记录一次（304 = success 但无变化）
	mockFeeds.EXPECT().RecordFeedFetched(gomock.Any(), int64(1), gomock.Any(), true, false).Return(nil)
	mockFeeds.EXPECT().RecordFeedFetched(gomock.Any(), int64(2), gomock.Any(), true, false).Return(nil)

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
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
		&rateLimitStub{interval: 5 * time.Millisecond},
		nil,
	)

	err := svc.RefreshFeeds(context.Background(), []int64{1, 2})
	require.NoError(t, err)
}

func TestRefreshService_RefreshFeedWithFreshClient_HTTPError(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feed := model.Feed{ID: 5, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(5), gomock.Any()).DoAndReturn(
		func(_ context.Context, _ int64, msg *string) error {
			require.NotNil(t, msg)
			require.Equal(t, "HTTP 500", *msg)
			return nil
		},
	)
	mockFeeds.EXPECT().RecordRefreshFailure(gomock.Any(), int64(5), gomock.Any()).Return(nil)

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusInternalServerError,
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

	err := service.RefreshFeedWithFreshClientForTest(svc, context.Background(), feed, "UA-Test", "", 0)
	require.NoError(t, err)
}

// 用户 11-19：刷新图标右键「强制拉取」= 忽略 etag/last-modified 重新拿一份。
// 直接看请求头：普通刷新必须带条件头，强制拉取必须不带。
func TestRefreshService_ForceRefresh_SkipsConditionalHeaders(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	etag := `"abc"`
	lastModified := "Mon, 02 Jan 2006 15:04:05 GMT"
	feed := model.Feed{ID: 7, URL: "https://example.com/rss", Title: "Feed", ETag: &etag, LastModified: &lastModified}

	sawConditional := false
	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			if req.Header.Get("If-None-Match") != "" || req.Header.Get("If-Modified-Since") != "" {
				sawConditional = true
			}
			return &http.Response{
				StatusCode: http.StatusNotModified,
				Body:       http.NoBody,
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}

	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(7)).Return(feed, nil)
	mockFeeds.EXPECT().List(gomock.Any(), (*int64)(nil)).Return([]model.Feed{feed}, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(7), nil).Return(nil).AnyTimes()
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(7)).Return(nil).AnyTimes()
	// 迁移 41：强制全量刷新（auto=false）也会给真正抓过的源记录一次 last_fetched_at
	mockFeeds.EXPECT().RecordFeedFetched(gomock.Any(), int64(7), gomock.Any(), true, false).Return(nil)

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

	require.NoError(t, svc.RefreshFeed(context.Background(), 7))
	require.True(t, sawConditional, "普通刷新应该带 If-None-Match / If-Modified-Since")

	sawConditional = false
	require.NoError(t, svc.ForceRefreshAll(context.Background()))
	require.False(t, sawConditional, "强制拉取不该带条件头（否则又拿到 304）")
}

// 命中墓碑的条目：saveEntries 里 CreateOrUpdateSkippingTombstones 返回 false 时不应计入 newCount /
// 不回传 newEntries（否则刷新结果会显示「新增 1」、规则引擎还会对已删文章再跑一遍）。
func TestRefreshService_TombstonedEntryNotCountedAsNew(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	feed := model.Feed{ID: 41, URL: "https://example.com/rss", Title: "Feed"}
	mockFeeds.EXPECT().GetByID(gomock.Any(), int64(41)).Return(feed, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(41), nil).Return(nil)
	mockFeeds.EXPECT().Update(gomock.Any(), gomock.Any()).Return(feed, nil)
	mockFeeds.EXPECT().UpdateSiteURL(gomock.Any(), int64(41), "https://example.com").Return(nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(41)).Return(nil)

	mockEntries.EXPECT().GetExistingEntry(gomock.Any(), int64(41), gomock.Any(), gomock.Any()).Return(nil, nil)
	mockEntries.EXPECT().CreateOrUpdateSkippingTombstones(gomock.Any(), gomock.Any()).Return(false, nil)

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			header := make(http.Header)
			header.Set("ETag", "etag-value")
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(sampleRSS)),
				Header:     header,
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

	require.NoError(t, svc.RefreshFeed(context.Background(), 41))
	results := svc.LastRefreshResults()
	require.Len(t, results, 1)
	require.Equal(t, 0, results[0].New)
	require.Equal(t, 0, results[0].Updated)
}

// 迁移 41：定时刷新按「上次抓取时间 + 有效间隔」做到期门 —— 未到期跳过、到期才抓。
func TestRefreshService_RefreshAllAuto_IntervalGate(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)

	now := time.Now().UTC()
	fiveMinAgo := now.Add(-5 * time.Minute)
	twentyMinAgo := now.Add(-20 * time.Minute)
	fortyMinAgo := now.Add(-40 * time.Minute)

	feeds := []model.Feed{
		{ID: 101, URL: "https://never.example/rss", Title: "NeverFetched"},                                                    // nil → 到期
		{ID: 102, URL: "https://fresh.example/rss", Title: "Fresh", LastFetchedAt: &fiveMinAgo},                               // 15min 内 → 跳过
		{ID: 103, URL: "https://streak1.example/rss", Title: "Streak1", LastFetchedAt: &twentyMinAgo, NoChangeStreak: 1},      // 有效 30min，20min → 跳过
		{ID: 104, URL: "https://streak1old.example/rss", Title: "Streak1Old", LastFetchedAt: &fortyMinAgo, NoChangeStreak: 1}, // 有效 30min，40min → 到期
	}

	mockFeeds.EXPECT().List(gomock.Any(), (*int64)(nil)).Return(feeds, nil)
	// 只有到期的 101 / 104 会被真正抓取（304 = success 但无变化），并各自记录一次抓取。
	for _, id := range []int64{101, 104} {
		mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), id, nil).Return(nil)
		mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), id).Return(nil)
		mockFeeds.EXPECT().RecordFeedFetched(gomock.Any(), id, gomock.Any(), true, false).Return(nil)
	}

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusNotModified, Body: http.NoBody, Header: make(http.Header), Request: req}, nil
		}),
	}

	svc := service.NewRefreshService(mockFeeds, mockEntries, nil, nil, network.NewClientFactoryForTest(client), nil, nil, nil)
	require.NoError(t, svc.RefreshAllAuto(context.Background()))

	byID := map[int64]service.RefreshFeedResult{}
	for _, r := range svc.LastRefreshResults() {
		byID[r.FeedID] = r
	}
	require.Len(t, byID, 4)
	require.False(t, byID[101].Skipped)
	require.False(t, byID[104].Skipped)
	require.True(t, byID[102].Skipped)
	require.True(t, byID[103].Skipped)
}

// 迁移 41：RSS 自适应降频的绝对上限 24h —— streak=4 且全局 12h 时未封顶会是 192h，
// 真实有效间隔应为 24h，于是 30h 前抓过的源到期、20h 前抓过的源未到期。
func TestRefreshService_RefreshAllAuto_AdaptiveIntervalCap(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockSettings := servicemock.NewMockSettingsService(ctrl)
	mockSettings.EXPECT().GetFetchSettings(gomock.Any()).Return(&service.FetchSettings{IntervalMinutes: 720}, nil).AnyTimes()

	now := time.Now().UTC()
	thirtyHAgo := now.Add(-30 * time.Hour)
	twentyHAgo := now.Add(-20 * time.Hour)
	feeds := []model.Feed{
		{ID: 201, URL: "https://cap-due.example/rss", Title: "CappedDue", LastFetchedAt: &thirtyHAgo, NoChangeStreak: 4},
		{ID: 202, URL: "https://cap-skip.example/rss", Title: "CappedSkip", LastFetchedAt: &twentyHAgo, NoChangeStreak: 4},
	}
	mockFeeds.EXPECT().List(gomock.Any(), (*int64)(nil)).Return(feeds, nil)
	mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), int64(201), nil).Return(nil)
	mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), int64(201)).Return(nil)
	mockFeeds.EXPECT().RecordFeedFetched(gomock.Any(), int64(201), gomock.Any(), true, false).Return(nil)

	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusNotModified, Body: http.NoBody, Header: make(http.Header), Request: req}, nil
		}),
	}

	svc := service.NewRefreshService(mockFeeds, mockEntries, mockSettings, nil, network.NewClientFactoryForTest(client), nil, nil, nil)
	require.NoError(t, svc.RefreshAllAuto(context.Background()))

	byID := map[int64]service.RefreshFeedResult{}
	for _, r := range svc.LastRefreshResults() {
		byID[r.FeedID] = r
	}
	require.False(t, byID[201].Skipped)
	require.True(t, byID[202].Skipped)
}

// 迁移 41 + #1：MCP 订阅的到期判断用连接配置的刷新间隔，未配置时回落全局间隔。
func TestRefreshService_RefreshAllAuto_MCPUsesConnectionInterval(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockFeeds := mock.NewMockFeedRepository(ctrl)
	mockEntries := mock.NewMockEntryRepository(ctrl)
	mockMCP := servicemock.NewMockMCPService(ctrl)

	now := time.Now().UTC()
	twentyMinAgo := now.Add(-20 * time.Minute)
	fiftyMinAgo := now.Add(-50 * time.Minute)

	feeds := []model.Feed{
		{ID: 301, URL: "mcp://a", Title: "ConnIntervalNotDue", SourceType: model.FeedSourceMCP, LastFetchedAt: &twentyMinAgo},
		{ID: 302, URL: "mcp://b", Title: "ConnIntervalDue", SourceType: model.FeedSourceMCP, LastFetchedAt: &fiftyMinAgo},
		{ID: 303, URL: "mcp://c", Title: "NoConnIntervalDue", SourceType: model.FeedSourceMCP, LastFetchedAt: &twentyMinAgo},
	}
	mockFeeds.EXPECT().List(gomock.Any(), (*int64)(nil)).Return(feeds, nil)

	// 301/302 连接间隔 45min；303 未配置（回落全局 15min）。
	mockMCP.EXPECT().FeedRefreshInterval(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, f model.Feed) (time.Duration, bool) {
			switch f.ID {
			case 301, 302:
				return 45 * time.Minute, true
			default:
				return 0, false
			}
		}).Times(3)

	// 只有 302（50min>=45min）与 303（20min>=15min）会真正抓；301（20min<45min）跳过。
	mockMCP.EXPECT().FetchFeedItems(gomock.Any(), gomock.Any()).DoAndReturn(
		func(_ context.Context, f model.Feed) (service.MCPFetchResult, error) {
			require.NotEqual(t, int64(301), f.ID, "301 未到期，不该被抓取")
			return service.MCPFetchResult{}, nil
		}).Times(2)

	for _, id := range []int64{302, 303} {
		mockFeeds.EXPECT().UpdateErrorMessage(gomock.Any(), id, nil).Return(nil)
		mockFeeds.EXPECT().ResetRefreshFailure(gomock.Any(), id).Return(nil)
		mockFeeds.EXPECT().RecordFeedFetched(gomock.Any(), id, gomock.Any(), true, false).Return(nil)
	}

	svc := service.NewRefreshService(mockFeeds, mockEntries, nil, nil, network.NewClientFactoryForTest(&http.Client{}), nil, nil, nil, mockMCP)
	require.NoError(t, svc.RefreshAllAuto(context.Background()))

	byID := map[int64]service.RefreshFeedResult{}
	for _, r := range svc.LastRefreshResults() {
		byID[r.FeedID] = r
	}
	require.True(t, byID[301].Skipped)
	require.False(t, byID[302].Skipped)
	require.False(t, byID[303].Skipped)
}
