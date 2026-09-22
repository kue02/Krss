package ai

import (
	"fmt"
	stdhtml "html"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// 免费通道（Google / 有道）只接受纯文本，喂进去的 HTML 会被抹平：
// 段落标签、链接、加粗、图片全丢 —— 这就是「翻译破坏原文结构」的根因。
//
// 所以这里立两条规矩：
//  1. 块里只要还有内联标记（a/img/code/strong…），这个块就不走免费通道，交给模型（模型那条路会保护媒体占位符、保留 HTML）。
//  2. 纯文本块走免费通道时，译文要按原文的外层标签重新包回去（<p>…</p>、<h2>…</h2>），至少段落结构不能丢。

// BlockHasInnerMarkup 判断一个块内部是否还有元素节点（即除外层标签外的内联标记）。
func BlockHasInnerMarkup(blockHTML string) bool {
	ctx := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(blockHTML), ctx)
	if err != nil {
		// 解析不了就别冒险，交给模型
		return true
	}
	for _, n := range nodes {
		if n.Type != html.ElementNode {
			continue
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode {
				return true
			}
		}
	}
	return false
}

// WrapFreeTranslation 把免费通道的纯文本译文按原文外层标签包回去。
// 原文没有外层标签时，退化为转义后的纯文本。
func WrapFreeTranslation(originalHTML, translated string) string {
	ctx := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(originalHTML), ctx)
	if err != nil {
		return stdhtml.EscapeString(translated)
	}

	for _, n := range nodes {
		if n.Type != html.ElementNode || strings.TrimSpace(n.Data) == "" {
			continue
		}
		var b strings.Builder
		b.WriteString("<")
		b.WriteString(n.Data)
		for _, attr := range n.Attr {
			fmt.Fprintf(&b, " %s=%q", attr.Key, attr.Val)
		}
		b.WriteString(">")
		b.WriteString(stdhtml.EscapeString(translated))
		b.WriteString("</")
		b.WriteString(n.Data)
		b.WriteString(">")
		return b.String()
	}
	return stdhtml.EscapeString(translated)
}
