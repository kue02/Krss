package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"krss/backend/internal/plugin"
)

// annotation 一条标注（存进 store 的 JSON 形状；也是给未来宿主 API 的字段名）。
// start/end 是**rune 下标**、左闭右开（与 plugin.TextRange / Decoration 同口径）。
type annotation struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Color string `json:"color"`
	Note  string `json:"note"`
	// Text 选中的原文（56-34）。后端算偏移的纯文本与前端渲染的 textContent 可能差几个空白，
	// 只靠 offset 画会整体漂；前端有原文就按原文重新定位。
	Text string `json:"text,omitempty"`
}

// colorLabels 颜色 → 中文（导出 Markdown 用）。认不出的颜色原样显示，不猜。
var colorLabels = map[string]string{
	colorYellow: "黄色",
	colorBlue:   "蓝色",
}

func colorLabel(color string) string {
	if label, ok := colorLabels[color]; ok {
		return label
	}
	return color
}

func decodeAnnotations(raw string) ([]annotation, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var list []annotation
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, err
	}
	return list, nil
}

// loadAnnotations 读某条目全部标注；坏数据当空（不因为一条坏记录让整条正文画不出来）。
func loadAnnotations(st *store, entryID int64) []annotation {
	raw, ok := st.Get(collectionAnnotations, strconv.FormatInt(entryID, 10))
	if !ok {
		return nil
	}
	list, err := decodeAnnotations(raw)
	if err != nil {
		return nil
	}
	return list
}

func saveAnnotations(st *store, entryID int64, list []annotation) error {
	raw, err := json.Marshal(list)
	if err != nil {
		return fmt.Errorf("annotate: 序列化标注失败: %w", err)
	}
	return st.Set(collectionAnnotations, strconv.FormatInt(entryID, 10), string(raw))
}

// selectedEntry 界面直调只支持单条（贡献里写的是 SelectionSingle）。
func selectedEntry(selection plugin.Selection) (int64, error) {
	if len(selection.EntryIDs) == 0 {
		return 0, fmt.Errorf("没有选中条目")
	}
	return selection.EntryIDs[0], nil
}
