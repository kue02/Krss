package service_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/service"
)

// fix/video-proxy-stream 第三轮：Range 只做「校验 + 规范化」，不再切窗口。
// 无法解析 / 多段 / 未知单位一律返回 ErrRangeNotSatisfiable（handler 回 416），
// 绝不让畸形 Range 被转发给上游换来一次整段下载。
func TestNormalizeProxyRange(t *testing.T) {
	valid := []struct {
		name  string
		input string
		want  string
	}{
		{"空串 = 无 Range", "", ""},
		{"开放式起点 0", "bytes=0-", "bytes=0-"},
		{"开放式非零起点", "bytes=1000000-", "bytes=1000000-"},
		{"有结束位置", "bytes=0-1023", "bytes=0-1023"},
		{"末尾后缀", "bytes=-500", "bytes=-500"},
		{"前缀大小写不敏感（大写）", "BYTES=0-", "bytes=0-"},
		{"前缀大小写不敏感（混合）", "Bytes=100-200", "bytes=100-200"},
		{"前后有空白", "  bytes=0-1023  ", "bytes=0-1023"},
	}
	for _, tc := range valid {
		t.Run(tc.name, func(t *testing.T) {
			got, err := service.NormalizeProxyRange(tc.input)
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}

	invalid := []struct {
		name  string
		input string
	}{
		{"多段", "bytes=0-1,4-5"},
		{"未知单位", "Foo=0-"},
		{"大写未知单位", "ITEM=0-"},
		{"非数字起点", "bytes=abc-"},
		{"缺少连字符", "bytes=100"},
		{"两端都空", "bytes=-"},
		{"负数起点", "bytes=-1-"},
		{"负后缀", "bytes=-0"},
		{"end 小于 start", "bytes=100-50"},
		{"空 spec", "bytes="},
		{"没有等号", "bytes"},
	}
	for _, tc := range invalid {
		t.Run(tc.name, func(t *testing.T) {
			_, err := service.NormalizeProxyRange(tc.input)
			require.ErrorIs(t, err, service.ErrRangeNotSatisfiable)
		})
	}
}
