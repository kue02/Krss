// Command hello-menu 是最小的**外部插件**示例：右键菜单里多一项「打个招呼」。
//
// 它刻意什么都不做——不读库、不发网络、不存数据，只演示「一个插件最少要写哪几样东西」：
//
//	Meta()            插件身份（id 决定目录名与数据隔离）
//	Actions()         动作（自动化规则里可引用，界面直调也走它）
//	contributions     在哪个界面挂点、显示什么文字（声明式，宿主用 HeroUI 画）
//	Invoke            界面点下去时宿主调用它
//
// 装：go build -o hello-menu ./cmd/examples/hello-menu
//
//	cp hello-menu plugin.json "$KRSS_DATA_DIR/plugins/hello-menu/"
//
// 宿主 4~5 秒内发现并 spawn，右键菜单里就会出现（不用重启 krss）。
package main

import (
	"context"
	"fmt"
	"log"

	"krss/backend/internal/plugin"
	"krss/backend/internal/plugin/sdk"
)

const pluginID = "hello-menu"

type helloPlugin struct{}

func (helloPlugin) Meta() plugin.Meta {
	return plugin.Meta{
		ID:          pluginID,
		Name:        "打个招呼",
		Version:     "0.0.1",
		Description: "最小外部插件示例（右键菜单一项）",
		Transport:   "http",
		Permissions: []string{"entries:read"},
	}
}

func (helloPlugin) Actions() []plugin.Action { return []plugin.Action{helloAction{}} }

func (helloPlugin) SettingsSections() []plugin.SettingsSection { return nil }

func (helloPlugin) EntryProcessors() []plugin.EntryProcessor { return nil }

func (helloPlugin) FetchClassifiers() []plugin.FetchClassifier { return nil }

// Contributions 声明「条目右键菜单里加一项」。Plugin 字段由宿主注入，这里不填。
func (helloPlugin) Contributions() []plugin.Contribution {
	return []plugin.Contribution{{
		ID:        "hi",
		Surface:   plugin.SurfaceEntryContextMenu,
		Action:    "hi",
		Label:     "打个招呼",
		Icon:      "sparkles", // 宿主白名单里的图标名，认不出就不画
		Selection: plugin.SelectionSingle,
	}}
}

type helloAction struct{}

func (helloAction) ID() string                                          { return "hi" }
func (helloAction) Label() string                                       { return "打个招呼" }
func (helloAction) Fields() []plugin.Field                              { return nil }
func (helloAction) Execute(context.Context, plugin.ActionRequest) error { return nil } // 只给界面用

// Invoke 界面点下去时走这里：返回的 message 会被宿主弹成提示。
func (helloAction) Invoke(_ context.Context, req plugin.InvokeRequest) (plugin.InvokeResult, error) {
	entryID := ""
	if len(req.Selection.EntryIDs) > 0 {
		entryID = fmt.Sprint(req.Selection.EntryIDs[0])
	}
	return plugin.InvokeResult{
		Message: fmt.Sprintf("你好，条目 %s", entryID),
		Level:   "success",
	}, nil
}

func main() {
	if err := sdk.Serve(context.Background(), helloPlugin{}); err != nil {
		log.Fatalf("hello-menu: %v", err)
	}
}
