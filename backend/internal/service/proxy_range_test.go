package service_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/service"
)

func TestSliceByRange(t *testing.T) {
	data := []byte("0123456789") // 长度 10

	t.Run("bytes=0-", func(t *testing.T) {
		chunk, contentRange, status := service.SliceByRange(data, "bytes=0-")
		require.Equal(t, 206, status)
		require.Equal(t, "bytes 0-9/10", contentRange)
		require.Equal(t, "0123456789", string(chunk))
	})

	t.Run("bytes=2-5", func(t *testing.T) {
		chunk, contentRange, status := service.SliceByRange(data, "bytes=2-5")
		require.Equal(t, 206, status)
		require.Equal(t, "bytes 2-5/10", contentRange)
		require.Equal(t, "2345", string(chunk))
	})

	t.Run("bytes=7-（到结尾）", func(t *testing.T) {
		chunk, contentRange, status := service.SliceByRange(data, "bytes=7-")
		require.Equal(t, 206, status)
		require.Equal(t, "bytes 7-9/10", contentRange)
		require.Equal(t, "789", string(chunk))
	})

	t.Run("bytes=-3（末尾三个）", func(t *testing.T) {
		chunk, contentRange, status := service.SliceByRange(data, "bytes=-3")
		require.Equal(t, 206, status)
		require.Equal(t, "bytes 7-9/10", contentRange)
		require.Equal(t, "789", string(chunk))
	})

	t.Run("超出末尾要收敛", func(t *testing.T) {
		chunk, contentRange, status := service.SliceByRange(data, "bytes=5-999")
		require.Equal(t, 206, status)
		require.Equal(t, "bytes 5-9/10", contentRange)
		require.Equal(t, "56789", string(chunk))
	})

	t.Run("没有 Range 时整段 200", func(t *testing.T) {
		chunk, contentRange, status := service.SliceByRange(data, "")
		require.Equal(t, 200, status)
		require.Empty(t, contentRange)
		require.Equal(t, "0123456789", string(chunk))
	})

	t.Run("多段 range 不处理", func(t *testing.T) {
		chunk, _, status := service.SliceByRange(data, "bytes=0-1,4-5")
		require.Equal(t, 200, status)
		require.Len(t, chunk, 10)
	})

	t.Run("起点越界不 panic", func(t *testing.T) {
		chunk, _, status := service.SliceByRange(data, "bytes=99-")
		require.Equal(t, 200, status)
		require.Len(t, chunk, 10)
	})
}

// fix/video-proxy-stream：开放式 Range 必须收成有界窗口，否则上游回整个文件。
func TestClampOpenEndedRange(t *testing.T) {
	const chunk = int64(4) << 20 // 4194304

	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"开放式起点 0", "bytes=0-", "bytes=0-4194303"},
		{"开放式非零起点", "bytes=100-", "bytes=100-4194403"},
		{"大偏移开放式", "bytes=1000000-", "bytes=1000000-5194303"},
		{"已有结束位置不改", "bytes=0-1023", "bytes=0-1023"},
		{"已有结束位置不改（大）", "bytes=0-4194303", "bytes=0-4194303"},
		{"末尾后缀不改", "bytes=-500", "bytes=-500"},
		{"多段不改", "bytes=0-1,4-5", "bytes=0-1,4-5"},
		{"空串不改", "", ""},
		{"垃圾串不改", "bytes=abc-", "bytes=abc-"},
		{"缺少 bytes= 前缀不改", "0-", "0-"},
		{"没有连字符不改", "bytes=100", "bytes=100"},
		{"两端都空不改", "bytes=-", "bytes=-"},
		{"负数起点不改", "bytes=-1-", "bytes=-1-"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, service.ClampOpenEndedRange(tc.input, chunk))
		})
	}

	t.Run("窗口大小由 chunkBytes 决定", func(t *testing.T) {
		require.Equal(t, "bytes=0-9", service.ClampOpenEndedRange("bytes=0-", 10))
	})

	t.Run("chunkBytes 非正时原样返回", func(t *testing.T) {
		require.Equal(t, "bytes=0-", service.ClampOpenEndedRange("bytes=0-", 0))
	})
}
