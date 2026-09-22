// Package mcp 失败分类（16-12）：把「连不上」翻译成人话。
//
// 格式统一：结论一句话（人话）+ 一句建议 + 可复制的原始返回。
// 桶决定界面给什么出口按钮：认证桶 →「去配 Header / 改用 OAuth」；
// 传输出错 →「一键切成 SSE 重试」。列表行 / 测试按钮 / 向导预览三处共用同一套。
// 分不进四桶的一律落进 unknown 兜底 —— 界面永远有话可说，不许只甩状态码。
package mcp

import (
	"crypto/x509"
	"errors"
	"net"
	"net/url"
	"strings"

	"krss/backend/internal/model"
)

// Classify 把一次连接/取数失败收成结构化原因。endpoint 只用来拼建议（取主机名），
// 绝不原样写进日志 —— 调用方记日志时只传 ExtractHost 之后的主机。
func Classify(err error, endpoint string) model.MCPFailure {
	raw := ""
	if err != nil {
		raw = err.Error()
	}
	host := hostOf(endpoint)
	lowered := strings.ToLower(raw)

	// 传输层 HTTP 状态优先看（*HTTPError 带着 Body，原始返回可复制）。
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		return classifyHTTP(httpErr, host)
	}

	// DNS / 连接拒绝 / 超时 / TLS：按标准错误类型判，不猜字符串。
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return model.MCPFailure{
			Bucket:     model.MCPFailureNetwork,
			Code:       "dns",
			Title:      "无法解析主机名（DNS 失败）",
			Suggestion: hostSuggestion(host, "检查地址拼写；若走了代理，确认代理能解析这个域名"),
			Raw:        raw,
		}
	}
	if isConnRefused(err) {
		return model.MCPFailure{
			Bucket:     model.MCPFailureNetwork,
			Code:       "refused",
			Title:      "连不上服务（连接被拒绝）",
			Suggestion: "确认服务已启动、端口与 URL 一致；若在另一台机器上，检查防火墙",
			Raw:        raw,
		}
	}
	if isTimeout(err) {
		return model.MCPFailure{
			Bucket:     model.MCPFailureNetwork,
			Code:       "timeout",
			Title:      "连接超时",
			Suggestion: "网络或代理慢、服务无响应；可以在连接的「单独配置」里调大超时",
			Raw:        raw,
		}
	}
	var certErr x509.CertificateInvalidError
	var unknownAuthErr x509.UnknownAuthorityError
	if errors.As(err, &certErr) || errors.As(err, &unknownAuthErr) || strings.Contains(lowered, "certificate") {
		return model.MCPFailure{
			Bucket:     model.MCPFailureNetwork,
			Code:       "tls",
			Title:      "证书校验失败（HTTPS）",
			Suggestion: "自签证书或证书过期；确认地址是 https 还是 http 写错了",
			Raw:        raw,
		}
	}

	// 协议层：握手/解析失败。
	if strings.Contains(lowered, "serverinfo") || strings.Contains(lowered, "initialize") {
		return model.MCPFailure{
			Bucket:     model.MCPFailureProtocol,
			Code:       "not_mcp",
			Title:      "响应不是 MCP 协议",
			Suggestion: "对方没回 serverInfo / 没完成 initialize —— 可能这不是 MCP 端点（常见是漏了 /mcp 后缀）",
			Raw:        truncate(raw, 500),
		}
	}
	if strings.Contains(lowered, "空响应体") || strings.Contains(lowered, "没有找到 json-rpc") {
		return model.MCPFailure{
			Bucket:     model.MCPFailureProtocol,
			Code:       "empty",
			Title:      "服务回了空响应",
			Suggestion: sseHint(endpoint),
			Raw:        raw,
		}
	}

	return model.MCPFailure{
		Bucket:     model.MCPFailureUnknown,
		Code:       "unknown",
		Title:      "连接失败（原因未知）",
		Suggestion: "把下面的原始返回复制下来，换一种传输重试，或检查服务日志",
		Raw:        raw,
	}
}

// classifyHTTP 按状态码分桶（401/403 → 认证桶带出口；404/405 → 协议桶；5xx → 上游桶）。
func classifyHTTP(httpErr *HTTPError, host string) model.MCPFailure {
	raw := httpErr.Error()
	switch httpErr.StatusCode {
	case 401, 403:
		return model.MCPFailure{
			Bucket:     model.MCPFailureAuth,
			Code:       "unauthorized",
			Title:      "需要授权（" + itoa(httpErr.StatusCode) + "）",
			Suggestion: "这个服务要授权 —— 可以填 Header，或改用 OAuth 授权",
			Raw:        raw,
		}
	case 404, 405:
		return model.MCPFailure{
			Bucket:     model.MCPFailureProtocol,
			Code:       "not_found",
			Title:      "路径不对（" + itoa(httpErr.StatusCode) + "）",
			Suggestion: "多半不是 MCP 端点（常见是漏了 /mcp 后缀）；若对方是 SSE 老服务，把传输切成 SSE 重试",
			Raw:        raw,
		}
	case 502, 503, 504:
		return model.MCPFailure{
			Bucket:     model.MCPFailureUpstream,
			Code:       "bad_gateway",
			Title:      "上游网关错误（" + itoa(httpErr.StatusCode) + "）",
			Suggestion: hostSuggestion(host, "服务在网关/反代后面，网关替它报了错；稍后重试，或直连服务地址"),
			Raw:        raw,
		}
	default:
		if httpErr.StatusCode >= 500 {
			return model.MCPFailure{
				Bucket:     model.MCPFailureUpstream,
				Code:       "server_error",
				Title:      "服务内部错误（" + itoa(httpErr.StatusCode) + "）",
				Suggestion: "对方服务自己报错了；看原始返回里有没有线索",
				Raw:        raw,
			}
		}
		return model.MCPFailure{
			Bucket:     model.MCPFailureProtocol,
			Code:       "http_error",
			Title:      "请求被拒绝（" + itoa(httpErr.StatusCode) + "）",
			Suggestion: "看原始返回；若提示传输不对，换一种传输重试",
			Raw:        raw,
		}
	}
}

// SSETransportMismatch 对方是 SSE 端点但我们按 HTTP 打时，后端探测到的特征。
// 界面拿这个直接给「一键切成 SSE 重试」按钮（16-12 口径）。
func SSETransportMismatch(endpoint string) model.MCPFailure {
	return model.MCPFailure{
		Bucket:     model.MCPFailureProtocol,
		Code:       "sse_endpoint",
		Title:      "该地址是 SSE 端点，但传输选了 HTTP",
		Suggestion: "一键切成 SSE 重试",
		Raw:        endpoint,
	}
}

func hostOf(endpoint string) string {
	parsed, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	return parsed.Hostname()
}

func hostSuggestion(host, otherwise string) string {
	if host == "" {
		return otherwise
	}
	return otherwise + "（" + host + "）"
}

// sseHint 空响应/非 JSON 时的传输提示：URL 长得像 SSE 端点就直说。
func sseHint(endpoint string) string {
	lowered := strings.ToLower(endpoint)
	if strings.Contains(lowered, "/sse") || strings.Contains(lowered, "sse") {
		return "地址里有 sse —— 若对方是 SSE 老服务，把传输切成 SSE 重试"
	}
	return "对方没有返回 JSON-RPC 结果；若对方是 SSE 老服务，把传输切成 SSE 重试"
}

func isConnRefused(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		lowered := strings.ToLower(opErr.Error())
		return strings.Contains(lowered, "refused")
	}
	return strings.Contains(strings.ToLower(err.Error()), "connection refused")
}

func isTimeout(err error) bool {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	lowered := strings.ToLower(err.Error())
	return strings.Contains(lowered, "timeout") || strings.Contains(lowered, "deadline exceeded")
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	negative := n < 0
	if negative {
		n = -n
	}
	var buf [8]byte
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	if negative {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
