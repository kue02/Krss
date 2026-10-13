package network

import (
	"context"
	"net/http"
	"time"

	"krss/backend/pkg/logger"
)

// 智能代理（50 批 2.2 · 迁移 29）：先直连（短超时），不通走代理；结论按目标域记忆。
//
// 记忆形态：直连成功 → 记 direct，下次直接直连（不再探测）；直连失败而代理成功 → 记 proxy，
// 下次直接走代理（不再白等一次超时）。只记「传输层通不通」，不判断 HTTP 状态码 ——
// 403/404 是「通但被拒」，换代理也未必更好，不该因此翻转记忆。

// DomainMemory 域记忆的存取（由 repository 层实现，落 proxy_domain_memory 表；
// 这里只声明形状避免 pkg/network 依赖业务包）。实现必须自己容忍并发与失败。
type DomainMemory interface {
	// MemoryModeFor 查一个域的结论；没记过返回 ("", false)。
	MemoryModeFor(ctx context.Context, host string) (string, bool)
	// Remember 记一个域的结论（"direct" | "proxy"）；写失败只许记日志，不许影响请求。
	Remember(ctx context.Context, host, mode string)
}

// SmartProbeTimeout 直连探测的短超时：够 TCP+TLS 握手，又不至于让「不通」的源拖太久。
const SmartProbeTimeout = 4 * time.Second

// smartMarker 智能档的 URL 前缀：解析层把「智能」编码成 smart:<代理URL>，冒号后为空 = 没配代理。
const smartMarker = "smart:"

// SmartTransport http.RoundTripper：按目标域决定直连或代理，并学习。
type SmartTransport struct {
	direct  http.RoundTripper // 直连腿（永远有）
	viaProxy http.RoundTripper // 代理腿；nil = 没配代理（智能退化成「只直连」）
	memory  DomainMemory      // nil = 不学习不查询（纯直连）
	probe   time.Duration     // 直连探测超时；0 = SmartProbeTimeout
}

func NewSmartTransport(direct, viaProxy http.RoundTripper, memory DomainMemory) *SmartTransport {
	return &SmartTransport{direct: direct, viaProxy: viaProxy, memory: memory}
}

func (t *SmartTransport) memoryMode(ctx context.Context, host string) (string, bool) {
	if t.memory == nil {
		return "", false
	}
	return t.memory.MemoryModeFor(ctx, host)
}

func (t *SmartTransport) remember(ctx context.Context, host, mode string) {
	if t.memory == nil {
		return
	}
	// 同步写：每域只写一次（之后的请求走记忆短路），SQLite 单行 upsert 开销可忽略；
	// 同步保证「这一轮成功、下一轮就走记住的那条」语义确定。写失败由适配器记日志，不影响响应。
	t.memory.Remember(ctx, host, mode)
}

func (t *SmartTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	host := req.URL.Hostname()

	// 有记忆：直接走记住的那条，不再探测
	if mode, ok := t.memoryMode(req.Context(), host); ok {
		if mode == "proxy" && t.viaProxy != nil {
			return t.viaProxy.RoundTrip(req)
		}
		return t.direct.RoundTrip(req)
	}

	// 没记忆：先直连（短超时探测）
	probeCtx, cancel := context.WithTimeout(req.Context(), t.probeOr(SmartProbeTimeout))
	defer cancel()
	directResp, directErr := t.direct.RoundTrip(req.WithContext(probeCtx))
	if directErr == nil {
		t.remember(req.Context(), host, "direct")
		return directResp, nil
	}

	// 直连不通：有代理腿就试代理（用原始请求的完整超时，不再套短超时）
	if t.viaProxy != nil {
		proxyResp, proxyErr := t.viaProxy.RoundTrip(req)
		if proxyErr == nil {
			t.remember(req.Context(), host, "proxy")
			return proxyResp, nil
		}
		// 两边都不通：返回直连的错误（更接近「本来长什么样」），代理错误记日志
		logger.Warn("smart proxy both legs failed", "module", "network", "action", "fetch", "resource", "smart-proxy", "host", host, "proxy_error", proxyErr.Error())
	}
	return nil, directErr
}

func (t *SmartTransport) probeOr(d time.Duration) time.Duration {
	if t.probe > 0 {
		return t.probe
	}
	return d
}
