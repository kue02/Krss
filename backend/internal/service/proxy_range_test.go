package service_test

import (
	"net/http"
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

// 第四轮：结构化 Range 解析 + 本地切片（兜底路径与磁盘缓存切片共用）。
func TestSliceMediaBytes(t *testing.T) {
	data := []byte("0123456789") // 共 10 字节
	cases := []struct {
		header     string
		wantChunk  []byte
		wantRange  string
		wantStatus int
	}{
		{header: "bytes=0-", wantChunk: data, wantRange: "bytes 0-9/10", wantStatus: http.StatusPartialContent},
		{header: "bytes=2-5", wantChunk: data[2:6], wantRange: "bytes 2-5/10", wantStatus: http.StatusPartialContent},
		{header: "bytes=-3", wantChunk: data[7:], wantRange: "bytes 7-9/10", wantStatus: http.StatusPartialContent},
		{header: "bytes=8-100", wantChunk: data[8:], wantRange: "bytes 8-9/10", wantStatus: http.StatusPartialContent},
		{header: "bytes=10-", wantChunk: nil, wantRange: "bytes */10", wantStatus: http.StatusRequestedRangeNotSatisfiable},
	}
	for _, tc := range cases {
		t.Run(tc.header, func(t *testing.T) {
			spec, err := service.ParseMediaRange(tc.header)
			require.NoError(t, err)
			chunk, contentRange, status := service.SliceMediaBytes(data, spec)
			require.Equal(t, tc.wantStatus, status)
			require.Equal(t, tc.wantRange, contentRange)
			require.Equal(t, tc.wantChunk, chunk)
		})
	}
}

func TestParseMediaRange_Invalid(t *testing.T) {
	for _, header := range []string{"Foo=0-", "bytes=1-0", "bytes=", "bytes=-"} {
		t.Run(header, func(t *testing.T) {
			_, err := service.ParseMediaRange(header)
			require.ErrorIs(t, err, service.ErrRangeNotSatisfiable)
		})
	}
}
