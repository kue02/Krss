package service

import (
	"fmt"
	"strconv"
	"strings"
)

// sliceByRange 按客户端要的 Range 把整段数据切出来。
//
// 为什么要自己做：上游（例如 video.twimg.com）常常无视 Range，照样回 200 + 整个文件。
// 浏览器拿不到 206 就认为这个媒体「不可跳转」—— 进度条一拖就弹回去。
// 所以我们在代理这层补上 206，<video> 才能快进/拖动。
//
// 只处理单段 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`（浏览器的常规用法）。
// 多段 range 不处理，退回整段（浏览器会重新发单段请求）。
func sliceByRange(data []byte, rangeHeader string) ([]byte, string, int) {
	total := len(data)

	spec, ok := parseSingleRange(rangeHeader, total)
	if !ok {
		return data, "", 200
	}

	start, end := spec[0], spec[1]
	if start > end || start >= total {
		// 越界：按 HTTP 语义应当回 416，这里退回整段更省事（浏览器会自行降级）
		return data, "", 200
	}

	chunk := data[start : end+1]
	contentRange := fmt.Sprintf("bytes %d-%d/%d", start, end, total)
	return chunk, contentRange, 206
}

// parseSingleRange 解析 `bytes=...`，返回 [start, end]（含端点，已按总长收敛）。
func parseSingleRange(rangeHeader string, total int) ([2]int, bool) {
	var out [2]int
	if total <= 0 || rangeHeader == "" {
		return out, false
	}

	value := strings.TrimSpace(rangeHeader)
	if !strings.HasPrefix(value, "bytes=") {
		return out, false
	}
	value = strings.TrimPrefix(value, "bytes=")
	if strings.Contains(value, ",") {
		// 多段：不做
		return out, false
	}

	parts := strings.SplitN(value, "-", 2)
	if len(parts) != 2 {
		return out, false
	}

	startRaw := strings.TrimSpace(parts[0])
	endRaw := strings.TrimSpace(parts[1])

	switch {
	case startRaw == "" && endRaw == "":
		return out, false
	case startRaw == "":
		// `bytes=-500`：最后 500 字节
		suffix, err := strconv.Atoi(endRaw)
		if err != nil || suffix <= 0 {
			return out, false
		}
		if suffix > total {
			suffix = total
		}
		return [2]int{total - suffix, total - 1}, true
	default:
		start, err := strconv.Atoi(startRaw)
		if err != nil || start < 0 {
			return out, false
		}
		end := total - 1
		if endRaw != "" {
			parsedEnd, endErr := strconv.Atoi(endRaw)
			if endErr != nil || parsedEnd < start {
				return out, false
			}
			end = parsedEnd
		}
		if end > total-1 {
			end = total - 1
		}
		return [2]int{start, end}, true
	}
}
