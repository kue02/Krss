package handler_test

import (
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"krss/backend/internal/handler"
	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"
)

// 用户填了个没协议头的地址时，必须给 400 + 一句可执行的提示，而不是「内部错误」
// （实测过：以前这里一律 500，界面只能看到「保存失败」，看不出哪里不对）
func TestSettingsHandler_UpdateGeneralSettings_InvalidURLIs400(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)
	e := newTestEcho()

	req := newJSONRequest(http.MethodPut, "/settings/general", map[string]interface{}{
		"fallbackUserAgent": "",
		"autoReadability":   false,
		"markReadOnScroll":  true,
		"rsshubBaseUrl":     "",
		"rsshubAccessKey":   "",
		"barkUrl":           "api.day.app/notakey", // 少了 https://
	})
	c, rec := newTestContext(e, req)

	mockService.EXPECT().SetGeneralSettings(gomock.Any(), gomock.Any()).Return(service.ErrInvalid)

	require.NoError(t, h.UpdateGeneralSettings(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)

	var body struct {
		Error string `json:"error"`
	}
	parseJSONResponse(t, rec, &body)
	require.Contains(t, body.Error, "http://")
}

// 真正的内部错误仍然是 500，不要被伪装成「输入不合法」
func TestSettingsHandler_UpdateGeneralSettings_DBErrorIs500(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)
	e := newTestEcho()

	req := newJSONRequest(http.MethodPut, "/settings/general", map[string]interface{}{
		"barkUrl": "https://api.day.app/ok",
	})
	c, rec := newTestContext(e, req)

	mockService.EXPECT().SetGeneralSettings(gomock.Any(), gomock.Any()).Return(errors.New("db down"))

	require.NoError(t, h.UpdateGeneralSettings(c))
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}
