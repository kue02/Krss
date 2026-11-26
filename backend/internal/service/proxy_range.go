package service

import (
	"errors"
	"fmt"
	"net/http"
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

// mediaRange 是已经解析、尚未按总长解析的单段 Range。
//
// 两种形态：
//   - start/end 闭区间，end = -1 表示「到末尾」（`bytes=start-`）
//   - suffix > 0 表示末尾 N 字节（`bytes=-N`），start/end 无意义
//
// 为什么不直接在字符串上判断：兜底路径（azuretls 取整段）拿到完整字节后要按同一段
// Range 在本地切出来回 206 —— 那时只有「客户端要的 Range + 整段长度」，
// 必须先解析成结构化区间才能算起点/终点。
type mediaRange struct {
	start  int64
	end    int64
	suffix int64
}

// parseMediaRange 把 normalizeProxyRange 的输出解析成 mediaRange。
// 只接受单段 `bytes=` 形式（normalizeProxyRange 已经保证过），这里再兜一次底。
func parseMediaRange(normalized string) (mediaRange, error) {
	unit, spec, found := strings.Cut(normalized, "=")
	if !found || !strings.EqualFold(strings.TrimSpace(unit), "bytes") {
		return mediaRange{}, ErrRangeNotSatisfiable
	}
	spec = strings.TrimSpace(spec)
	startRaw, endRaw, ok := strings.Cut(spec, "-")
	if !ok {
		return mediaRange{}, ErrRangeNotSatisfiable
	}
	startRaw = strings.TrimSpace(startRaw)
	endRaw = strings.TrimSpace(endRaw)

	if startRaw == "" {
		suffix, err := strconv.ParseInt(endRaw, 10, 64)
		if err != nil || suffix <= 0 {
			return mediaRange{}, ErrRangeNotSatisfiable
		}
		return mediaRange{start: 0, end: -1, suffix: suffix}, nil
	}

	start, err := strconv.ParseInt(startRaw, 10, 64)
	if err != nil || start < 0 {
		return mediaRange{}, ErrRangeNotSatisfiable
	}
	r := mediaRange{start: start, end: -1}
	if endRaw != "" {
		end, err := strconv.ParseInt(endRaw, 10, 64)
		if err != nil || end < start {
			return mediaRange{}, ErrRangeNotSatisfiable
		}
		r.end = end
	}
	return r, nil
}

// resolveMediaRange 按整段总长把 mediaRange 化成实际闭区间 [start, end]。
// ok=false 表示起点越界（start >= total），调用方应回 416。
func resolveMediaRange(spec mediaRange, total int64) (start, end int64, ok bool) {
	if total <= 0 {
		return 0, 0, false
	}
	if spec.suffix > 0 {
		start = total - spec.suffix
		if start < 0 {
			start = 0
		}
		return start, total - 1, true
	}
	start = spec.start
	if start >= total {
		return 0, 0, false
	}
	end = spec.end
	if end < 0 || end >= total {
		end = total - 1
	}
	return start, end, true
}

// sliceMediaBytes 在已拿到整段字节（兜底路径 / 磁盘整文件缓存）时按 Range 切片。
//
// 返回 (chunk, Content-Range, status)：
//   - 正常：chunk=data[start:end+1]、`bytes start-end/total`、206
//   - 起点越界：chunk=nil、`bytes */total`、416
//
// 这是第一轮 sliceByRange 的「按新 API 补回」：第一轮为了流式把它删了，
// 但 azuretls 兜底这条路拿的是整段，不给客户端切片就只能回 200 整段 +
// 谎称支持 Range，浏览器会判「不支持 Range」→ 回 0 重播、seek 失效。
func sliceMediaBytes(data []byte, spec mediaRange) (chunk []byte, contentRange string, status int) {
	total := int64(len(data))
	start, end, ok := resolveMediaRange(spec, total)
	if !ok {
		return nil, fmt.Sprintf("bytes */%d", total), http.StatusRequestedRangeNotSatisfiable
	}
	return data[start : end+1], fmt.Sprintf("bytes %d-%d/%d", start, end, total), http.StatusPartialContent
}
