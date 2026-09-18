package handler_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"gist/backend/internal/handler"
	"gist/backend/internal/model"
	"gist/backend/internal/service"
	"gist/backend/internal/service/mock"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

func filterWriteBody() map[string]interface{} {
	return map[string]interface{}{
		"name":      "屏蔽推广",
		"scopeType": "feed",
		"scopeId":   "42",
		"conditions": []map[string]interface{}{
			{"field": "title", "operator": "regex", "value": `(?i)\b(sponsored|推广)\b`},
		},
		"actions": map[string]interface{}{"mute": true, "markRead": true},
	}
}

func TestFilterHandler_List_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	scopeID := int64(42)
	mockService.EXPECT().List(gomock.Any()).Return([]model.Filter{
		{
			ID:         100,
			Name:       "屏蔽推广",
			Enabled:    true,
			Position:   0,
			ScopeType:  model.FilterScopeFeed,
			ScopeID:    &scopeID,
			Conditions: []model.FilterCondition{{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "推广"}},
			Actions:    model.FilterActions{Mute: true},
			MatchCount: 7,
		},
	}, nil)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodGet, "/filters", nil))

	require.NoError(t, h.List(c))

	var resp handler.FilterListResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Len(t, resp.Filters, 1)
	require.Equal(t, "100", resp.Filters[0].ID, "snowflake ID 以字符串下发")
	require.Equal(t, "42", *resp.Filters[0].ScopeID)
	require.True(t, resp.Filters[0].Actions.Mute)
	require.EqualValues(t, 7, resp.Filters[0].MatchCount)
}

func TestFilterHandler_Create_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().
		Create(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, params service.FilterWriteParams) (model.Filter, error) {
			require.Equal(t, "屏蔽推广", params.Name)
			require.Equal(t, model.FilterScopeFeed, params.ScopeType)
			require.NotNil(t, params.ScopeID)
			require.EqualValues(t, 42, *params.ScopeID)
			require.Len(t, params.Conditions, 1)
			require.True(t, params.Actions.Mute)
			require.True(t, params.Actions.MarkRead)
			return model.Filter{ID: 5, Name: params.Name, Enabled: true, ScopeType: params.ScopeType, ScopeID: params.ScopeID}, nil
		})

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/filters", filterWriteBody()))

	require.NoError(t, h.Create(c))

	var resp handler.FilterResponse
	assertJSONResponse(t, rec, http.StatusCreated, &resp)
	require.Equal(t, "5", resp.ID)
}

func TestFilterHandler_Create_InvalidFilter(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().
		Create(gomock.Any(), gomock.Any()).
		Return(model.Filter{}, service.ErrInvalidFilter)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/filters", filterWriteBody()))

	require.NoError(t, h.Create(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestFilterHandler_Create_InvalidScopeID(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	body := filterWriteBody()
	body["scopeId"] = "not-a-number"

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/filters", body))

	require.NoError(t, h.Create(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestFilterHandler_Update_NotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().
		Update(gomock.Any(), int64(9), gomock.Any()).
		Return(model.Filter{}, service.ErrFilterNotFound)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPatch, "/filters/9", filterWriteBody()))
	setPathParams(c, map[string]string{"id": "9"})

	require.NoError(t, h.Update(c))
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestFilterHandler_Delete_WithRevert(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().Delete(gomock.Any(), int64(9), true).Return(int64(3), nil)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodDelete, "/filters/9?revert=true", nil))
	setPathParams(c, map[string]string{"id": "9"})

	require.NoError(t, h.Delete(c))

	var resp handler.FilterRevertResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.EqualValues(t, 3, resp.Reverted)
}

func TestFilterHandler_Revert_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().RevertSelected(gomock.Any(), int64(9), gomock.Any(), false).Return(int64(12), nil)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/filters/9/revert", nil))
	setPathParams(c, map[string]string{"id": "9"})

	require.NoError(t, h.Revert(c))

	var resp handler.FilterRevertResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.EqualValues(t, 12, resp.Reverted)
}

func TestFilterHandler_Preview_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().
		Preview(gomock.Any(), gomock.Any(), 200).
		Return(service.FilterPreviewResult{
			Scanned:       120,
			MatchedCount:  2,
			MuteCount:     2,
			MarkReadCount: 1,
			Matched: []service.FilterPreviewItem{
				{ID: 77, Title: "赞助商投稿", FeedTitle: "Solidot", Actions: model.FilterActions{Mute: true}},
			},
		}, nil)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/filters/preview", filterWriteBody()))

	require.NoError(t, h.Preview(c))

	var resp handler.FilterPreviewResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.EqualValues(t, 120, resp.Scanned)
	require.Equal(t, 2, resp.MatchedCount)
	require.Equal(t, 2, resp.MuteCount)
	require.Len(t, resp.Matched, 1)
	require.Equal(t, "77", resp.Matched[0].ID)
	require.True(t, resp.Matched[0].Actions.Mute)
}

func TestFilterHandler_Preview_InvalidFilter(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().
		Preview(gomock.Any(), gomock.Any(), 50).
		Return(service.FilterPreviewResult{}, service.ErrInvalidFilter)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/filters/preview?limit=50", filterWriteBody()))

	require.NoError(t, h.Preview(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestFilterHandler_ListMatches_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().
		ListMatches(gomock.Any(), int64(9), 50).
		Return([]model.FilterMatch{
			{
				ID:         1,
				FilterID:   9,
				EntryID:    77,
				EntryTitle: "赞助商投稿",
				FeedTitle:  "Solidot",
				Actions:    model.FilterActions{Mute: true},
			},
		}, nil)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodGet, "/filters/9/matches", nil))
	setPathParams(c, map[string]string{"id": "9"})

	require.NoError(t, h.ListMatches(c))

	var resp handler.FilterMatchesResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Len(t, resp.Matches, 1)
	require.Equal(t, "77", resp.Matches[0].EntryID)
	require.Equal(t, "9", resp.Matches[0].FilterID)
	// 命中日志要给人看：带上条目标题与来源名
	require.Equal(t, "赞助商投稿", resp.Matches[0].EntryTitle)
	require.Equal(t, "Solidot", resp.Matches[0].FeedTitle)
}

func TestFilterHandler_ApplyToHistory_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().
		ApplyToHistory(gomock.Any(), int64(9), 300).
		Return(120, 7, nil)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/filters/9/apply?limit=300", nil))
	setPathParams(c, map[string]string{"id": "9"})

	require.NoError(t, h.ApplyToHistory(c))

	var resp struct {
		Scanned int `json:"scanned"`
		Applied int `json:"applied"`
	}
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Equal(t, 120, resp.Scanned)
	require.Equal(t, 7, resp.Applied)
}

func TestFilterHandler_ApplyToHistory_NotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().
		ApplyToHistory(gomock.Any(), int64(9), 500).
		Return(0, 0, service.ErrFilterNotFound)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/filters/9/apply", nil))
	setPathParams(c, map[string]string{"id": "9"})

	require.NoError(t, h.ApplyToHistory(c))
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestFilterHandler_InternalError(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandlerHelper(mockService)

	mockService.EXPECT().List(gomock.Any()).Return(nil, errors.New("db down"))

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodGet, "/filters", nil))

	require.NoError(t, h.List(c))
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}
