package ai_test

import (
	"krss/backend/internal/service/ai"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseHTMLBlocks(t *testing.T) {
	html := `<div>
		<h1>Title</h1>
		<p>Paragraph 1</p>
		<p>Paragraph 2</p>
		<img src="test.png" />
		<figure><img src="f.png" /></figure>
	</div>`

	blocks, err := ai.ParseHTMLBlocks(html)
	require.NoError(t, err)
	require.Len(t, blocks, 5) // h1, p, p, img, figure
	require.Equal(t, "<h1>Title</h1>", blocks[0].HTML)
	require.True(t, blocks[0].NeedTranslate)
	require.False(t, blocks[3].NeedTranslate) // img
	require.False(t, blocks[4].NeedTranslate) // pure-img figure
}

func TestHTMLToText(t *testing.T) {
	html := `<div>
		<h1>Title</h1>
		<p>Paragraph 1. <br/>Line 2.</p>
	</div>`

	text := ai.HTMLToText(html)
	require.Contains(t, text, "Title")
	require.Contains(t, text, "Paragraph 1.")
	require.Contains(t, text, "Line 2.")
}

func TestReplaceRestoreMedia(t *testing.T) {
	html := `<p>Hello <img src="a.png"> world <video>v</video></p>`

	replaced, elements := ai.ReplaceMediaWithPlaceholders(html)
	require.Contains(t, replaced, ai.MediaPlaceholderPrefix)
	require.Len(t, elements, 2)

	restored := ai.RestoreMediaFromPlaceholders(replaced, elements)
	require.Equal(t, html, restored)
}

// ── 翻译破坏排版修复：wrapper 只在含块级子元素时才往里拆 ──────────────────

func TestParseHTMLBlocks_InlineDivsStaySeparate(t *testing.T) {
	// 两个只有文本的 div：各是一个叶子块，外层 <div> 必须留在 HTML 里，
	// 否则前端拼回去会把两行并成一行（用户报的「翻译后排版塌成一段」）。
	blocks, err := ai.ParseHTMLBlocks(`<div>line1</div><div>line2</div>`)
	require.NoError(t, err)
	require.Len(t, blocks, 2)
	require.Equal(t, "<div>line1</div>", blocks[0].HTML)
	require.Equal(t, "<div>line2</div>", blocks[1].HTML)
	require.True(t, blocks[0].NeedTranslate)
	require.True(t, blocks[1].NeedTranslate)
}

func TestParseHTMLBlocks_InlineMarkupKeptInOneBlock(t *testing.T) {
	// 只含内联标签的 div：整块一个，不能被拆成 "line1" / "<b>x</b>"
	blocks, err := ai.ParseHTMLBlocks(`<div>line1<b>x</b></div>`)
	require.NoError(t, err)
	require.Len(t, blocks, 1)
	require.Equal(t, "<div>line1<b>x</b></div>", blocks[0].HTML)
	require.True(t, blocks[0].NeedTranslate)
}

func TestParseHTMLBlocks_BlockChildrenExpanded(t *testing.T) {
	// 含块级子元素（p）的 div 要往里拆：得到两个 <p> 叶子块，p 整体保留
	blocks, err := ai.ParseHTMLBlocks(`<div><p>a</p><p>b</p></div>`)
	require.NoError(t, err)
	require.Len(t, blocks, 2)
	require.Equal(t, "<p>a</p>", blocks[0].HTML)
	require.Equal(t, "<p>b</p>", blocks[1].HTML)
}

func TestParseHTMLBlocks_NestedWrappersExpanded(t *testing.T) {
	// section 含块级子元素（div）→ 拆 section；每个 div 只含文本 → 各自一个叶子块
	blocks, err := ai.ParseHTMLBlocks(`<section><div>a</div><div>b</div></section>`)
	require.NoError(t, err)
	require.Len(t, blocks, 2)
	require.Equal(t, "<div>a</div>", blocks[0].HTML)
	require.Equal(t, "<div>b</div>", blocks[1].HTML)
}

func TestParseHTMLBlocks_ImageOnlyWrapperStillEmitted(t *testing.T) {
	// 只含图片的 div 没有块级子元素：整块保留，NeedTranslate=false，图片不能丢
	blocks, err := ai.ParseHTMLBlocks(`<div><img src="x.png"></div>`)
	require.NoError(t, err)
	require.Len(t, blocks, 1)
	require.Contains(t, blocks[0].HTML, "<img")
	require.Contains(t, blocks[0].HTML, "x.png")
	require.False(t, blocks[0].NeedTranslate)
}
