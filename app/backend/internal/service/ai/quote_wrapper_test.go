package ai_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/service/ai"
)

// 模型把引文块的外层 div 丢掉时，要按原文补回来（否则正文里引文没有样式）
func TestRestoreOuterWrapper_ModelDroppedWrapper(t *testing.T) {
	original := `<div class="rsshub-quote">Grok Bot: 现在可以用 1Password 了<br><br><img src="https://pbs.twimg.com/media/x.jpg"></div>`
	translated := `Grok Bot：现在可以使用 1Password 了<br><br><img src="https://pbs.twimg.com/media/x.jpg">`

	out := ai.RestoreOuterWrapper(original, translated)

	require.Contains(t, out, `<div class="rsshub-quote">`)
	require.Contains(t, out, "现在可以使用 1Password 了")
	require.Contains(t, out, "pbs.twimg.com/media/x.jpg")
	require.Equal(t, 1, countOccurrences(out, "rsshub-quote"))
}

// 译文自己已经带容器时不能套两层
func TestRestoreOuterWrapper_KeepsExistingWrapper(t *testing.T) {
	original := `<div class="rsshub-quote">作者: 正文</div>`
	translated := `<div class="rsshub-quote">作者：译文</div>`

	out := ai.RestoreOuterWrapper(original, translated)

	require.Equal(t, 1, countOccurrences(out, "rsshub-quote"))
	require.Equal(t, translated, out)
}

// 模型用 div + 属性略有差异地自己包了一层：剥掉重包，保证只留一层
func TestRestoreOuterWrapper_ReplacesModelWrapper(t *testing.T) {
	original := `<div class="rsshub-quote">作者: 正文</div>`
	translated := `<div class="rsshub-quote" data-x="1">作者：译文</div>`

	out := ai.RestoreOuterWrapper(original, translated)

	require.Equal(t, 1, countOccurrences(out, "rsshub-quote"), "只留一层容器")
	require.Contains(t, out, "作者：译文")
	require.NotContains(t, out, `data-x="1"`, "模型自己那层的属性应被剥掉")
}

// 普通段落不受影响
func TestRestoreOuterWrapper_PlainBlockUnchanged(t *testing.T) {
	original := `<p>hello</p>`
	translated := `<p>你好</p>`

	require.Equal(t, translated, ai.RestoreOuterWrapper(original, translated))
}

// blockquote 也算引文容器
func TestRestoreOuterWrapper_Blockquote(t *testing.T) {
	original := `<blockquote>author: body</blockquote>`
	translated := `作者：正文`

	out := ai.RestoreOuterWrapper(original, translated)

	require.Equal(t, `<blockquote>作者：正文</blockquote>`, out)
}

// 原文里 div 内的其它属性要带回去（有的源会加 style）
func TestRestoreOuterWrapper_KeepsAttributes(t *testing.T) {
	original := `<div class="rsshub-quote" style="color:red">作者: 正文</div>`
	translated := `作者：译文`

	out := ai.RestoreOuterWrapper(original, translated)

	require.Contains(t, out, `style="color:red"`)
	require.Contains(t, out, "作者：译文")
}

func countOccurrences(haystack, needle string) int {
	count := 0
	for i := 0; i+len(needle) <= len(haystack); {
		if haystack[i:i+len(needle)] == needle {
			count++
			i += len(needle)
			continue
		}
		i++
	}
	return count
}
