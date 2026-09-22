package ai

import (
	"strings"
	"testing"
)

func TestBlockHasInnerMarkup(t *testing.T) {
	cases := []struct {
		html string
		want bool
	}{
		{`<p>Just plain text here.</p>`, false},
		{`<h2>Plain heading</h2>`, false},
		{`<p>Text with <a href="x">link</a></p>`, true},
		{`<p>Text with <img src="x.png"></p>`, true},
		{`<p>With <strong>bold</strong></p>`, true},
		{`<p>Line<br>break</p>`, true},
		{`<ul><li>item</li></ul>`, true},
	}
	for _, c := range cases {
		if got := BlockHasInnerMarkup(c.html); got != c.want {
			t.Errorf("BlockHasInnerMarkup(%q) = %v, want %v", c.html, got, c.want)
		}
	}
}

func TestWrapFreeTranslation(t *testing.T) {
	got := WrapFreeTranslation(`<p class="x">Hello</p>`, "你好")
	if got != `<p class="x">你好</p>` {
		t.Errorf("got %q", got)
	}
	got = WrapFreeTranslation(`<h2>Hi</h2>`, "嗨")
	if got != "<h2>嗨</h2>" {
		t.Errorf("got %q", got)
	}
	// 没有外层标签 -> 纯文本转义
	got = WrapFreeTranslation(`plain text`, "a & b <tag>")
	if got != "a &amp; b &lt;tag&gt;" {
		t.Errorf("got %q", got)
	}
	// 多条块 -> 只用第一个外层标签
	got = WrapFreeTranslation("<p>a</p><p>b</p>", "甲")
	if !strings.HasPrefix(got, "<p>甲</p>") {
		t.Errorf("got %q", got)
	}
}
