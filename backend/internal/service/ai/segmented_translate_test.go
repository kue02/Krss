package ai

import (
	"strings"
	"testing"
)

/**
 * 49-2b：带内联标记的块在只有免费通道时也要能翻出来。
 *
 * 原口径是「块里只要有内联标记就整块交给模型」—— 模型不可达（本机 oMLX 没起）时
 * 这些块全部失败、静默留原文，用户看到的就是「标题翻了、正文没翻」。
 * 新口径：把块里的**文本节点**逐个抠出来一次翻完、再按原树回填，标记一个不动。
 */

func TestSegmentTexts(t *testing.T) {
	cases := []struct {
		name string
		html string
		want []string
	}{
		{
			name: "行内标记：文本段按文档顺序抠出来",
			html: `<p>This is <b>bold</b> text</p>`,
			want: []string{"This is", "bold", "text"},
		},
		{
			name: "链接：只取锚文本，href 不参与翻译",
			html: `<p>See <a href="https://example.com/a">this link</a> now</p>`,
			want: []string{"See", "this link", "now"},
		},
		{
			name: "列表：每项一段",
			html: `<ul><li>First item</li><li>Second item</li></ul>`,
			want: []string{"First item", "Second item"},
		},
		{
			name: "纯文本块",
			html: `<p>Just plain text here.</p>`,
			want: []string{"Just plain text here."},
		},
		{
			name: "代码块不参与翻译",
			html: `<p>See <code>go build ./...</code> first</p>`,
			want: []string{"See", "first"},
		},
		{
			name: "pre 整块跳过",
			html: `<pre><code>SELECT 1;</code></pre><p>after</p>`,
			want: []string{"after"},
		},
		{
			name: "只有图片：没有可翻的文本",
			html: `<p><img src="a.png" alt=""></p>`,
			want: nil,
		},
	}
	for _, c := range cases {
		got := SegmentTexts(c.html)
		if len(got) != len(c.want) {
			t.Errorf("%s: SegmentTexts = %#v, want %#v", c.name, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: [%d] = %q, want %q", c.name, i, got[i], c.want[i])
			}
		}
	}
}

func TestApplySegmentedTranslationKeepsMarkup(t *testing.T) {
	original := `<p>This is <b>bold</b> text with <a href="https://example.com/x">a link</a></p>`
	segments := SegmentTexts(original)
	translated := []string{"这是", "加粗", "文字，带", "一个链接"}

	got, ok := ApplySegmentedTranslation(original, translated)
	if !ok {
		t.Fatal("ApplySegmentedTranslation 应成功")
	}

	// 关键：标记与链接地址一个都不能丢
	if !strings.Contains(got, "<b>加粗</b>") {
		t.Errorf("粗体标记没保住: %q", got)
	}
	if !strings.Contains(got, `href="https://example.com/x"`) {
		t.Errorf("链接地址没保住: %q", got)
	}
	if !strings.Contains(got, ">一个链接</a>") {
		t.Errorf("锚文本没换掉: %q", got)
	}
	if !strings.HasPrefix(got, "<p>") || !strings.HasSuffix(got, "</p>") {
		t.Errorf("外层段落标签丢了: %q", got)
	}
	if len(segments) != len(translated) {
		t.Errorf("段数 = %d, want %d", len(segments), len(translated))
	}
}

func TestApplySegmentedTranslationList(t *testing.T) {
	original := `<ul><li>First item</li><li>Second item</li></ul>`
	got, ok := ApplySegmentedTranslation(original, []string{"第一项", "第二项"})
	if !ok {
		t.Fatal("应成功")
	}
	want := `<ul><li>第一项</li><li>第二项</li></ul>`
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestApplySegmentedTranslationCountMismatch(t *testing.T) {
	// 分隔符被翻译器改写/吃掉时，数量对不上 ⇒ 必须报告失败，让调用方退化处理
	if _, ok := ApplySegmentedTranslation(`<p>a <b>b</b></p>`, []string{"只有一段"}); ok {
		t.Error("段数对不上时应当返回 ok=false")
	}
}

func TestJoinSplitSegmentsRoundTrip(t *testing.T) {
	segments := []string{"第一段", "second", "第三段"}
	joined := JoinSegments(segments)
	// 分隔符本身要带在载荷里，翻译器才可能原样保留
	if !strings.Contains(joined, "[[KRSS_SEP]]") {
		t.Errorf("载荷里没有分隔符: %q", joined)
	}

	// 翻译器原样保留分隔符 -> 正常拆回
	parts, ok := SplitSegments("第一段\n[[KRSS_SEP]]\nsecond\n[[KRSS_SEP]]\n第三段", 3)
	if !ok {
		t.Fatal("应当拆得开")
	}
	for i := range segments {
		if parts[i] != segments[i] {
			t.Errorf("[%d] = %q, want %q", i, parts[i], segments[i])
		}
	}

	// 分隔符被吃掉 -> 数量对不上，报告失败
	if _, ok := SplitSegments("第一段 second 第三段", 3); ok {
		t.Error("分隔符没了应当返回 ok=false")
	}
}

func TestSegmentTextsEscapesInOutput(t *testing.T) {
	// 回填时由 html.Render 负责转义，别把原文里的 & < > 弄坏
	original := `<p>a &amp; b <em>c</em></p>`
	got, ok := ApplySegmentedTranslation(original, []string{"甲 & 乙", "丙"})
	if !ok {
		t.Fatal("应成功")
	}
	if !strings.Contains(got, "甲 &amp; 乙") {
		t.Errorf("译文里的 & 应当被转义: %q", got)
	}
	if !strings.Contains(got, "<em>丙</em>") {
		t.Errorf("标记没保住: %q", got)
	}
}

func TestSurroundingSpace(t *testing.T) {
	cases := []struct {
		in          string
		lead, trail string
	}{
		{"See ", "", " "},
		{" now", " ", ""},
		{"\n  text \t", "\n  ", " \t"},
		{"没有空白", "", ""},
		{"\u3000全角\u3000", "\u3000", "\u3000"},
	}
	for _, c := range cases {
		lead, trail := surroundingSpace(c.in)
		if lead != c.lead || trail != c.trail {
			t.Errorf("surroundingSpace(%q) = (%q, %q), want (%q, %q)", c.in, lead, trail, c.lead, c.trail)
		}
	}
}

/**
 * 词间空格必须补回去：译文是 TrimSpace 过的，若不还原原文本节点的两侧空白，
 * `<p>See <a>this link</a> now</p>` 会回填成 `See<a>…</a>now`。
 * 中文看不出，但译成英文这种需要词间空格的语种就是明显的排版错误。
 */
func TestApplySegmentedTranslationKeepsSpacing(t *testing.T) {
	original := `<p>See <a href="https://example.com/a">this link</a> now</p>`
	got, ok := ApplySegmentedTranslation(original, []string{"See", "this link", "now"})
	if !ok {
		t.Fatal("应成功")
	}
	if !strings.Contains(got, "See <a") {
		t.Errorf("链接前的空格丢了: %q", got)
	}
	if !strings.Contains(got, "</a> now") {
		t.Errorf("链接后的空格丢了: %q", got)
	}
}
