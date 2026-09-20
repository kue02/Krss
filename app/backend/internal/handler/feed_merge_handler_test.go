package handler_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"krss/backend/internal/handler"
	"krss/backend/internal/model"
	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"
)

// 用户场景（第十批 10-4）：RSSHub 换实例后两个订阅撞成同一地址 → 409 + 告诉前端撞的是谁，
// 前端据此弹「确认合并」。
func TestFeedHandler_UpdateURL_ConflictReturns409(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFeedService(ctrl)
	h := handler.NewFeedHandlerHelper(mockService, mock.NewMockRefreshService(ctrl))
	e := newTestEcho()

	newURL := "https://new.app/telegram/channel/x"
	req := newJSONRequest(http.MethodPatch, "/feeds/1/url", map[string]interface{}{"url": newURL})
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"id": "1"})

	conflictFeed := model.Feed{ID: 77, Title: "Newlearner（新实例）", URL: newURL}
	mockService.EXPECT().
		UpdateURL(gomock.Any(), int64(1), newURL).
		Return(model.Feed{}, &service.FeedURLConflictError{Feed: conflictFeed})

	require.NoError(t, h.UpdateURL(c))
	require.Equal(t, http.StatusConflict, rec.Code)

	var body struct {
		Error    string `json:"error"`
		Conflict struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"conflict"`
	}
	assertJSONResponse(t, rec, http.StatusConflict, &body)
	require.Equal(t, "feed url already exists", body.Error)
	require.Equal(t, "77", body.Conflict.ID)
	require.Equal(t, "Newlearner（新实例）", body.Conflict.Title)
}

// 合并预览：弹框要显示两边各有几条
func TestFeedHandler_MergePreview(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFeedService(ctrl)
	h := handler.NewFeedHandlerHelper(mockService, mock.NewMockRefreshService(ctrl))
	e := newTestEcho()

	req := newJSONRequest(http.MethodGet, "/feeds/merge-preview?sourceId=1&url=https%3A%2F%2Fnew.app%2Fx", nil)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		MergePreview(gomock.Any(), int64(1), "https://new.app/x").
		Return(service.FeedMergePreview{
			Source: service.FeedMergeSide{ID: 1, Title: "旧链接", Entries: 12, Starred: 3},
			Target: &service.FeedMergeSide{ID: 2, Title: "新链接", Entries: 40, Starred: 5},
		}, nil)

	require.NoError(t, h.MergePreview(c))
	require.Equal(t, http.StatusOK, rec.Code)

	var body struct {
		Source struct {
			ID      string `json:"id"`
			Title   string `json:"title"`
			Entries int64  `json:"entries"`
			Starred int64  `json:"starred"`
		} `json:"source"`
		Target *struct {
			ID      string `json:"id"`
			Entries int64  `json:"entries"`
		} `json:"target"`
	}
	parseJSONResponse(t, rec, &body)
	require.Equal(t, "1", body.Source.ID)
	require.EqualValues(t, 12, body.Source.Entries)
	require.NotNil(t, body.Target)
	require.Equal(t, "2", body.Target.ID)
	require.EqualValues(t, 40, body.Target.Entries)
}

// 合并：把来源并进目标并返回搬了多少条
func TestFeedHandler_MergeInto(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFeedService(ctrl)
	h := handler.NewFeedHandlerHelper(mockService, mock.NewMockRefreshService(ctrl))
	e := newTestEcho()

	req := newJSONRequest(http.MethodPost, "/feeds/1/merge", map[string]interface{}{"targetId": "2"})
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"id": "1"})

	mockService.EXPECT().
		MergeInto(gomock.Any(), int64(1), int64(2)).
		Return(service.FeedMergeResult{TargetID: 2, MovedEntries: 9, DedupedEntries: 2}, nil)

	require.NoError(t, h.MergeInto(c))
	require.Equal(t, http.StatusOK, rec.Code)

	var body struct {
		TargetID       string `json:"targetId"`
		MovedEntries   int64  `json:"movedEntries"`
		DedupedEntries int64  `json:"dedupedEntries"`
	}
	assertJSONResponse(t, rec, http.StatusOK, &body)
	require.Equal(t, "2", body.TargetID)
	require.EqualValues(t, 9, body.MovedEntries)
	require.EqualValues(t, 2, body.DedupedEntries)
}

// 参数坏掉不能 500
func TestFeedHandler_MergePreview_BadID(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFeedService(ctrl)
	h := handler.NewFeedHandlerHelper(mockService, mock.NewMockRefreshService(ctrl))
	e := newTestEcho()

	req := newJSONRequest(http.MethodGet, "/feeds/merge-preview?sourceId=abc", nil)
	c, rec := newTestContext(e, req)

	require.NoError(t, h.MergePreview(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}
