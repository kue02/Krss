package service

import (
	"strings"

	"golang.org/x/net/html"
)

// 47-4（用户 2026-10-12）：过滤条件的「纯文本命中」这一路。
//
// 背景：`entries.content` 存的是**原始 HTML**，而 `matchText` 原来只对原始 HTML 做
// `strings.Contains`。RSSHub / Telegram 这类源会把话题标签包成链接 ——
// 渲染出来是「🥰 #机场 #推广」，库里却是
// `<tg-emoji …><span class="emoji">🥰</span></tg-emoji> <a href="…">#机场</a> <a href="…">#推广</a>`
// ⇒ 带空格 / 跨标签的值**永远命中不了**（实测该条目 `like '%#机场 #推广%'` 为 0 行，
// 而单个 `%#机场%` / `%#推广%` 各有 5 / 10 行）。
//
// 口径（用户拍板）：文本条件**同时匹配原始 HTML 与去标签纯文本，任一命中即算** ——
// 旧规则按 HTML 匹配的行为完全不变，跨标签的写法开始能命中。

// collapseSpace 把任意空白序列压成一个空格并去掉首尾（`&nbsp;` 解出来的 U+00A0 也会被压掉）。
func collapseSpace(input string) string {
	return strings.Join(strings.Fields(input), " ")
}

// plainTextBlockTags 这些标签在「正文读起来的样子」里要换行（前后各补一个换行，
// 随后统一压成单空格）—— 否则 `<p>🥰</p><p>#机场</p>` 会连成「🥰#机场」，
// 而用户写的条件值「🥰 #机场」就永远对不上。
var plainTextBlockTags = map[string]bool{
	"p": true, "div": true, "br": true, "hr": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
	"li": true, "tr": true, "table": true, "ul": true, "ol": true,
	"blockquote": true, "section": true, "article": true,
	"pre": true, "figure": true, "figcaption": true,
}

// plainTextSkipTags 这些标签的内容不是正文（与 ai 侧的 extractText 同口径）。
var plainTextSkipTags = map[string]bool{
	"script": true, "style": true, "noscript": true,
	"head": true, "meta": true, "link": true, "title": true,
}

// htmlToPlain 原始正文 → 「正文读起来的样子」。
//
// **不复用 `ai.HTMLToText`**：那一份是喂给模型的，会在相邻两个文本节点之间主动插一个空格
// （`<p>现价：<b>¥0.00</b></p>` → `现价： ¥0.00`），于是库里那条既有规则
// 「现价：¥0.00」在纯文本这一路上反而对不上。这里要的是「标签拿掉、文字按原样连起来」：
// 文本节点直接拼接（内联标签不插空格），块级标签与 `<br>` 换成换行，最后统一压空白。
//
// 走 `golang.org/x/net/html` 正规解析而不是正则剥标签：实体解码（`&amp;` / `&#39;`）、
// 属性里的 `>`、`<script>` 里的伪标签都由解析器兜住。
func htmlToPlain(input string) string {
	if !strings.Contains(input, "<") {
		return collapseSpace(input)
	}

	doc, err := html.Parse(strings.NewReader(input))
	if err != nil {
		// 解析不了就退回粗剥（宁可少命中一条，也不要让规则整条失效）
		return collapseSpace(stripAngleTags(input))
	}

	var builder strings.Builder
	var walk func(node *html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.ElementNode {
			if plainTextSkipTags[node.Data] {
				return
			}
			if plainTextBlockTags[node.Data] {
				builder.WriteString("\n")
			}
		}
		if node.Type == html.TextNode {
			builder.WriteString(node.Data)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
		if node.Type == html.ElementNode && plainTextBlockTags[node.Data] {
			builder.WriteString("\n")
		}
	}
	walk(doc)

	return collapseSpace(builder.String())
}

// stripAngleTags 兜底用：把尖括号包起来的部分全部丢掉。
func stripAngleTags(input string) string {
	var builder strings.Builder
	depth := 0
	for _, r := range input {
		switch r {
		case '<':
			depth++
		case '>':
			if depth > 0 {
				depth--
			}
		default:
			if depth == 0 {
				builder.WriteRune(r)
			}
		}
	}
	return builder.String()
}

// textToPlain 惰性纯文本：没带 `<` 的字段（作者 / 源名 / 分类名）本来就是纯文本，直接压空白即可。
func textToPlain(input string) string {
	return htmlToPlain(input)
}

// plainTextCache 同一次 `MatchConditions` 里的纯文本结果备忘。
//
// 一条条目可能带多个 content/title 条件；解析一遍 HTML 不该为每个条件重复付这份开销。
// 且只在该条件**原始 HTML 没命中**时才真正去算（绝大多数规则走的还是原来那条快路）。
type plainTextCache struct {
	titleReady   bool
	titlePlain   string
	contentReady bool
	contentPlain string
	authorReady  bool
	authorPlain  string
}

func (c *plainTextCache) titleOf(raw string) string {
	if !c.titleReady {
		c.titlePlain = textToPlain(raw)
		c.titleReady = true
	}
	return c.titlePlain
}

func (c *plainTextCache) contentOf(raw string) string {
	if !c.contentReady {
		c.contentPlain = textToPlain(raw)
		c.contentReady = true
	}
	return c.contentPlain
}

func (c *plainTextCache) authorOf(raw string) string {
	if !c.authorReady {
		c.authorPlain = textToPlain(raw)
		c.authorReady = true
	}
	return c.authorPlain
}