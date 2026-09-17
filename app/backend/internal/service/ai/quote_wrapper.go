package ai

import (
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// quoteWrapperTags 会被我们兜住的外层容器：引文块。
// RSSHub 的引用推文放在 <div class="rsshub-quote">，别的源偶尔用 <blockquote>。
var quoteWrapperClasses = []string{"rsshub-quote"}

// RestoreOuterWrapper 保证译文仍带着原文最外层那个容器。
//
// 为什么需要：引文块的 HTML 是 <div class="rsshub-quote">作者: 正文 <img>…</div>，
// 交给模型翻译时它经常把外面的 div 当成排版噪声丢掉（图片、<br> 都留着），
// 结果正文里就再也看不出哪段是引文（用户报的「点进去引文没样式」）。
// 这里按原文把容器补回去；译文自己已经带了这个容器就先剥掉，免得套两层。
func RestoreOuterWrapper(originalHTML, translatedHTML string) string {
	openTag, closeTag, ok := quoteWrapperTags(originalHTML)
	if !ok {
		return translatedHTML
	}

	// 译文自己保留了容器：原样返回
	if strings.Contains(translatedHTML, openTag) && strings.Contains(translatedHTML, closeTag) {
		return translatedHTML
	}

	inner := stripWrapperTags(translatedHTML, openTag, closeTag)
	return openTag + inner + closeTag
}

// quoteWrapperTags 取出原文最外层容器（仅限引文类容器）的开闭标签。
func quoteWrapperTags(originalHTML string) (string, string, bool) {
	ctx := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(originalHTML), ctx)
	if err != nil {
		return "", "", false
	}

	for _, n := range nodes {
		if n.Type != html.ElementNode {
			continue
		}
		if !isQuoteWrapper(n) {
			return "", "", false
		}

		var b strings.Builder
		b.WriteString("<")
		b.WriteString(n.Data)
		for _, attr := range n.Attr {
			if attr.Key == "" {
				continue
			}
			b.WriteString(" ")
			b.WriteString(attr.Key)
			b.WriteString(`="`)
			b.WriteString(htmlEscapeAttr(attr.Val))
			b.WriteString(`"`)
		}
		b.WriteString(">")

		return b.String(), "</" + n.Data + ">", true
	}

	return "", "", false
}

func isQuoteWrapper(n *html.Node) bool {
	if n.DataAtom == atom.Blockquote {
		return true
	}
	if n.DataAtom != atom.Div {
		return false
	}
	for _, attr := range n.Attr {
		if attr.Key != "class" {
			continue
		}
		for _, class := range strings.Fields(attr.Val) {
			for _, want := range quoteWrapperClasses {
				if class == want {
					return true
				}
			}
		}
	}
	return false
}

// stripWrapperTags 去掉译文里模型可能自己留下的同款容器标签（含属性差异）。
func stripWrapperTags(s, openTag, closeTag string) string {
	out := s
	if idx := strings.Index(out, openTag); idx >= 0 {
		// 找到该开标签的实际结尾（可能带别的属性）
		if end := strings.Index(out[idx:], ">"); end >= 0 {
			out = out[:idx] + out[idx+end+1:]
		}
	} else if idx := strings.Index(out, `<div`); idx >= 0 {
		// 模型用了 div 但属性不同
		if end := strings.Index(out[idx:], ">"); end >= 0 {
			candidate := out[idx : idx+end+1]
			if strings.Contains(candidate, "rsshub-quote") {
				out = out[:idx] + out[idx+end+1:]
			}
		}
	}
	out = strings.Replace(out, closeTag, "", 1)
	return out
}

func htmlEscapeAttr(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", `"`, "&quot;")
	return replacer.Replace(value)
}
