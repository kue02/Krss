package handler_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"gist/backend/internal/handler"
	"gist/backend/internal/model"
	"gist/backend/internal/service"
)

func strPtr(v string) *string { return &v }

func TestTruncatePreviewContent(t *testing.T) {
	require.Nil(t, handler.TruncatePreviewContent(nil))

	short := "短正文"
	require.Equal(t, short, *handler.TruncatePreviewContent(&short))

	long := strings.Repeat("字", 2500)
	got := handler.TruncatePreviewContent(&long)
	require.NotNil(t, got)
	require.Equal(t, 2000, len([]rune(*got)))
}

// 试看条目要按前端消费的 JSON 字段输出
func TestToFeedPreviewResponse_IncludesPreviewEntries(t *testing.T) {
	preview := service.FeedPreview{
		URL:   "https://example.com/feed.xml",
		Title: "示例源",
		Entries: []model.Entry{
			{
				Title:        strPtr("标题"),
				URL:          strPtr("https://example.com/post"),
				Content:      strPtr("<p>正文</p>"),
				ThumbnailURL: strPtr("https://example.com/t.png"),
				Author:       strPtr("作者"),
			},
		},
	}

	raw, err := json.Marshal(handler.ToFeedPreviewResponse(preview))
	require.NoError(t, err)

	var decoded struct {
		URL     string `json:"url"`
		Title   string `json:"title"`
		Entries []struct {
			Title        string `json:"title"`
			URL          string `json:"url"`
			Content      string `json:"content"`
			ThumbnailURL string `json:"thumbnailUrl"`
			Author       string `json:"author"`
			PublishedAt  string `json:"publishedAt"`
		} `json:"entries"`
	}
	require.NoError(t, json.Unmarshal(raw, &decoded))

	require.Equal(t, "https://example.com/feed.xml", decoded.URL)
	require.Len(t, decoded.Entries, 1)
	require.Equal(t, "标题", decoded.Entries[0].Title)
	require.Equal(t, "https://example.com/post", decoded.Entries[0].URL)
	require.Equal(t, "<p>正文</p>", decoded.Entries[0].Content)
	require.Equal(t, "https://example.com/t.png", decoded.Entries[0].ThumbnailURL)
	require.Equal(t, "作者", decoded.Entries[0].Author)
}

func TestToFeedPreviewResponse_NoEntriesKeyWhenEmpty(t *testing.T) {
	raw, err := json.Marshal(handler.ToFeedPreviewResponse(service.FeedPreview{URL: "https://example.com/feed.xml"}))
	require.NoError(t, err)
	require.NotContains(t, string(raw), "\"entries\"")
}
