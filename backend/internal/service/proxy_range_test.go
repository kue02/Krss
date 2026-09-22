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
