package service_test

import (
	"testing"
	"time"

	"github.com/mmcdole/gofeed"
	"github.com/mmcdole/gofeed/extensions"
	"github.com/stretchr/testify/require"

	"krss/backend/internal/service"
)

// 添加订阅时的「试看」条目：只取前几条、字段要够渲染该视图
func TestBuildPreviewEntries_EmptyFeed(t *testing.T) {
	require.Nil(t, service.BuildPreviewEntries(nil))
	require.Nil(t, service.BuildPreviewEntries([]*gofeed.Item{}))
}

func TestBuildPreviewEntries_LimitsToFour(t *testing.T) {
	items := make([]*gofeed.Item, 0, 10)
	for i := 0; i < 10; i++ {
		items = append(items, &gofeed.Item{Title: "post", Link: "https://example.com/p"})
	}

	entries := service.BuildPreviewEntries(items)
	require.Len(t, entries, 4)
}

func TestBuildPreviewEntries_MapsFields(t *testing.T) {
	published := time.Date(2026, 9, 16, 9, 0, 0, 0, time.UTC)
	items := []*gofeed.Item{
		{
			Title:           " 标题 ",
			Link:            " https://example.com/post ",
			Description:     "<p>正文</p>",
			Author:          &gofeed.Person{Name: "作者"},
			PublishedParsed: &published,
			Extensions: ext.Extensions{
				"media": {
					"thumbnail": []ext.Extension{{Attrs: map[string]string{"url": "https://example.com/t.png"}}},
				},
			},
		},
	}

	entries := service.BuildPreviewEntries(items)
	require.Len(t, entries, 1)

	entry := entries[0]
	require.NotNil(t, entry.Title)
	require.Equal(t, "标题", *entry.Title)
	require.NotNil(t, entry.URL)
	require.Equal(t, "https://example.com/post", *entry.URL)
	require.NotNil(t, entry.Content)
	require.Equal(t, "<p>正文</p>", *entry.Content)
	require.NotNil(t, entry.Author)
	require.Equal(t, "作者", *entry.Author)
	require.NotNil(t, entry.ThumbnailURL)
	require.Equal(t, "https://example.com/t.png", *entry.ThumbnailURL)
	require.NotNil(t, entry.PublishedAt)
	require.Equal(t, published, *entry.PublishedAt)
	// 预览条目不落库，feedID 保持 0
	require.EqualValues(t, 0, entry.FeedID)
}

func TestBuildPreviewEntries_KeepsFeedOrder(t *testing.T) {
	items := []*gofeed.Item{
		{Title: "第一条", GUID: "1"},
		{Title: "第二条", GUID: "2"},
	}

	entries := service.BuildPreviewEntries(items)
	require.Len(t, entries, 2)
	require.Equal(t, "第一条", *entries[0].Title)
	require.Equal(t, "第二条", *entries[1].Title)
}
