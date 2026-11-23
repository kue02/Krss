package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"krss/backend/internal/handler"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"
)

func TestSettingsHandler_GetAISettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/settings/ai", nil)
	c, rec := newTestContext(e, req)

	settings := &service.AISettings{
		Provider: "openai",
		Model:    "gpt-4",
	}

	mockService.EXPECT().
		GetAISettings(gomock.Any()).
		Return(settings, nil)

	err := h.GetAISettings(c)
	require.NoError(t, err)

	var resp handler.AISettingsResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Equal(t, "openai", resp.Provider)
}

func TestSettingsHandler_UpdateAISettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"provider": "openai",
		"baseUrl":  "https://api.openai.com/v1",
		"model":    "gpt-4",
		"requestOptions": map[string]any{
			"temperature": 0.2,
			"extra_body":  map[string]any{"trace": true},
		},
	}
	req := newJSONRequest(http.MethodPut, "/settings/ai", reqBody)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		SetAISettings(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, settings *service.AISettings) error {
			require.Equal(t, map[string]any{"temperature": 0.2, "extra_body": map[string]any{"trace": true}}, settings.RequestOptions)
			return nil
		})

	mockService.EXPECT().
		GetAISettings(gomock.Any()).
		Return(&service.AISettings{Provider: "openai", BaseURL: "https://api.openai.com/v1", Model: "gpt-4"}, nil)

	err := h.UpdateAISettings(c)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestSettingsHandler_UpdateAISettings_MissingBaseURLForOpenAI(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	// 51 批 A6：providers 剥占位后非空才校验 —— 这条用例补一张真卡以命中 baseUrl 校验
	reqBody := map[string]interface{}{
		"provider": "openai",
		"model":    "gpt-4",
		"providers": []map[string]interface{}{
			{"id": "p1", "provider": "openai", "model": "gpt-4"},
		},
	}
	req := newJSONRequest(http.MethodPut, "/settings/ai", reqBody)
	c, rec := newTestContext(e, req)

	err := h.UpdateAISettings(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// 51 批 A6：providers 删到 0（或只有占位卡）时，model 不再必填 —— 否则最后一张卡删不掉。
func TestSettingsHandler_UpdateAISettings_EmptyProvidersAllowsNoModel(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"provider": "openai",
		"model":    "",
	}
	req := newJSONRequest(http.MethodPut, "/settings/ai", reqBody)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().SetAISettings(gomock.Any(), gomock.Any()).Return(nil).Times(1)
	mockService.EXPECT().GetAISettings(gomock.Any()).Return(&service.AISettings{}, nil).Times(1)
	err := h.UpdateAISettings(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, rec.Code)
}

// 47-3（用户 2026-10-12）：选了免 key 的免费翻译通道（google / youdao）时，
// 没有模型 / 密钥也必须存得下来 —— 前端表单的 provider 默认就是 openai 且总会一起提交。
func TestSettingsHandler_UpdateAISettings_FreeTranslateChannelWithoutModel(t *testing.T) {
	for _, channel := range []string{"google", "youdao"} {
		t.Run(channel, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			mockService := mock.NewMockSettingsService(ctrl)
			h := handler.NewSettingsHandlerHelper(mockService, nil)

			e := newTestEcho()
			reqBody := map[string]interface{}{
				"provider":         "openai",
				"model":            "",
				"translateChannel": channel,
			}
			req := newJSONRequest(http.MethodPut, "/settings/ai", reqBody)
			c, rec := newTestContext(e, req)

			mockService.EXPECT().
				SetAISettings(gomock.Any(), gomock.Any()).
				DoAndReturn(func(_ context.Context, settings *service.AISettings) error {
					require.Equal(t, channel, settings.TranslateChannel)
					return nil
				})

			mockService.EXPECT().
				GetAISettings(gomock.Any()).
				Return(&service.AISettings{Provider: "openai", TranslateChannel: channel}, nil)

			err := h.UpdateAISettings(c)
			require.NoError(t, err)
			require.Equal(t, http.StatusOK, rec.Code)
		})
	}
}

// 新增键 translateChannels（通道轮询列表）里只要有一个合法免 key 通道，
// 没有模型 / 密钥也必须存得下来（与旧的单值 translateChannel 行为一致）。
func TestSettingsHandler_UpdateAISettings_FreeTranslateChannelsWithoutModel(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"provider":          "openai",
		"model":             "",
		"translateChannels": []string{"youdao"},
	}
	req := newJSONRequest(http.MethodPut, "/settings/ai", reqBody)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		SetAISettings(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, settings *service.AISettings) error {
			require.Equal(t, []string{"youdao"}, settings.TranslateChannels)
			return nil
		})
	mockService.EXPECT().
		GetAISettings(gomock.Any()).
		Return(&service.AISettings{Provider: "openai", TranslateChannels: []string{"youdao"}}, nil)

	err := h.UpdateAISettings(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, rec.Code)
}

// 对照组：translateChannels 里全是非法通道时不能绕过 provider/model 校验。
func TestSettingsHandler_UpdateAISettings_InvalidTranslateChannelsDoNotBypass(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"provider":          "openai",
		"model":             "",
		"translateChannels": []string{"bogus"},
		"providers": []map[string]interface{}{
			{"id": "p1", "provider": "openai", "model": ""},
		},
	}
	req := newJSONRequest(http.MethodPut, "/settings/ai", reqBody)
	c, rec := newTestContext(e, req)

	err := h.UpdateAISettings(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// 对照组：没选免费通道时，缺模型仍然要 400（不能连带把校验整体放松）
func TestSettingsHandler_UpdateAISettings_ModelStillRequiredWithoutFreeChannel(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"provider": "openai",
		"model":    "",
		"providers": []map[string]interface{}{
			{"id": "p1", "provider": "openai", "model": ""},
		},
	}
	req := newJSONRequest(http.MethodPut, "/settings/ai", reqBody)
	c, rec := newTestContext(e, req)

	err := h.UpdateAISettings(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestSettingsHandler_TestNetworkProxy_Disabled(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"enabled": false,
	}
	req := newJSONRequest(http.MethodPost, "/settings/network/test", reqBody)
	c, rec := newTestContext(e, req)

	err := h.TestNetworkProxy(c)
	require.NoError(t, err)

	var resp handler.NetworkTestResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.True(t, resp.Success)
}

func TestSettingsHandler_TestNetworkProxy_InvalidParams(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"enabled": true,
		"host":    "",
	}
	req := newJSONRequest(http.MethodPost, "/settings/network/test", reqBody)
	c, rec := newTestContext(e, req)

	err := h.TestNetworkProxy(c)
	require.NoError(t, err)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestSettingsHandler_GetGeneralSettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/settings/general", nil)
	c, rec := newTestContext(e, req)

	settings := &service.GeneralSettings{
		AutoReadability:  true,
		MarkReadOnScroll: true,
	}

	mockService.EXPECT().
		GetGeneralSettings(gomock.Any()).
		Return(settings, nil)

	err := h.GetGeneralSettings(c)
	require.NoError(t, err)

	var resp handler.GeneralSettingsResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.True(t, resp.AutoReadability)
	require.True(t, resp.MarkReadOnScroll)
}

func TestSettingsHandler_UpdateGeneralSettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"autoReadability":  true,
		"markReadOnScroll": true,
	}
	req := newJSONRequest(http.MethodPut, "/settings/general", reqBody)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		SetGeneralSettings(gomock.Any(), gomock.AssignableToTypeOf(&service.GeneralSettings{})).
		DoAndReturn(func(_ context.Context, settings *service.GeneralSettings) error {
			require.True(t, settings.AutoReadability)
			require.True(t, settings.MarkReadOnScroll)
			return nil
		})

	mockService.EXPECT().
		GetGeneralSettings(gomock.Any()).
		Return(&service.GeneralSettings{AutoReadability: true, MarkReadOnScroll: true}, nil)

	err := h.UpdateGeneralSettings(c)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestSettingsHandler_GetAppearanceSettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/settings/appearance", nil)
	c, rec := newTestContext(e, req)

	settings := &service.AppearanceSettings{
		ContentTypes: []string{"article"},
	}

	mockService.EXPECT().
		GetAppearanceSettings(gomock.Any()).
		Return(settings, nil)

	err := h.GetAppearanceSettings(c)
	require.NoError(t, err)

	var resp handler.AppearanceSettingsResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Equal(t, []string{"article"}, resp.ContentTypes)
}

func TestSettingsHandler_UpdateAppearanceSettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"contentTypes": []string{"article", "picture"},
	}
	req := newJSONRequest(http.MethodPut, "/settings/appearance", reqBody)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		SetAppearanceSettings(gomock.Any(), gomock.Any()).
		Return(nil)

	mockService.EXPECT().
		GetAppearanceSettings(gomock.Any()).
		Return(&service.AppearanceSettings{ContentTypes: []string{"article", "picture"}}, nil)

	err := h.UpdateAppearanceSettings(c)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestSettingsHandler_TestAI_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"provider": "openai",
		"apiKey":   "sk-test",
		"baseUrl":  "https://api.openai.com/v1",
		"model":    "gpt-4",
		"requestOptions": map[string]any{
			"temperature": 0.2,
			"extra_body":  map[string]any{"trace": true},
		},
	}
	req := newJSONRequest(http.MethodPost, "/settings/ai/test", reqBody)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		TestAI(gomock.Any(), "openai", "sk-test", "https://api.openai.com/v1", "gpt-4", map[string]any{"temperature": 0.2, "extra_body": map[string]any{"trace": true}}).
		Return("OK", nil)

	err := h.TestAI(c)
	require.NoError(t, err)

	var resp handler.AITestResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Equal(t, "OK", resp.Message)
}

func TestSettingsHandler_TestAI_MissingBaseURLForOpenAI(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"provider": "openai",
		"apiKey":   "sk-test",
		"model":    "gpt-4",
	}
	req := newJSONRequest(http.MethodPost, "/settings/ai/test", reqBody)
	c, rec := newTestContext(e, req)

	err := h.TestAI(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestSettingsHandler_TestAI_AnthropicBaseURLOptional(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"provider": "anthropic",
		"apiKey":   "sk-ant-test",
		"model":    "claude-sonnet-4-20250514",
	}
	req := newJSONRequest(http.MethodPost, "/settings/ai/test", reqBody)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		TestAI(gomock.Any(), "anthropic", "sk-ant-test", "", "claude-sonnet-4-20250514", map[string]any(nil)).
		Return("OK", nil)

	err := h.TestAI(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, rec.Code)
}

func TestSettingsHandler_ClearAnubisCookies_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodDelete, "/settings/anubis-cookies", nil)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		ClearAnubisCookies(gomock.Any()).
		Return(int64(5), nil)

	err := h.ClearAnubisCookies(c)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestSettingsHandler_GetNetworkSettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/settings/network", nil)
	c, rec := newTestContext(e, req)

	settings := &service.NetworkSettings{
		Enabled:  true,
		Type:     "socks5",
		Host:     "127.0.0.1",
		Port:     7890,
		Username: "user",
		Password: "***",
		IPStack:  "ipv4",
	}

	mockService.EXPECT().
		GetNetworkSettings(gomock.Any()).
		Return(settings, nil)

	err := h.GetNetworkSettings(c)
	require.NoError(t, err)

	var resp map[string]interface{}
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Equal(t, true, resp["enabled"])
	require.Equal(t, "socks5", resp["type"])
	require.Equal(t, "127.0.0.1", resp["host"])
	require.Equal(t, "ipv4", resp["ipStack"])
}

func TestSettingsHandler_UpdateNetworkSettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	reqBody := map[string]interface{}{
		"enabled":  true,
		"type":     "http",
		"host":     "proxy.local",
		"port":     8080,
		"username": "user",
		"password": "secret",
		"ipStack":  "default",
	}
	req := newJSONRequest(http.MethodPut, "/settings/network", reqBody)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().
		SetNetworkSettings(gomock.Any(), gomock.Any()).
		Return(nil)

	mockService.EXPECT().
		GetNetworkSettings(gomock.Any()).
		Return(&service.NetworkSettings{
			Enabled:  true,
			Type:     "http",
			Host:     "proxy.local",
			Port:     8080,
			Username: "user",
			Password: "***",
			IPStack:  "default",
		}, nil)

	err := h.UpdateNetworkSettings(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, rec.Code)
}

func TestSettingsHandler_UpdateNetworkSettings_InvalidRequest(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := httptest.NewRequest(http.MethodPut, "/settings/network", newBody(`{"enabled":`))
	req.Header.Set("Content-Type", "application/json")
	c, rec := newTestContext(e, req)

	err := h.UpdateNetworkSettings(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestSettingsHandler_GetCacheSettings_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodGet, "/settings/cache", nil)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().GetCacheSettings(gomock.Any()).Return(&service.CacheSettings{
		EntryRetentionDays:     30,
		TombstoneRetentionDays: 180,
	}, nil)

	err := h.GetCacheSettings(c)
	require.NoError(t, err)

	var resp handler.CacheSettingsResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Equal(t, 30, resp.EntryRetentionDays)
	require.Equal(t, 180, resp.TombstoneRetentionDays)
}

func TestSettingsHandler_UpdateCacheSettings_ExplicitZero(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequest(http.MethodPut, "/settings/cache", map[string]interface{}{
		"entryRetentionDays":     0,
		"tombstoneRetentionDays": 0,
	})
	c, rec := newTestContext(e, req)

	// UpdateCacheSettings：先读当前做部分合并 → 写 → 再读回。
	mockService.EXPECT().GetCacheSettings(gomock.Any()).Return(&service.CacheSettings{
		EntryRetentionDays:     30,
		TombstoneRetentionDays: 180,
	}, nil)
	mockService.EXPECT().SetCacheSettings(gomock.Any(), &service.CacheSettings{
		EntryRetentionDays:     0,
		TombstoneRetentionDays: 0,
	}).Return(nil)
	mockService.EXPECT().GetCacheSettings(gomock.Any()).Return(&service.CacheSettings{
		EntryRetentionDays:     0,
		TombstoneRetentionDays: 0,
	}, nil)

	err := h.UpdateCacheSettings(c)
	require.NoError(t, err)

	var resp handler.CacheSettingsResponse
	assertJSONResponse(t, rec, http.StatusOK, &resp)
	require.Equal(t, 0, resp.EntryRetentionDays)
	require.Equal(t, 0, resp.TombstoneRetentionDays)
}

func TestSettingsHandler_UpdateCacheSettings_InvalidRequest(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockSettingsService(ctrl)
	h := handler.NewSettingsHandlerHelper(mockService, nil)

	e := newTestEcho()
	req := newJSONRequestRaw(http.MethodPut, "/settings/cache", `{"entryRetentionDays":`)
	c, rec := newTestContext(e, req)

	err := h.UpdateCacheSettings(c)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}
