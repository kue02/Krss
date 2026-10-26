// Package annotate 标注插件：**外部插件样板**（56-30）。
//
// 一次把「插件能做什么」演示全：
//   - 三条界面贡献：阅读器正文「高亮」/「写笔记」、阅读器工具栏「导出到 Obsidian」；
//   - 正文装饰（Decorate）：把用户之前标的区间读回来交给宿主画，插件不碰 DOM；
//   - 自定义视图（Views + ui/index.html）：沙箱 iframe 里用 bridge.js 读自己的数据；
//   - 数据落在插件自己的 data.json（外部插件不碰宿主 DB）。
//
// 形态：编成可执行 + plugin.json 丢进 $KRSS_DATA_DIR/plugins/annotate/（外部轨），
// 与内置插件共用 internal/plugin 的同一套契约 —— 区别只在「谁 spawn 我、资源从哪来」。
//
// ⚠️ 样板边界（不假装已经打通）：Invoke 写的是插件进程里的 data.json，而插件页面的
// krss.data.* 走宿主 DB 的插件数据接口（56-17~20）—— 两条通道在 v1 尚未合并（导出/回填
// 属 56-31 之后）。视图页展示的是宿主侧那份数据，形状与这里一致。
package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"strconv"

	"krss/backend/internal/plugin"
)

const (
	metaID = "annotate"
	// collectionAnnotations 标注集合：key = 条目 id，value = JSON 数组（见 annotation）。
	collectionAnnotations = "annotations"

	colorYellow = "yellow"
	colorBlue   = "blue"
)

// annotate 插件本体。st 为 nil 时用进程默认 store（测试注入独立内存库）。
// 值接收者 + 指针字段：sdk.Serve 拿到的是副本，但指向同一份 store。
type annotate struct {
	st *store
}

func (a annotate) store() *store {
	if a.st != nil {
		return a.st
	}
	return dataStore()
}

// 编译期确认扩展点都在（少了哪个，宿主侧要到用户点下去才知道）。
var (
	_ plugin.Plugin                = annotate{}
	_ plugin.ContributionsProvider = annotate{}
	_ plugin.RenderDecorator       = annotate{}
	_ plugin.ViewProvider          = annotate{}
	_ plugin.UIAssets              = annotate{}
)

func (annotate) Meta() plugin.Meta {
	return plugin.Meta{
		ID:          metaID,
		Name:        "标注",
		Description: "在正文里高亮 / 记笔记，按条目导出 Markdown 到 Obsidian。外部插件样板。",
		Version:     "0.1.0",
		// 权限按「真用到」申请：读条目正文（entries:full）、来源信息、自己的数据、
		// 导出文件、以及一个能在用户浏览器里跑脚本的入口（ui:custom，自定义视图必需）。
		Permissions: []string{"entries:full", "feeds:read", "data", "export", "ui:custom"},
	}
}

// Contributions 三条界面贡献。Action 必须与 Actions() 里的 id 一致：
// 宿主 Invoke 会先核对「这个 surface 声明过这个 action」，对不上就点不动。
func (annotate) Contributions() []plugin.Contribution {
	return []plugin.Contribution{
		{
			ID: "highlight", Surface: plugin.SurfaceEntryReaderBody, Action: "highlight",
			Label: "高亮", Icon: "star", Selection: plugin.SelectionSingle,
			// 宿主据此失效装饰缓存：点了高亮，正文里立刻出现那一段
			Refresh: []string{"decorations"},
		},
		{
			ID: "note", Surface: plugin.SurfaceEntryReaderBody, Action: "note",
			Label: "写笔记", Icon: "sparkles", Selection: plugin.SelectionSingle,
			// 宿主按 Fields 弹输入框：没填就不发请求（Required）
			Fields:  []plugin.Field{{Key: "text", Label: "笔记", Type: "text", Required: true}},
			Refresh: []string{"decorations"},
		},
		{
			ID: "export", Surface: plugin.SurfaceEntryReaderToolbar, Action: "export",
			Label: "导出到 Obsidian", Icon: "download", Selection: plugin.SelectionSingle,
		},
	}
}

// Actions 自动化（规则）与界面直调共用的三个动作。
func (a annotate) Actions() []plugin.Action {
	st := a.store()
	return []plugin.Action{
		highlightAction{st: st},
		noteAction{st: st},
		exportAction{st: st},
	}
}

func (annotate) SettingsSections() []plugin.SettingsSection { return nil }
func (annotate) EntryProcessors() []plugin.EntryProcessor   { return nil }
func (annotate) FetchClassifiers() []plugin.FetchClassifier { return nil }

// Views 自定义视图：视图切换器里多一格「标注」，内容是沙箱 iframe 加载的 ui/index.html。
// custom 形态必须声明 ui:custom（见 Meta），否则宿主直接丢弃这条视图。
func (annotate) Views() []plugin.View {
	return []plugin.View{{
		ID: "annotations", Label: "标注", Icon: "star",
		Kind: plugin.ViewKindCustom, Entry: "index.html",
	}}
}

// Decorate 正文装饰：只声明「哪一段、什么样式」，怎么画由宿主决定。
// 偏移是 rune 下标（与 DecorateRequest.Text 同一份基准），存什么读什么、不改写。
func (a annotate) Decorate(_ context.Context, req plugin.DecorateRequest) ([]plugin.Decoration, error) {
	key := strconv.FormatInt(req.Entry.ID, 10)
	raw, ok := a.store().List(collectionAnnotations)[key]
	if !ok {
		return nil, nil
	}
	list, err := decodeAnnotations(raw)
	if err != nil {
		return nil, fmt.Errorf("annotate: 条目 %s 的标注坏了: %w", key, err)
	}
	out := make([]plugin.Decoration, 0, len(list))
	for i, item := range list {
		decoration := plugin.Decoration{
			Plugin: metaID,
			ID:     fmt.Sprintf("%s-%d", metaID, i+1),
			Start:  item.Start,
			End:    item.End,
			Style:  "highlight",
			Color:  item.Color,
		}
		if item.Note != "" {
			decoration.Data = map[string]string{"note": item.Note}
		}
		out = append(out, decoration)
	}
	return out, nil
}

//go:embed ui
var uiAssets embed.FS

// UIAssets 自带界面资源（根 = /ui/）。bridge.js 不必放进插件目录：SDK 统一发自己那份。
func (annotate) UIAssets() fs.FS {
	sub, err := fs.Sub(uiAssets, "ui")
	if err != nil {
		return nil
	}
	return sub
}
