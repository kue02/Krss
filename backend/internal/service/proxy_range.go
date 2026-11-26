package service

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ErrRangeNotSatisfiable 表示客户端的 Range 头无法解析或不合法。
//
// 调用方应回 416，而**不是**把畸形 Range 原样转发给上游：以前这些情况是「原样放行」，
// 实测 `BYTES=0-`（大写）、`Foo=0-`、`bytes=abc-` 都会让上游回整段 63MB 甚至 200 全量，
// 等于一个畸形请求就能换一次完整下载。我们这层拒绝掉，别让它们打到上游。
var ErrRangeNotSatisfiable = errors.New("range not satisfiable")

// normalizeProxyRange 校验并规范化客户端 Range 头，供原样转发上游。
//
// 规则（为什么）：
//   - 空串 = 客户端没要求 Range，返回空串（不发 Range 头）。
//   - 只接受单段 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`；`bytes=` 这个 unit
//     大小写不敏感（RFC 7233 如此，浏览器大小写都出现过），统一成小写 `bytes=`。
//   - 无法解析、含多段逗号、未知单位、非数字/负起点、end < start 一律返回 ErrRangeNotSatisfiable。
//
// 不做任何窗口裁剪：start/end 原样保留 —— 裁窗会按任意起点把磁盘缓存打碎（实测放大
// 3.82×），而且流式下也不需要：上游认 Range 就回 206 我们照发，不认就回 200 整段照发。
func normalizeProxyRange(rangeHeader string) (string, error) {
	value := strings.TrimSpace(rangeHeader)
	if value == "" {
		return "", nil
	}

	unit, spec, found := strings.Cut(value, "=")
	if !found || !strings.EqualFold(strings.TrimSpace(unit), "bytes") {
		return "", ErrRangeNotSatisfiable
	}
	spec = strings.TrimSpace(spec)
	// 多段 Range（`bytes=0-1,3-4`）不支持：上游往往直接回 200 整段，我们这层挡掉。
	if spec == "" || strings.Contains(spec, ",") {
		return "", ErrRangeNotSatisfiable
	}

	startRaw, endRaw, ok := strings.Cut(spec, "-")
	if !ok {
		return "", ErrRangeNotSatisfiable
	}
	startRaw = strings.TrimSpace(startRaw)
	endRaw = strings.TrimSpace(endRaw)

	if startRaw == "" {
		// `bytes=-N`：末尾 N 字节，N 必须是正整数
		suffix, err := strconv.ParseInt(endRaw, 10, 64)
		if err != nil || suffix <= 0 {
			return "", ErrRangeNotSatisfiable
		}
		return fmt.Sprintf("bytes=-%d", suffix), nil
	}

	start, err := strconv.ParseInt(startRaw, 10, 64)
	if err != nil || start < 0 {
		return "", ErrRangeNotSatisfiable
	}
	if endRaw == "" {
		return fmt.Sprintf("bytes=%d-", start), nil
	}

	end, err := strconv.ParseInt(endRaw, 10, 64)
	if err != nil || end < start {
		return "", ErrRangeNotSatisfiable
	}
	return fmt.Sprintf("bytes=%d-%d", start, end), nil
}
