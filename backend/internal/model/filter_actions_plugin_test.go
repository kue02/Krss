package model_test

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
)

func TestFilterActions_PluginActionsRoundTrip(t *testing.T) {
	actions := model.FilterActions{PluginActions: []model.PluginActionRef{{
		Plugin: "bark", Action: "notify", Config: map[string]string{"url": "https://api.day.app/KEY"},
	}}}
	raw, err := json.Marshal(actions)
	require.NoError(t, err)
	var back model.FilterActions
	require.NoError(t, json.Unmarshal(raw, &back))
	require.Equal(t, actions, back)
}

func TestFilterActions_IsEmpty_CountsPluginActions(t *testing.T) {
	require.True(t, model.FilterActions{}.IsEmpty())
	require.False(t, model.FilterActions{PluginActions: []model.PluginActionRef{{Plugin: "bark", Action: "notify"}}}.IsEmpty(),
		"只有插件动作的规则不是空规则")
}

func TestFilterActions_OldJSONWithoutPluginActions(t *testing.T) {
	// 老数据（没有 pluginActions 键）必须能解析且行为不变
	var back model.FilterActions
	require.NoError(t, json.Unmarshal([]byte(`{"notify":true,"notifyUrl":"https://api.day.app/OLD"}`), &back))
	require.True(t, back.Notify)
	require.Empty(t, back.PluginActions)
}
