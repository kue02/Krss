package handler_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"gist/backend/internal/handler"
	"gist/backend/internal/model"
	"gist/backend/internal/service"
	"gist/backend/internal/service/mock"
)

// 设置页「发送测试推送」成功了 → 200 + 状态码
func TestFilterHandler_TestNotify_Success(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandler(mockService)
	e := newTestEcho()

	req := newJSONRequest(http.MethodPost, "/notify/test", nil)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().TestNotify(gomock.Any()).Return(200, nil)

	require.NoError(t, h.TestNotify(c))
	require.Equal(t, http.StatusOK, rec.Code)

	var body struct {
		Status int `json:"status"`
	}
	assertJSONResponse(t, rec, http.StatusOK, &body)
	require.Equal(t, 200, body.Status)
}

// 没配地址 → 400（前端据此提示「先填地址再测试」）
func TestFilterHandler_TestNotify_NotConfigured(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandler(mockService)
	e := newTestEcho()

	req := newJSONRequest(http.MethodPost, "/notify/test", nil)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().TestNotify(gomock.Any()).Return(0, service.ErrInvalid)

	require.NoError(t, h.TestNotify(c))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// 投递失败 → 502 且把原因带回去（失败要给可见原因）
func TestFilterHandler_TestNotify_DeliveryFailed(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandler(mockService)
	e := newTestEcho()

	req := newJSONRequest(http.MethodPost, "/notify/test", nil)
	c, rec := newTestContext(e, req)

	mockService.EXPECT().TestNotify(gomock.Any()).
		Return(502, errors.New("api.day.app（HTTP 502，目标 api.day.app）"))

	require.NoError(t, h.TestNotify(c))
	require.Equal(t, http.StatusBadGateway, rec.Code)

	var body struct {
		Error string `json:"error"`
	}
	parseJSONResponse(t, rec, &body)
	require.Contains(t, body.Error, "api.day.app")
}

// 规则写入要把 notify / notifyUrl 带上（否则动作存了也读不回来），并顺手去掉地址两端空格
func TestFilterHandler_NotifyFieldsRoundTrip(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandler(mockService)
	e := newTestEcho()

	req := newJSONRequest(http.MethodPost, "/filters", map[string]interface{}{
		"name":       "推送到手机",
		"scopeType":  "all",
		"conditions": []map[string]interface{}{{"field": "title", "operator": "contains", "value": "AI"}},
		"actions": map[string]interface{}{
			"notify":    true,
			"notifyUrl": "  https://api.day.app/ABC123  ",
		},
	})
	c, rec := newTestContext(e, req)

	var captured service.FilterWriteParams
	created := model.Filter{ID: 9, Name: "推送到手机", Actions: model.FilterActions{Notify: true, NotifyURL: "https://api.day.app/ABC123"}}
	mockService.EXPECT().
		Create(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, params service.FilterWriteParams) (model.Filter, error) {
			captured = params
			return created, nil
		})

	require.NoError(t, h.Create(c))
	require.Equal(t, http.StatusCreated, rec.Code)
	require.True(t, captured.Actions.Notify, "notify 开关要传到 service")
	require.Equal(t, "https://api.day.app/ABC123", captured.Actions.NotifyURL, "地址要去掉两端空格")

	// 出参也要带回来（规则响应就是规则对象本身，没有再套一层）
	var body struct {
		Actions struct {
			Notify    bool   `json:"notify"`
			NotifyURL string `json:"notifyUrl"`
		} `json:"actions"`
	}
	parseJSONResponse(t, rec, &body)
	require.True(t, body.Actions.Notify)
	require.Equal(t, "https://api.day.app/ABC123", body.Actions.NotifyURL)
}
