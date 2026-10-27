package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"krss/backend/internal/plugin"
)

// 三个动作共用一套骨架：
//   - Action 接口（ID/Label/Fields/Execute）给自动化规则用，Execute 是空实现 —— 这几个能力
//     是「人在界面上点」的，规则命中时没有选区可用，真跑只会报错；
//   - Invoker（Invoke）给界面直调用，宿主按 contribution.action 找到这里；
//   - 插件不直接写库、不发网络请求：只动自己的 annotations 集合。

// highlightAction 把选中的区间涂黄。
type highlightAction struct{ st *store }

func (highlightAction) ID() string                                          { return "highlight" }
func (highlightAction) Label() string                                       { return "高亮" }
func (highlightAction) Fields() []plugin.Field                              { return nil }
func (highlightAction) Execute(context.Context, plugin.ActionRequest) error { return nil }

func (a highlightAction) Invoke(_ context.Context, req plugin.InvokeRequest) (plugin.InvokeResult, error) {
	return addAnnotation(a.st, req, colorYellow, "", "已高亮")
}

// noteAction 记一条带文字的笔记（颜色蓝，和纯高亮区分开）。
type noteAction struct{ st *store }

func (noteAction) ID() string                                          { return "note" }
func (noteAction) Label() string                                       { return "写笔记" }
func (noteAction) Fields() []plugin.Field                              { return nil }
func (noteAction) Execute(context.Context, plugin.ActionRequest) error { return nil }

func (a noteAction) Invoke(_ context.Context, req plugin.InvokeRequest) (plugin.InvokeResult, error) {
	note := strings.TrimSpace(req.Config["text"])
	if note == "" {
		return plugin.InvokeResult{}, fmt.Errorf("先写笔记")
	}
	return addAnnotation(a.st, req, colorBlue, note, "已记笔记")
}

// exportAction 把该条目的标注 + 正文导出成一份 Markdown（Obsidian frontmatter 起手）。
type exportAction struct{ st *store }

func (exportAction) ID() string                                          { return "export" }
func (exportAction) Label() string                                       { return "导出到 Obsidian" }
func (exportAction) Fields() []plugin.Field                              { return nil }
func (exportAction) Execute(context.Context, plugin.ActionRequest) error { return nil }

func (a exportAction) Invoke(_ context.Context, req plugin.InvokeRequest) (plugin.InvokeResult, error) {
	entryID, err := selectedEntry(req.Selection)
	if err != nil {
		return plugin.InvokeResult{}, err
	}
	if len(req.Entries) == 0 {
		// 宿主按 entries:full 权限补 req.Entries；没有条目就没有正文与标题可导
		return plugin.InvokeResult{}, fmt.Errorf("没有选中条目")
	}
	entry := req.Entries[0]
	if entry.ID == 0 {
		entry.ID = entryID
	}

	now := time.Now()
	markdown := buildExportMarkdown(entry, loadAnnotations(a.st, entryID), now)
	filename := fmt.Sprintf("krss/%s %s.md", now.Format("2006-01-02"), slugify(deref(entry.Title), entryID))
	return plugin.InvokeResult{
		Message: "已导出",
		Level:   "success",
		Files: []plugin.ExportFile{{
			Filename: filename,
			Content:  markdown,
			MIME:     "text/markdown",
		}},
	}, nil
}

// addAnnotation 三个动作共用的「追加一条标注」：先校验选区，再读改写。
// 失败一律**不落库**（界面上的空装饰比报错更难查）。
func addAnnotation(st *store, req plugin.InvokeRequest, color, note, message string) (plugin.InvokeResult, error) {
	entryID, err := selectedEntry(req.Selection)
	if err != nil {
		return plugin.InvokeResult{}, err
	}
	span := req.Selection.TextRange
	if span == nil || span.End <= span.Start {
		return plugin.InvokeResult{}, fmt.Errorf("先选中文字")
	}
	if span.Start < 0 {
		return plugin.InvokeResult{}, fmt.Errorf("选中区间不合法（start=%d）", span.Start)
	}

	list := loadAnnotations(st, entryID)
	list = append(list, annotation{
		Start: span.Start,
		End:   span.End,
		Color: color,
		Note:  note,
		// 选中原文一起存：前端据此重新定位，避免偏移基准不同导致高亮漂（56-34）
		Text: span.Text,
	})
	if err := saveAnnotations(st, entryID, list); err != nil {
		return plugin.InvokeResult{}, err
	}
	return plugin.InvokeResult{
		Message: message,
		Level:   "success",
		Refresh: []string{"decorations"},
	}, nil
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
