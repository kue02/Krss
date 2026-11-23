package handler_test

import (
	"net/http"
	"testing"

	"krss/backend/internal/handler"
	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

// 200 返回体含 feeds，且 feedId 是字符串。
func TestEntryHandler_ViewMatchedFeeds_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockEntryService(ctrl)
	h := handler.NewEntryHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/views/12/matched-feeds", nil)
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"id": "12"})

	mockService.EXPECT().
		ListViewMatchedFeeds(gomock.Any(), int64(12), gomock.Any()).
		Return([]service.ViewMatchedFeed{
			{FeedID: 12, FeedTitle: "某订阅", Count: 3},
			{FeedID: 34, FeedTitle: "另一个订阅", Count: 1},
		}, nil)

	err := h.ViewMatchedFeeds(c)
	require.NoError(t, err)

	var resp handler.ViewMatchedFeedsResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Len(t, resp.Feeds, 2)
	// feedId 必须是字符串（能 unmarshal 进 string 字段即证明是字符串）
	require.Equal(t, "12", resp.Feeds[0].FeedID)
	require.Equal(t, "某订阅", resp.Feeds[0].FeedTitle)
	require.Equal(t, 3, resp.Feeds[0].Count)
	require.Equal(t, "34", resp.Feeds[1].FeedID)
	require.Equal(t, 1, resp.Feeds[1].Count)
}

// 非法 id → 400。
func TestEntryHandler_ViewMatchedFeeds_InvalidID(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockEntryService(ctrl)
	h := handler.NewEntryHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/views/abc/matched-feeds", nil)
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"id": "abc"})

	err := h.ViewMatchedFeeds(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// 非法 contentType → 400（不碰 service）。
func TestEntryHandler_ViewMatchedFeeds_InvalidContentType(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockEntryService(ctrl)
	h := handler.NewEntryHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/views/12/matched-feeds?contentType=bogus", nil)
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"id": "12"})

	err := h.ViewMatchedFeeds(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// service 返回 ErrNotFound → 404。
func TestEntryHandler_ViewMatchedFeeds_NotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockEntryService(ctrl)
	h := handler.NewEntryHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/views/99/matched-feeds", nil)
	c, rec := newTestContext(e, req)
	setPathParams(c, map[string]string{"id": "99"})

	mockService.EXPECT().
		ListViewMatchedFeeds(gomock.Any(), int64(99), gomock.Any()).
		Return(nil, service.ErrNotFound)

	err := h.ViewMatchedFeeds(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusNotFound, rec.Code)
}
