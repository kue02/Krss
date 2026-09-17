package handler_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"gist/backend/internal/handler"
	"gist/backend/internal/model"
	"gist/backend/internal/service/mock"
)

func TestEntryHandler_Search_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockEntryService(ctrl)
	h := handler.NewEntryHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/entries/search?q=steam&limit=20", nil)
	c, rec := newTestContext(e, req)

	title := "Steam 喜+1"
	mockService.EXPECT().
		Search(gomock.Any(), "steam", 20).
		Return([]model.Entry{{ID: 7, FeedID: 3, Title: &title}}, nil)

	err := h.Search(c)
	require.NoError(t, err)

	var resp handler.EntryListResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Len(t, resp.Entries, 1)
	require.Equal(t, "7", resp.Entries[0].ID)
}

// 不带关键词直接 400：否则会退化成「列出全部」
func TestEntryHandler_Search_MissingKeyword(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockEntryService(ctrl)
	h := handler.NewEntryHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/entries/search", nil)
	c, rec := newTestContext(e, req)

	err := h.Search(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// limit 越界时回落到默认 30（不是报错，也不是照单全收）
func TestEntryHandler_Search_ClampsLimit(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockEntryService(ctrl)
	h := handler.NewEntryHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/entries/search?q=x&limit=9999", nil)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		Search(gomock.Any(), "x", 30).
		Return([]model.Entry{}, nil)

	err := h.Search(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, rec.Code)
}
