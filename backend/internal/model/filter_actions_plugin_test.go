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
	// 老数据（55-13 之前的 notify / notifyUrl 键）必须仍能解析且不炸：这两个键已被模型删掉，
	// 反序列化时直接忽略（真正的改写发生在迁移 32，不在模型层）。
	var back model.FilterActions
	require.NoError(t, json.Unmarshal([]byte(`{"notify":true,"notifyUrl":"https://api.day.app/OLD"}`), &back))
	require.Empty(t, back.PluginActions)
	require.True(t, back.IsEmpty(), "只有已废弃的 notify 键 = 没有动作")
}
