package main

import (
	"fmt"
	"html"
	"regexp"
	"sort"
	"strings"
	"time"

	"krss/backend/internal/model"
)

// 导出格式（56-30 派工书口径）：
//
//	---
//	source: <entry.URL>
//	tags: [krss, annotate]
//	date: <YYYY-MM-DD>
//	---
//
//	# <title>
//
//	<正文纯文本>
//
//	## 标注
//	- 〔黄色〕第 1–5 字：Hello
//
// 区间按 start 排序；「第 x–y 字」用**人读的 1-based 闭区间**（start+1 … end），
// 存档里的 start/end 仍是插件契约的 rune 左闭右开。

var (
	tagPattern      = regexp.MustCompile(`(?s)<[^>]*>`)
	unsafeFilename  = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)
	whitespaceRun   = regexp.MustCompile(`\s+`)
	maxExcerptRunes = 40
	maxSlugRunes    = 60
)

func buildExportMarkdown(entry model.Entry, list []annotation, now time.Time) string {
	sorted := make([]annotation, len(list))
	copy(sorted, list)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Start < sorted[j].Start })

	text := plainText(deref(entry.Content))
	title := strings.TrimSpace(deref(entry.Title))
	if title == "" {
		title = "未命名条目"
	}

	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("source: " + strings.TrimSpace(deref(entry.URL)) + "\n")
	b.WriteString("tags: [krss, annotate]\n")
	b.WriteString("date: " + now.Format("2006-01-02") + "\n")
	b.WriteString("---\n\n")
	b.WriteString("# " + title + "\n\n")
	if text != "" {
		b.WriteString(text + "\n\n")
	}
	b.WriteString("## 标注\n")
	if len(sorted) == 0 {
		b.WriteString("- （还没有标注）\n")
	}
	for _, item := range sorted {
		fmt.Fprintf(&b, "- 〔%s〕第 %d–%d 字：%s\n",
			colorLabel(item.Color), item.Start+1, item.End, describeAnnotation(text, item))
	}
	return b.String()
}

// describeAnnotation 标注行的内容：优先截取原文那一段（读导出的人不用回原文找），
// 有笔记就补在后面。
func describeAnnotation(text string, item annotation) string {
	note := strings.TrimSpace(item.Note)
	piece := excerpt(text, item.Start, item.End)
	switch {
	case piece != "" && note != "" && note != piece:
		return truncateRunes(piece, maxExcerptRunes) + "（" + note + "）"
	case piece != "":
		return truncateRunes(piece, maxExcerptRunes)
	case note != "":
		return note
	default:
		return "…"
	}
}

// excerpt 按 rune 下标取原文片段；区间越界/为空返回空串（导出不该因为旧区间崩掉）。
func excerpt(text string, start, end int) string {
	runes := []rune(text)
	if start < 0 || start >= end || end > len(runes) {
		return ""
	}
	return strings.TrimSpace(string(runes[start:end]))
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

// plainText 把正文 HTML 变纯文本：去标签、解实体、空白折叠成单空格
// （偏移基准是宿主给的 Text，这里只用于导出展示）。
func plainText(content string) string {
	if strings.TrimSpace(content) == "" {
		return ""
	}
	text := tagPattern.ReplaceAllString(content, " ")
	text = html.UnescapeString(text)
	return strings.TrimSpace(whitespaceRun.ReplaceAllString(text, " "))
}

// slugify 文件名片段：清掉路径分隔符与 Windows 非法字符、空白并成 '-'、限长。
// 中文原样保留（文件名给人看，不追 ASCII slug）。
func slugify(title string, entryID int64) string {
	slug := unsafeFilename.ReplaceAllString(title, " ")
	slug = strings.Trim(strings.Join(strings.Fields(slug), "-"), "-.")
	slug = truncateRunes(slug, maxSlugRunes)
	slug = strings.TrimSuffix(slug, "…")
	if slug == "" {
		return fmt.Sprintf("entry-%d", entryID)
	}
	return slug
}
