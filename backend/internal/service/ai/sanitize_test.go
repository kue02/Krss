package ai

import (
	"strings"
	"testing"
)

func TestSanitizeModelOutput(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "去掉行首豆腐块",
			in:   "□Switch inserts your coding agent into the channel your team already uses.",
			want: "Switch inserts your coding agent into the channel your team already uses.",
		},
		{
			name: "去掉行首替换字符与空白",
			in:   "  \uFFFD\uFFFD hello",
			want: "hello",
		},
		{
			name: "去掉模型特殊 token（半角）",
			in:   "<|endoftext|>你好",
			want: "你好",
		},
		{
			name: "去掉模型特殊 token（全角竖线）",
			in:   "<｜begin▁of▁sentence｜>你好世界",
			want: "你好世界",
		},
		{
			name: "去掉 BOM",
			in:   "\uFEFF你好",
			want: "你好",
		},
		{
			name: "去掉控制字符但保留换行",
			in:   "第一行\x00\n第二行\x07",
			want: "第一行\n第二行",
		},
		{
			name: "HTML 块里紧贴开标签的豆腐块也清掉",
			in:   "<p>□Switch inserts your agent.</p>",
			want: "<p>Switch inserts your agent.</p>",
		},
		{
			name: "正文中间的合法方框字符不要误伤",
			in:   "选项 A □ 选项 B",
			want: "选项 A □ 选项 B",
		},
		{
			name: "正常中文译文原样通过",
			in:   "这是正常的中文译文。",
			want: "这是正常的中文译文。",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SanitizeModelOutput(tc.in); got != tc.want {
				t.Fatalf("SanitizeModelOutput(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestIsUntranslatedText(t *testing.T) {
	const english = "Switch inserts your coding agent into the channel your team already uses every single day."

	cases := []struct {
		name       string
		original   string
		translated string
		language   string
		want       bool
	}{
		{
			name:       "英文原文照抄 → 判未翻译",
			original:   english,
			translated: english,
			language:   "zh-CN",
			want:       true,
		},
		{
			name:       "空译文 → 判无效",
			original:   english,
			translated: "   ",
			language:   "zh-CN",
			want:       true,
		},
		{
			name:       "正常中文译文 → 通过",
			original:   english,
			translated: "Switch 把你的编码代理接入团队已经在用的那个频道，方便大家协作。",
			language:   "zh-CN",
			want:       false,
		},
		{
			name:       "目标语言非中文 → 不判",
			original:   english,
			translated: english,
			language:   "ja",
			want:       false,
		},
		{
			name:       "原文几乎没拉丁字母（已是中文）→ 不判",
			original:   "这是中文原文。",
			translated: "这是中文原文。",
			language:   "zh-CN",
			want:       false,
		},
		{
			name:       "代码块原样返回 → 不判（避免误伤无法翻译的代码）",
			original:   "const value = compute({ a: 1, b: 2 });\nif (value >= threshold) { return value; }",
			translated: "const value = compute({ a: 1, b: 2 });\nif (value >= threshold) { return value; }",
			language:   "zh-CN",
			want:       false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsUntranslatedText(tc.original, tc.translated, tc.language); got != tc.want {
				t.Fatalf("IsUntranslatedText() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIsUntranslatedHTML(t *testing.T) {
	english := "<p>Switch inserts your coding agent into the channel your team already uses every single day.</p>"
	if !IsUntranslatedHTML(english, english, "zh-CN") {
		t.Fatal("expected kept-English HTML to be judged untranslated")
	}
	zh := "<p>Switch 把你的编码代理接入团队已经在用的那个频道，方便大家协作。</p>"
	if IsUntranslatedHTML(english, zh, "zh-CN") {
		t.Fatal("expected proper Chinese HTML translation to pass")
	}
}

func TestSpecialTokenRegexDoesNotEatNormalTags(t *testing.T) {
	// 普通 HTML 标签不应被特殊 token 正则误删。
	in := "<p>hello</p>"
	if got := SanitizeModelOutput(in); strings.Contains(got, "<|") || got != in {
		t.Fatalf("normal HTML should be untouched, got %q", got)
	}
}
