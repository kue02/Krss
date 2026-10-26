package handler_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"krss/backend/internal/handler"
	"krss/backend/internal/model"
	"krss/backend/internal/service"
	"krss/backend/internal/service/mock"
)

// 规则写入要把 pluginActions 带上（否则动作存了也读不回来 → 编辑器一保存就把推送动作丢掉），
// 并顺手去掉插件/动作 id 与配置值两端的空格。55-13 从旧的 notify 往返用例搬来。
func TestFilterHandler_PluginActionsRoundTrip(t *testing.T) {
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
			"pluginActions": []map[string]interface{}{{
				"plugin": " bark ",
				"action": " notify ",
				"config": map[string]string{"url": "  https://api.day.app/ABC123  "},
			}},
		},
	})
	c, rec := newTestContext(e, req)

	var captured service.FilterWriteParams
	created := model.Filter{ID: 9, Name: "推送到手机", Actions: model.FilterActions{
		PluginActions: []model.PluginActionRef{{
			Plugin: "bark", Action: "notify", Config: map[string]string{"url": "https://api.day.app/ABC123"},
		}},
	}}
	mockService.EXPECT().
		Create(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, params service.FilterWriteParams) (model.Filter, error) {
			captured = params
			return created, nil
		})

	require.NoError(t, h.Create(c))
	require.Equal(t, http.StatusCreated, rec.Code)
	require.Len(t, captured.Actions.PluginActions, 1, "pluginActions 要传到 service")
	require.Equal(t, "bark", captured.Actions.PluginActions[0].Plugin, "插件 id 去两端空格")
	require.Equal(t, "notify", captured.Actions.PluginActions[0].Action)
	require.Equal(t, "https://api.day.app/ABC123", captured.Actions.PluginActions[0].Config["url"], "配置值去两端空格")

	// 出参也要带回来（规则响应就是规则对象本身，没有再套一层）
	var body struct {
		Actions struct {
			PluginActions []struct {
				Plugin string            `json:"plugin"`
				Action string            `json:"action"`
				Config map[string]string `json:"config"`
			} `json:"pluginActions"`
		} `json:"actions"`
	}
	parseJSONResponse(t, rec, &body)
	require.Len(t, body.Actions.PluginActions, 1)
	require.Equal(t, "bark", body.Actions.PluginActions[0].Plugin)
	require.Equal(t, "notify", body.Actions.PluginActions[0].Action)
	require.Equal(t, "https://api.day.app/ABC123", body.Actions.PluginActions[0].Config["url"])
}

// 只填了插件 id 或动作 id 的残项要丢掉（空动作不该写进库，也不该让整条请求 400）。
func TestFilterHandler_PluginActionsDropsIncompleteRefs(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockService := mock.NewMockFilterService(ctrl)
	h := handler.NewFilterHandler(mockService)
	e := newTestEcho()

	req := newJSONRequest(http.MethodPost, "/filters", map[string]interface{}{
		"name":       "残项",
		"scopeType":  "all",
		"conditions": []map[string]interface{}{{"field": "title", "operator": "contains", "value": "AI"}},
		"actions": map[string]interface{}{
			"webhook":       true,
			"webhookUrl":    "https://example.com/hook",
			"pluginActions": []map[string]interface{}{{"plugin": "bark"}, {"action": "notify"}},
		},
	})
	c, rec := newTestContext(e, req)

	var captured service.FilterWriteParams
	mockService.EXPECT().
		Create(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, params service.FilterWriteParams) (model.Filter, error) {
			captured = params
			return model.Filter{ID: 10, Name: params.Name, Actions: params.Actions}, nil
		})

	require.NoError(t, h.Create(c))
	require.Equal(t, http.StatusCreated, rec.Code)
	require.Empty(t, captured.Actions.PluginActions, "缺 plugin 或 action 的引用要丢掉")
	require.True(t, captured.Actions.Webhook, "webhook 动作照旧不受影响")
}
