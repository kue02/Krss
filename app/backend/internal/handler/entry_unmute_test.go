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

func TestEntryHandler_Unmute_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockEntryService(ctrl)
	h := handler.NewEntryHandler(mockService, nil)

	mockService.EXPECT().Unmute(gomock.Any(), int64(7)).Return(nil)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/entries/7/unmute", nil))
	setPathParams(c, map[string]string{"id": "7"})

	require.NoError(t, h.Unmute(c))
	require.Equal(t, http.StatusNoContent, rec.Code)
}

func TestEntryHandler_Unmute_InvalidID(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockEntryService(ctrl)
	h := handler.NewEntryHandler(mockService, nil)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/entries/abc/unmute", nil))
	setPathParams(c, map[string]string{"id": "abc"})

	require.NoError(t, h.Unmute(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestEntryHandler_Unmute_NotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockEntryService(ctrl)
	h := handler.NewEntryHandler(mockService, nil)

	mockService.EXPECT().Unmute(gomock.Any(), int64(9)).Return(service.ErrNotFound)

	e := newTestEcho()
	c, rec := newTestContext(e, newJSONRequest(http.MethodPost, "/entries/9/unmute", nil))
	setPathParams(c, map[string]string{"id": "9"})

	require.NoError(t, h.Unmute(c))
	require.Equal(t, http.StatusNotFound, rec.Code)
}
