package service

import (
	"context"
	"sort"
	"sync"
	"time"

	"krss/backend/internal/plugin"
	"krss/backend/pkg/logger"
)

// 56-21 正文装饰聚合。设计口径：**装饰是锦上添花，读正文是主路径**。
// 所以单个插件 300ms 超时、出错/超时只跳过并留日志 —— 任何插件都不许把阅读卡住。

// decorationTimeout 单个装饰插件的时间上限（并发跑，总耗时≈最慢那个的上限）。
const decorationTimeout = 300 * time.Millisecond

// Decorations 聚合所有启用插件的装饰。
//   - 没挂条目读端 / 条目查不到 ⇒ 空数组不报错（正文照样能读，只是没有装饰）；
//   - 递进来的是 `entry.Content` 剥掉标签后的纯文本，插件的 start/end 就按它（rune 计数）；
//   - 单个插件 300ms 超时、报错、区间越界 ⇒ 丢弃这家并 warn，其余照常；
//   - 结果按 (plugin, start, end) 稳定排序，并注入 Plugin 字段。
//
// 与 Contributions 不同，这条**不做** ensureBuiltin/ensureExternal：它是「每读一条都要算」的热路径，
// 不该在读正文时写库或扫插件目录（启停位在启动时 Catalog 那条链已装载）。
func (s *pluginService) Decorations(ctx context.Context, entryID int64) ([]plugin.Decoration, error) {
	decorators := s.registry.Decorators()
	if len(decorators) == 0 || s.entries == nil {
		return []plugin.Decoration{}, nil
	}

	entry, err := s.entries.GetByID(ctx, entryID)
	if err != nil {
		logger.Warn("entry decorations lookup failed",
			"module", "service", "action", "decorate", "resource", "entry", "result", "skipped",
			"entry", entryID, "error", err)
		return []plugin.Decoration{}, nil
	}

	// 偏移基准：正文纯文本。用仓库既有的 htmlToPlain（`internal/service/filter_text.go`，
	// 过滤条件的「纯文本命中」同一份口径）—— 文本节点直接拼接、块级标签当空白、最后压成单空格。
	// 插件收到的 Text 与这里校验用的 runeLen 是同一份字符串，前端按同一规则渲染即可对齐。
	text := ""
	if entry.Content != nil {
		text = htmlToPlain(*entry.Content)
	}
	runes := []rune(text)
	req := plugin.DecorateRequest{Entry: entry, Text: text}

	// 各插件并发跑：互不等待，谁慢谁自己超时；结果按注册表顺序落到自己的槽位（不用加锁）。
	results := make([][]plugin.Decoration, len(decorators))
	var wg sync.WaitGroup
	for i, named := range decorators {
		wg.Add(1)
		go func(i int, named plugin.NamedDecorator) {
			defer wg.Done()
			callCtx, cancel := context.WithTimeout(ctx, decorationTimeout)
			defer cancel()
			items, err := named.Decorator.Decorate(callCtx, req)
			if err != nil {
				logger.Warn("plugin decorate failed",
					"module", "service", "action", "decorate", "resource", "plugin", "result", "skipped",
					"pluginId", named.PluginID, "entry", entryID, "error", err)
				return
			}
			results[i] = sanitizeDecorations(named.PluginID, items, runes)
		}(i, named)
	}
	wg.Wait()

	out := make([]plugin.Decoration, 0, len(decorators))
	for _, items := range results {
		out = append(out, items...)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Plugin != out[j].Plugin {
			return out[i].Plugin < out[j].Plugin
		}
		if out[i].Start != out[j].Start {
			return out[i].Start < out[j].Start
		}
		return out[i].End < out[j].End
	})
	return out, nil
}

// sanitizeDecorations 校验插件报的区间并注入归属插件。
// 越界（负 start / 空区间 / 超出文本长度）一律丢弃并 warn：宁可少画一段，
// 也不能让前端按坏区间去切字符串（切出来是乱码或 panic）。这里不截断——截断等于替插件改意思。
//
// text 是偏移基准的正文纯文本（rune 切片）。对通过校验的区间：
// 宿主替插件补原文锚点 data.text（= text[start:end]），供前端 reanchor 使用 ——
// 前端只有拿到这段原文才能纠正 offset 偏差，否则多段落正文会漂。插件自带 text 不覆盖。
func sanitizeDecorations(pluginID string, items []plugin.Decoration, text []rune) []plugin.Decoration {
	runeLen := len(text)
	out := make([]plugin.Decoration, 0, len(items))
	for _, item := range items {
		reason := ""
		switch {
		case item.Start < 0:
			reason = "negative start"
		case item.End <= item.Start:
			reason = "empty range"
		case item.End > runeLen:
			reason = "range beyond text"
		}
		if reason != "" {
			logger.Warn("plugin decoration dropped",
				"module", "service", "action", "decorate", "resource", "decoration", "result", "dropped",
				"pluginId", pluginID, "id", item.ID, "start", item.Start, "end", item.End,
				"textRunes", runeLen, "reason", reason)
			continue
		}
		item.Plugin = pluginID
		// 宿主替插件补原文锚点，供前端 reanchor 使用（插件自带 text 时不覆盖）。
		if item.Data == nil {
			item.Data = map[string]string{}
		}
		if item.Data["text"] == "" {
			item.Data["text"] = string(text[item.Start:item.End])
		}
		out = append(out, item)
	}
	return out
}
