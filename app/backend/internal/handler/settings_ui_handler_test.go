package handler_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"gist/backend/internal/handler"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"gist/backend/internal/service"
	"gist/backend/internal/service/mock"
)

// errStoreFailure：模拟仓储层真出错（与「值不合法」区分开，前者 500、后者 400）。
var errStoreFailure = errors.New("store failed")

func TestSettingsHandler_GetUISettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/settings/ui", nil)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		GetUISettings(gomock.Any()).
		Return(&service.UISettings{
			UI:           json.RawMessage(`{"shared":{"uiScale":1.25},"device":{"desktop":{},"mobile":{}}}`),
			Theme:        service.UIThemeSettings{Mode: "dark", LightTheme: "light", DarkTheme: "dark"},
			Lang:         "zh",
			SidebarState: json.RawMessage(`{"技术":true}`),
			Empty:        false,
		}, nil)

	err := h.GetUISettings(c)
	require.NoError(t, err)

	var resp handler.UISettingsResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.False(t, resp.Empty)
	require.Equal(t, "zh", resp.Lang)
	require.Equal(t, "dark", resp.Theme.Mode)
	require.JSONEq(t, `{"技术":true}`, string(resp.SidebarState))
	require.Contains(t, string(resp.UI), "uiScale")
}

func TestSettingsHandler_GetUISettings_EmptyIsExplicit(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/settings/ui", nil)
	c, rec := newTestContext(e, req)

	// 服务端一条都没存过：ui / sidebarState 也要是合法对象（不能是 null），前端才敢直接吃
	mockService.EXPECT().GetUISettings(gomock.Any()).Return(&service.UISettings{Empty: true}, nil)

	require.NoError(t, h.GetUISettings(c))

	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
	require.JSONEq(t, `{}`, string(raw["ui"]))
	require.JSONEq(t, `{}`, string(raw["sidebarState"]))
	require.JSONEq(t, `true`, string(raw["empty"]))
}

func TestSettingsHandler_UpdateUISettings_OnlySendsProvidedParts(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	// 只改外观 → 请求里只带 theme，其余三项必须是「没传」（服务端才不会被清空）
	req := newJSONRequest(http.MethodPut, "/settings/ui", map[string]any{
		"theme": map[string]any{"mode": "light", "lightTheme": "stone", "darkTheme": "dark"},
	})
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		SetUISettings(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, payload *service.UISettings) error {
			require.Equal(t, "light", payload.Theme.Mode)
			require.Empty(t, payload.UI)
			require.Empty(t, payload.Lang)
			require.Empty(t, payload.SidebarState)
			return nil
		})
	mockService.EXPECT().GetUISettings(gomock.Any()).Return(&service.UISettings{Lang: "zh"}, nil)

	require.NoError(t, h.UpdateUISettings(c))
	require.Equal(t, http.StatusOK, rec.Code)
}

func TestSettingsHandler_UpdateUISettings_BadPayloadIs400(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodPut, "/settings/ui", map[string]any{
		"theme": map[string]any{"mode": "rainbow"},
	})
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		SetUISettings(gomock.Any(), gomock.Any()).
		Return(service.ErrInvalid)

	require.NoError(t, h.UpdateUISettings(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "invalid")
}

func TestSettingsHandler_UpdateUISettings_StoreErrorIs500(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodPut, "/settings/ui", map[string]any{"lang": "zh"})
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		SetUISettings(gomock.Any(), gomock.Any()).
		Return(errStoreFailure)

	require.NoError(t, h.UpdateUISettings(c))
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestSettingsHandler_ExportSettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/settings/export", nil)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().ExportSettings(gomock.Any()).Return(&service.SettingsExport{
		Version:      1,
		Settings:     map[string]json.RawMessage{"ai.provider": json.RawMessage(`"compatible"`)},
		ExcludedKeys: []string{"ai.api_key"},
	}, nil)

	require.NoError(t, h.ExportSettings(c))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Header().Get("Content-Disposition"), "krss-settings.json")
	require.Contains(t, rec.Body.String(), "compatible")
	require.Contains(t, rec.Body.String(), "ai.api_key")
}

func TestSettingsHandler_ExportSettings_ErrorIs500(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/settings/export", nil)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().ExportSettings(gomock.Any()).Return(nil, errStoreFailure)

	require.NoError(t, h.ExportSettings(c))
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestSettingsHandler_ImportSettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodPost, "/settings/import", map[string]any{
		"version": 1,
		"settings": map[string]any{
			"ai.provider": "compatible",
			"ui.lang":     "zh",
		},
	})
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		ImportSettings(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, payload *service.SettingsExport) error {
			require.Len(t, payload.Settings, 2)
			return nil
		})

	require.NoError(t, h.ImportSettings(c))

	var resp handler.SettingsImportResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Equal(t, 2, resp.Imported)
}

func TestSettingsHandler_ImportSettings_UnknownKeyIs400(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodPost, "/settings/import", map[string]any{
		"version":  1,
		"settings": map[string]any{"hacker.key": "x"},
	})
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		ImportSettings(gomock.Any(), gomock.Any()).
		Return(service.ErrUnknownSettingKey)

	require.NoError(t, h.ImportSettings(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "unknown setting key")
}

func TestSettingsHandler_ImportSettings_InvalidIs400(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodPost, "/settings/import", map[string]any{"settings": map[string]any{}})
	c, rec := newTestContext(e, req)

	mockService.EXPECT().ImportSettings(gomock.Any(), gomock.Any()).Return(service.ErrInvalid)

	require.NoError(t, h.ImportSettings(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestSettingsHandler_ImportSettings_StoreErrorIs500(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodPost, "/settings/import", map[string]any{
		"settings": map[string]any{"ui.lang": "zh"},
	})
	c, rec := newTestContext(e, req)

	mockService.EXPECT().ImportSettings(gomock.Any(), gomock.Any()).Return(errStoreFailure)

	require.NoError(t, h.ImportSettings(c))
	require.Equal(t, http.StatusInternalServerError, rec.Code)
}
