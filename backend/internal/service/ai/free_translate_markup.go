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

// --- 带标记的块：逐文本段翻译，保住标记（49-2b） ---------------------------
//
// 背景：原来带内联标记的块**整块**交给模型（BlockHasInnerMarkup 为真就不走免费通道）。
// 于是模型不可达（本机 oMLX 没起）时，正文里凡是带 <b>/<a>/<ul>/<img> 的块全部失败、
// 静默留原文 —— 用户看到的就是「标题翻了、正文没翻」。
//
// 这里补第三条路：把块里的**文本节点**逐个抠出来，一次请求翻完，再按原树回填。
// 标记（标签、属性、图片、链接地址）一个都不动，只换文本。
// 于是「免费通道只吃纯文本」这条限制不再等于「带标记就只能靠模型」。

// 不参与翻译的容器：代码块翻了反而错；script/style 本就不该有正文。
var skipTranslateTags = map[string]bool{
	"script": true, "style": true, "noscript": true, "head": true,
	"meta": true, "link": true, "code": true, "pre": true, "kbd": true, "samp": true,
}

// segmentSep 是拼给免费通道的分隔符。用「不像自然语言」的串，翻译器一般原样保留；
// 万一被改写，调用方按数量对不上就会退化成整段包壳（见 ApplySegmentedTranslation）。
const segmentSep = "\n[[KRSS_SEP]]\n"

// SegmentTexts 取出块里可翻译的文本段（按文档顺序）。
// 全是空白/没有文本时返回 nil —— 调用方据此判断「这块没什么可翻的」。
func SegmentTexts(blockHTML string) []string {
	ctx := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(blockHTML), ctx)
	if err != nil {
		return nil
	}
	var out []string
	for _, n := range nodes {
		collectSegmentTexts(n, false, &out)
	}
	return out
}

func collectSegmentTexts(n *html.Node, skip bool, out *[]string) {
	if n == nil {
		return
	}
	if n.Type == html.ElementNode && skipTranslateTags[n.Data] {
		skip = true
	}
	if n.Type == html.TextNode && !skip {
		if text := strings.TrimSpace(n.Data); text != "" {
			*out = append(*out, text)
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		collectSegmentTexts(c, skip, out)
	}
}

// JoinSegments 把文本段拼成一次免费通道请求的载荷。
func JoinSegments(segments []string) string {
	return strings.Join(segments, segmentSep)
}

// SplitSegments 把译文按分隔符拆回去；数量对不上时第二个返回值为 false。
func SplitSegments(translated string, want int) ([]string, bool) {
	parts := strings.Split(translated, "[[KRSS_SEP]]")
	if len(parts) != want {
		return nil, false
	}
	out := make([]string, len(parts))
	for i, p := range parts {
		out[i] = strings.TrimSpace(p)
	}
	return out, true
}

// ApplySegmentedTranslation 把译文按原树回填：只替换文本节点，标签/属性/媒体原样保留。
// 数量对不上时返回 ok=false，调用方退化处理（整段包壳）。
func ApplySegmentedTranslation(blockHTML string, translated []string) (string, bool) {
	ctx := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(blockHTML), ctx)
	if err != nil {
		return "", false
	}

	var texts []*html.Node
	for _, n := range nodes {
		collectTextNodes(n, false, &texts)
	}
	if len(texts) != len(translated) {
		return "", false
	}
	for i, tn := range texts {
		// 译文本身是 TrimSpace 过的，这里把原文本节点两侧的空白补回去 —— 否则
		// `<p>See <a>this link</a> now</p>` 回填成 `See<a>…</a>now`（中文看不出，
		// 译成英文等需要词间空格的语种就明显错了）。
		lead, trail := surroundingSpace(tn.Data)
		tn.Data = lead + translated[i] + trail
	}

	var b strings.Builder
	for _, n := range nodes {
		if err := html.Render(&b, n); err != nil {
			return "", false
		}
	}
	return b.String(), true
}

// 空白切集：半角 + 全角空格（U+3000）+ 不换行空格（U+00A0）
const spaceCutset = " 	\r\n\u00a0\u3000"

// surroundingSpace 取出文本两侧的空白，回填时原样补回去。
func surroundingSpace(s string) (lead, trail string) {
	body := strings.TrimLeft(s, spaceCutset)
	lead = s[:len(s)-len(body)]
	core := strings.TrimRight(body, spaceCutset)
	trail = body[len(core):]
	return lead, trail
}

func collectTextNodes(n *html.Node, skip bool, out *[]*html.Node) {
	if n == nil {
		return
	}
	if n.Type == html.ElementNode && skipTranslateTags[n.Data] {
		skip = true
	}
	if n.Type == html.TextNode && !skip {
		if strings.TrimSpace(n.Data) != "" {
			*out = append(*out, n)
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		collectTextNodes(c, skip, out)
	}
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
