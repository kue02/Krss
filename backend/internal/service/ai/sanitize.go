package ai

import (
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ErrUntranslatedTargetLanguage 表示模型兜底输出经判定「没有任何目标语言译文」。
// 调用方应据此判定该次翻译失败（不落库、不推流），而不是把「□ + 原文」写进缓存。
var ErrUntranslatedTargetLanguage = errors.New("model output was not translated into the target language")

var (
	// 模型特殊 token：<|...|> 与全角竖线变体 <｜...｜>（如 <｜endoftext｜>）。
	specialTokenRe = regexp.MustCompile(`<[|｜][^<>]{0,80}[|｜]>`)
	// 控制字符（保留 \t \n \r）。
	controlCharRe = regexp.MustCompile(`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`)
	// 紧跟在开标签之后、或整段开头的替换字符 / 豆腐块（HTML 块翻译里常见的「<p>□原文」）。
	junkAfterOpenRe = regexp.MustCompile("(^|>)[\uFFFD\u25A1]+")
	// 媒体占位符（{{__MEDIA_PLACEHOLDER_0__}}）与 URL 不是自然语言，不能算作「原文有大量拉丁字母」。
	mediaPlaceholderRe = regexp.MustCompile(`\{\{[^{}]*\}\}`)
	urlRe              = regexp.MustCompile(`(?i)\b(?:https?://|www\.)\S+`)
)

// SanitizeModelOutput 清洗模型兜底输出里的「非译文垃圾」：
//   - 模型特殊 token（<|...|> / <｜...｜>）
//   - BOM（U+FEFF）
//   - 控制字符（保留换行/制表符）
//   - 行首的替换字符 U+FFFD、豆腐块 U+25A1「□」
//   - 开标签后紧跟的替换字符 / 豆腐块（HTML 块翻译时「<p>□原文」形态）
//
// 刻意只清理**行首 / 标签开头**的异常字符，不动正文中间合法的方框字符（如列表符号）。
func SanitizeModelOutput(s string) string {
	if s == "" {
		return s
	}
	s = specialTokenRe.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "\uFEFF", "")
	s = controlCharRe.ReplaceAllString(s, "")

	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = trimLeadingJunk(line)
	}
	s = strings.Join(lines, "\n")

	// HTML 块翻译：「<p>□正文」这种紧贴开标签的垃圾也清掉。
	s = junkAfterOpenRe.ReplaceAllString(s, "$1")
	return s
}

// trimLeadingJunk 去掉一行开头（允许前面有空白）的替换字符 / 豆腐块。
// 只有行首确实出现这些异常字符时才动，避免误删正常的缩进。
func trimLeadingJunk(line string) string {
	runes := []rune(line)
	j := 0
	for j < len(runes) && unicode.IsSpace(runes[j]) {
		j++
	}
	if j >= len(runes) {
		return line
	}
	if !isJunkRune(runes[j]) {
		return line
	}
	i := j
	for i < len(runes) && (isJunkRune(runes[i]) || unicode.IsSpace(runes[i])) {
		i++
	}
	return string(runes[i:])
}

func isJunkRune(r rune) bool {
	return r == '\uFFFD' || r == '\u25A1' || r == '\uFEFF'
}

// isCJKTargetLanguage 判断目标语言是否为中日韩（当前主要关心中文）。
func isCJKTargetLanguage(language string) bool {
	return strings.HasPrefix(strings.ToLower(language), "zh")
}

// countCJK 统计中日韩字符数量（汉字 / 假名 / 谚文 / 兼容汉字）。
func countCJK(s string) int {
	n := 0
	for _, r := range s {
		switch {
		case r >= 0x4E00 && r <= 0x9FFF, // CJK Unified Ideographs
			r >= 0x3400 && r <= 0x4DBF, // CJK Extension A
			r >= 0xF900 && r <= 0xFAFF, // CJK Compatibility Ideographs
			r >= 0x3040 && r <= 0x30FF, // Hiragana + Katakana
			r >= 0xAC00 && r <= 0xD7AF: // Hangul Syllables
			n++
		}
	}
	return n
}

// countLatin 统计拉丁字母数量（用来判断原文是否「大量拉丁字母」）。
func countLatin(s string) int {
	n := 0
	for _, r := range s {
		if unicode.IsLetter(r) && unicode.In(r, unicode.Latin) {
			n++
		}
	}
	return n
}

// looksLikeCode 粗略判断一段文本更像代码/标记而不是自然语言散文。
// 这类内容本来就没什么可翻译（目标语言是中文时译文里没有汉字很正常），
// 不能用「未翻译」判定把它误伤成失败、拖垮整篇翻译。
func looksLikeCode(s string) bool {
	nonSpace := 0
	codePunct := 0
	for _, r := range s {
		if unicode.IsSpace(r) {
			continue
		}
		nonSpace++
		if strings.ContainsRune("{}[];=<>()\\/|&*#@$%`~^", r) {
			codePunct++
		}
	}
	return nonSpace > 0 && float64(codePunct)/float64(nonSpace) > 0.08
}

// stripNonProse 去掉媒体占位符和 URL —— 它们不是自然语言，
// 直接参与拉丁字母统计会把「一条只有图片/链接的块」误判成「大段英文没翻译」。
func stripNonProse(s string) string {
	s = mediaPlaceholderRe.ReplaceAllString(s, " ")
	s = urlRe.ReplaceAllString(s, " ")
	return s
}

// IsUntranslatedText 判断「目标语言是中文时，译文几乎不含中日韩字符、而原文有大量拉丁字母」，
// 即模型明显没翻译（把原文照抄回来）。原文拉丁字母太少（如短标题）时无法可靠判断，返回 false。
func IsUntranslatedText(original, translated, language string) bool {
	if !isCJKTargetLanguage(language) {
		return false
	}
	orig := strings.TrimSpace(original)
	trans := strings.TrimSpace(translated)
	if trans == "" {
		// 原文非空、译文为空 —— 视为无效输出。
		return orig != ""
	}
	// 短文本（短标题、图片说明、纯链接/占位符）统计不稳定，宁可不判，避免误伤把整篇拖垮。
	prose := strings.TrimSpace(stripNonProse(orig))
	if utf8.RuneCountInString(prose) < 40 {
		return false
	}
	latinOrig := countLatin(prose)
	if latinOrig < 20 {
		// 原文没什么拉丁字母（可能已是中文），不判未翻译。
		return false
	}
	if looksLikeCode(prose) {
		// 代码块 / 标记片段：没有可翻译的自然语言，跳过判定。
		return false
	}
	cjk := countCJK(trans)
	if cjk == 0 {
		return true
	}
	// 正常中文译文的中日韩字符量应远高于原文拉丁字母的 1/10；
	// 低于这个比例说明译文仍以拉丁（原文）为主。
	return float64(cjk) < float64(latinOrig)*0.1
}

// IsUntranslatedHTML 是 IsUntranslatedText 的 HTML 版本：先抽纯文本再判断。
func IsUntranslatedHTML(originalHTML, translatedHTML, language string) bool {
	return IsUntranslatedText(HTMLToText(originalHTML), HTMLToText(translatedHTML), language)
}
