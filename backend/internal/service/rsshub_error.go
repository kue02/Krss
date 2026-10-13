package service

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// RSSHub 失败归类（51 批 2）。
//
// 背景：RSSHub 订阅的「上游」抓取发生在 RSSHub 进程里，krss 只请求 RSSHub 实例本身。
// krss 抓到非 2xx 时，RSSHub 的错误页正文里带着真正的失败原因（路由不存在 / 上游挂），
// 以前只存「HTTP 503」就把这层信息丢了 —— 用户分不清「该去 RSSHub 侧配代理」还是「地址写错」。
//
// 错误页形态（真实例实测，rsshub.wxhdj.xyz）：
//   <title>Welcome to RSSHub!</title> … Looks like something went wrong …
//   Error Message: NotFoundError: The route does not exist or has been deleted. Route: /x/y Full Route: /x/y Node Version: …
//   Error Message: Error: Twitter API returned an incomplete user response Route: … Node Version: …
//
// 分类后的错误串是**机器前缀**（前端 lib/refresh-error.ts 翻译成人话，i18n）：
//   rsshub route not found: <route>
//   rsshub upstream error: <detail>
//   rsshub unreachable: <detail>

const (
	rssHubRouteNotFoundPrefix = "rsshub route not found: "
	rssHubUpstreamErrPrefix   = "rsshub upstream error: "
	rssHubUnreachablePrefix   = "rsshub unreachable: "

	// rssHubMaxDetail 错误详情截断长度 —— 存库的是展示文本，别让一整页 HTML 进来
	rssHubMaxDetail = 160
)

var (
	// rssHubTagRe 把错误页 HTML 打成纯文本；RSSHub 的错误详情不在属性里，去标签足够
	rssHubTagRe = regexp.MustCompile(`<[^>]*>`)
	// rssHubSpaceRe 连续空白折叠
	rssHubSpaceRe = regexp.MustCompile(`\s+`)
)

// isRSSHubHost 判断这条订阅是不是指向用户自建的 RSSHub 实例（按 general.rsshub_base_url 的 host）。
func isRSSHubHost(ctx context.Context, settings SettingsService, feedURL string) bool {
	if settings == nil || feedURL == "" {
		return false
	}
	general, err := settings.GetGeneralSettings(ctx)
	if err != nil || general == nil {
		return false
	}
	return sameHost(feedURL, general.RSSHubBaseURL)
}

// sameHost 两个 URL 的 host 是否一致（大小写不敏感；任一解析失败 = false）。
func sameHost(a, b string) bool {
	ha, err1 := extractHost(a)
	hb, err2 := extractHost(b)
	return err1 == nil && err2 == nil && ha != "" && strings.EqualFold(ha, hb)
}

func extractHost(rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", err
	}
	return parsed.Hostname(), nil
}

// classifyRSSHubFetchFailure 抓取失败（transport 错误或重试耗尽）时的归类。
// bodyHead 是最后一次响应的正文头 —— RSSHub 的 5xx 会进重试循环，正文在这里才拿得到。
func classifyRSSHubFetchFailure(ctx context.Context, settings SettingsService, feedURL string, cause error, bodyHead []byte) string {
	if cause == nil {
		return ""
	}
	if !isRSSHubHost(ctx, settings, feedURL) {
		return cause.Error()
	}
	if detail, ok := parseRSSHubErrorPage(bodyHead); ok {
		if strings.Contains(detail, "NotFoundError") || strings.Contains(detail, "route does not exist") {
			return rssHubRouteNotFoundPrefix + truncateRSSHubDetail(detail)
		}
		return rssHubUpstreamErrPrefix + truncateRSSHubDetail(detail)
	}
	// 有响应但不是 RSSHub 错误页（比如反代自己的 502 页）：没有可归类的信息，原样透传
	if len(bodyHead) > 0 {
		return cause.Error()
	}
	// 压根没拿到响应（拒连/超时）= 实例连不上
	return rssHubUnreachablePrefix + truncateRSSHubDetail(cause.Error())
}

// classifyRSSHubHTTPFailure HTTP ≥400 且没进重试循环时的归类（4xx：错误页正文直接可读）。
func classifyRSSHubHTTPFailure(ctx context.Context, settings SettingsService, feedURL string, statusCode int, body []byte) string {
	return classifyRSSHubFetchFailure(ctx, settings, feedURL, fmt.Errorf("HTTP %d", statusCode), body)
}

// parseRSSHubErrorPage 从错误页正文里取 Error Message 的可读部分。
// 返回 ok=false 表示这不是 RSSHub 错误页。
func parseRSSHubErrorPage(body []byte) (string, bool) {
	text := rssHubSpaceRe.ReplaceAllString(rssHubTagRe.ReplaceAllString(string(body), " "), " ")
	// 双保险标记：页头标题 + 错误详情段，缺一不认
	if !strings.Contains(text, "RSSHub") || !strings.Contains(text, "Error Message:") {
		return "", false
	}
	i := strings.Index(text, "Error Message:")
	seg := text[i+len("Error Message:"):]
	if j := strings.Index(seg, "Node Version:"); j >= 0 {
		seg = seg[:j]
	}
	seg = strings.TrimSpace(seg)
	// 去掉尾部 "Route: /x/y Full Route: /x/y" —— 路由名前端可以从订阅地址看到，不重复存
	if k := strings.Index(seg, " Route: "); k >= 0 {
		seg = seg[:k]
	}
	seg = strings.TrimSpace(strings.TrimPrefix(seg, "Error:"))
	if seg == "" {
		return "", false
	}
	return seg, true
}

func truncateRSSHubDetail(s string) string {
	s = strings.TrimSpace(s)
	if len(s) <= rssHubMaxDetail {
		return s
	}
	return s[:rssHubMaxDetail] + "…"
}
