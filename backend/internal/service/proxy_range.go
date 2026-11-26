package service

import (
	"fmt"
	"strconv"
	"strings"
)

// mediaChunkBytes 开放式 Range（`bytes=start-`，没有结束位置）向上游要的窗口大小。
//
// 为什么必须有它：浏览器 <video> 的首发请求几乎都是 `Range: bytes=0-`（开放式），
// 上游照字面理解就是「从 0 到文件尾」—— 63MB 的视频就真给你回 63MB。代理层原来把
// 整段读进内存（io.ReadAll）再切 1KB 给浏览器，实测 TTFB 5.5-7.8s，而直连上游同请求 0.46s。
// 改成 4MiB 有界窗口后：上游回 206 + `Content-Range: bytes 0-4194303/63176469`，
// 浏览器据此知道总长、接着要下一段，这是标准做法（服务端不需要自己编 Content-Range）。
//
// 取 4MiB 的理由：① 远小于 maxCacheableMediaBytes(16MiB)，片段能落盘被后续请求复用；
// ② 4K 视频按 10Mbps 码率约合 3.2s 播放量，比浏览器预读需求（通常几百 KB～2MB）宽裕；
// ③ 再大就会让弱网下单个请求更容易撞超时、也更快挤爆 512MB 缓存。
const mediaChunkBytes = int64(4) << 20

// clampOpenEndedRange 把开放式 Range 改写成有界窗口，其它形式原样放行。
//
// 只处理单段 `bytes=start-`（start 是合法非负整数、没有 end）：
//
//	bytes=0-        → bytes=0-4194303
//	bytes=1000000-  → bytes=1000000-5194303
//
// `start-end`（已有结束位置，浏览器自己要的就是这么多）、`-suffix`（末尾 N 字节）、
// 多段、空串、解析失败一律原样返回 —— 这些情况上游不会回整个文件，改了反而错。
func clampOpenEndedRange(rangeHeader string, chunkBytes int64) string {
	if chunkBytes <= 0 {
		return rangeHeader
	}

	value := strings.TrimSpace(rangeHeader)
	if !strings.HasPrefix(value, "bytes=") {
		return rangeHeader
	}
	spec := strings.TrimPrefix(value, "bytes=")
	// 多段 range 不碰（浏览器会自己降级成单段）
	if spec == "" || strings.Contains(spec, ",") {
		return rangeHeader
	}

	startRaw, endRaw, found := strings.Cut(spec, "-")
	if !found {
		return rangeHeader
	}
	startRaw = strings.TrimSpace(startRaw)
	endRaw = strings.TrimSpace(endRaw)
	// `-suffix`（start 为空）与 `start-end`（end 非空）都不改写
	if startRaw == "" || endRaw != "" {
		return rangeHeader
	}

	start, err := strconv.ParseInt(startRaw, 10, 64)
	if err != nil || start < 0 {
		return rangeHeader
	}
	end := start + chunkBytes - 1
	if end < start { // 溢出保护：起点大到加不下一个窗口就原样放行
		return rangeHeader
	}
	return fmt.Sprintf("bytes=%d-%d", start, end)
}

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
