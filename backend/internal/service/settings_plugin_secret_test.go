package service_test

import (
	"testing"

	"krss/backend/internal/plugin"
	// 守门测试必须能看见内置插件的声明 —— 没有这两条 blank import，Catalog 是空的，
	// 循环体一次都不跑，测试会假绿（这也是下面两条 require 存在的原因）。
	_ "krss/backend/internal/plugin/builtin/bark"
	_ "krss/backend/internal/plugin/builtin/rsshub"
	"krss/backend/internal/service"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 铁闸：任何插件声明为 secret 的设置键，都必须出现在导出排除名单里 ——
// 插件密钥（Bark 推送地址等）不许进导出文件。新增插件密钥时忘了同步
// excludedSettingKeys()，这条测试会直接红。
func TestExcludedSettingKeys_CoverPluginSecrets(t *testing.T) {
	excluded := make(map[string]bool)
	for _, key := range service.ExcludedSettingKeysForTest() {
		excluded[key] = true
	}

	registry := plugin.Default
	require.NotEmpty(t, registry.Plugins(), "内置插件没注册上（blank import 漏了 ⇒ 这条测试只会假绿）")

	checked := 0
	for _, item := range registry.Catalog() {
		fieldSets := make([][]plugin.Field, 0, len(item.Sections)+len(item.Actions))
		for _, section := range item.Sections {
			fieldSets = append(fieldSets, section.Fields)
		}
		for _, action := range item.Actions {
			fieldSets = append(fieldSets, action.Fields)
		}
		for _, fields := range fieldSets {
			for _, key := range plugin.SecretKeys(item.Meta, fields) {
				checked++
				assert.Truef(t, excluded[key], "插件 %s 的密钥 %s 没进 excludedSettingKeys()", item.Meta.ID, key)
			}
		}
	}
	require.Positive(t, checked, "一个 secret 字段都没扫到 ⇒ 测试没在验真东西")
	require.True(t, excluded["plugin.bark.url"], "bark 的推送地址是 secret，必须在排除名单里")
}

// 反向：名单里的插件键不能是死键（插件改名 / 字段改名后留下的幽灵键会误导用户）。
func TestExcludedSettingKeys_PluginKeysAreDeclaredSecrets(t *testing.T) {
	declared := make(map[string]bool)
	for _, item := range plugin.Default.Catalog() {
		for _, section := range item.Sections {
			for _, key := range plugin.SecretKeys(item.Meta, section.Fields) {
				declared[key] = true
			}
		}
		for _, action := range item.Actions {
			for _, key := range plugin.SecretKeys(item.Meta, action.Fields) {
				declared[key] = true
			}
		}
	}

	for _, key := range service.ExcludedSettingKeysForTest() {
		if len(key) <= len("plugin.") || key[:len("plugin.")] != "plugin." {
			continue
		}
		assert.Truef(t, declared[key], "排除名单里的 %s 没有任何插件声明为 secret（死键）", key)
	}
}
