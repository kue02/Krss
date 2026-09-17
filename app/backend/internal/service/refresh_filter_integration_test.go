package service_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"gist/backend/internal/model"
	"gist/backend/internal/repository"
	"gist/backend/internal/service"
	"gist/backend/pkg/network"

	"github.com/stretchr/testify/require"
)

// seedFeedWithURL 建一个订阅并把 URL 改成测试要抓的地址（RefreshFeed 从库里读 URL）。
func seedFeedWithURL(t *testing.T, fixture *filterFixture, title string, url string) model.Feed {
	t.Helper()
	feed := fixture.seedFeed(t, title, "article")
	_, err := fixture.db.ExecContext(context.Background(), `UPDATE feeds SET url = ? WHERE id = ?`, url, feed.ID)
	require.NoError(t, err)
	feed.URL = url
	return feed
}

func newRefreshFixture(t *testing.T) (*filterFixture, service.RefreshService) {
	t.Helper()
	fixture := newFilterFixture(t)
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
		fixture.feeds,
		fixture.entries,
		nil,
		nil,
		network.NewClientFactoryForTest(client),
		nil,
		nil,
		fixture.service,
	)
	return fixture, svc
}

// 抓取入库之后规则才跑：新条目按规则写标记，计数与审计都落库。
func TestRefreshService_AppliesFiltersAfterSave(t *testing.T) {
	fixture, refresh := newRefreshFixture(t)
	ctx := context.Background()

	feed := seedFeedWithURL(t, fixture, "Test Feed", "https://example.com/rss")

	_, err := fixture.service.Create(ctx, service.FilterWriteParams{
		Name:       "静音 Item",
		ScopeType:  model.FilterScopeAll,
		Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "Item"}},
		Actions:    model.FilterActions{Mute: true},
	})
	require.NoError(t, err)

	require.NoError(t, refresh.RefreshFeed(ctx, feed.ID))

	entries, err := fixture.entries.List(ctx, repository.EntryListFilter{FeedID: &feed.ID, Limit: 10, IncludeMuted: true})
	require.NoError(t, err)
	require.Len(t, entries, 1, "sampleRSS 只有一条带链接的条目")
	require.True(t, entries[0].Muted)
	require.True(t, entries[0].Read, "静音 = 入库 + 已读 + 隐藏")

	// 默认列表看不到它
	visible, err := fixture.entries.List(ctx, repository.EntryListFilter{FeedID: &feed.ID, Limit: 10})
	require.NoError(t, err)
	require.Empty(t, visible)
}

// 只对「刚入库的新条目」生效：第二次刷新时不会回头追改老条目。
func TestRefreshService_DoesNotRetroApplyToExistingEntries(t *testing.T) {
	fixture, refresh := newRefreshFixture(t)
	ctx := context.Background()

	feed := seedFeedWithURL(t, fixture, "Test Feed", "https://example.com/rss")

	// 第一次刷新：还没有任何规则
	require.NoError(t, refresh.RefreshFeed(ctx, feed.ID))

	// 之后再建规则（默认只作用于新条目）
	_, err := fixture.service.Create(ctx, service.FilterWriteParams{
		Name:      "全部静音",
		ScopeType: model.FilterScopeAll,
		Actions:   model.FilterActions{Mute: true},
	})
	require.NoError(t, err)

	// 第二次刷新：同一条条目已存在，走更新分支，不应被追改
	require.NoError(t, refresh.RefreshFeed(ctx, feed.ID))

	entries, err := fixture.entries.List(ctx, repository.EntryListFilter{FeedID: &feed.ID, Limit: 10, IncludeMuted: true})
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.False(t, entries[0].Muted, "老条目要等用户手动回溯，不该被刷新顺手改掉")
	require.False(t, entries[0].Read)
}
