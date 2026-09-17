package ai_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"gist/backend/internal/service/ai"
)

// 引文容器必须整块当一段：拆开的话外层 div 没人认领，译文里引文就没有容器
func TestParseHTMLBlocks_KeepsQuoteWrapperAtomic(t *testing.T) {
	content := `正文第一句<hr><div class="rsshub-quote">作者: 引文<br><br><img src="https://pbs.twimg.com/media/x.jpg"></div>`

	blocks, err := ai.ParseHTMLBlocks(content)
	require.NoError(t, err)
	require.NotEmpty(t, blocks)

	var quoteBlock *ai.Block
	for i := range blocks {
		if containsQuote(blocks[i].HTML) {
			quoteBlock = &blocks[i]
			break
		}
	}

	require.NotNil(t, quoteBlock, "应当有一个块带着引文容器")
	require.Contains(t, quoteBlock.HTML, `class="rsshub-quote"`)
	require.Contains(t, quoteBlock.HTML, "pbs.twimg.com/media/x.jpg", "引文里的图片要和引文在同一段")
	require.Contains(t, quoteBlock.HTML, "作者: 引文")
}

func containsQuote(html string) bool {
	for i := 0; i+len("rsshub-quote") <= len(html); i++ {
		if html[i:i+len("rsshub-quote")] == "rsshub-quote" {
			return true
		}
	}
	return false
}
