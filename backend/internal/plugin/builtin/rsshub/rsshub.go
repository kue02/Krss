// Package rsshub RSSHub 适配插件（55 批：从本体搬来的第二个真实插件）。
//
// 它做两件事，都是「RSSHub 实例」这件事的特化：
//  1. 抓取失败归类：RSSHub 订阅的「上游」抓取发生在 RSSHub 进程里，krss 只请求实例本身；
//     实例回非 2xx 时，错误页正文里带着真正的失败原因（路由不存在 / 上游挂 / 实例连不上）。
//     插件化之前这层逻辑在本体（service/rsshub_error.go），现在挂到 FetchClassifier 扩展点，
//     停用插件 = 回到「只存 HTTP xxx」的老样子。
//  2. 实例设置：自有实例地址 + 可选 ACCESS_KEY（插件设置键 plugin.rsshub.base_url /
//     plugin.rsshub.access_key，迁移 33 会把 general.rsshub_* 的老值复制过来）。
//
// 前端同一件事的两处消费：添加订阅时把公共实例地址改写成自有实例（plugins/rsshub/），
// 以及设置弹窗「插件」页里的这一段。表格形状由 SettingsSections() 声明，界面是代码随包发。
package rsshub

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"krss/backend/internal/model"
	"krss/backend/internal/plugin"
)

func init() { plugin.MustRegister(New()) }

// New 造插件实例（init() 自注册也走这里）。
func New() plugin.Plugin { return Plugin{} }

// store 插件设置存储（main.go 装配期用 Configure 填一次；测试直接给 fake store）。
var store plugin.SettingsStore

// Configure 装设置存储（键 plugin.rsshub.*）。这个插件不出网，所以不需要 client。
func Configure(settings plugin.SettingsStore) { store = settings }

// Plugin RSSHub 适配插件。
type Plugin struct{}

// settings 插件自己的设置助手（键 plugin.rsshub.base_url / plugin.rsshub.access_key）。
func (Plugin) settings() plugin.Settings {
	return plugin.Settings{PluginID: "rsshub", Store: store}
}

func (Plugin) Meta() plugin.Meta {
	return plugin.Meta{
		ID:   "rsshub",
		Name: "RSSHub 适配",
		Description: "换到自己的 RSSHub 实例。",
		Version: "1.0.0",
		Builtin: true,
		// DefaultEnabled 留 nil = 默认启用：稳定能力，老实例升级后行为零变化。
	}
}

// Actions / EntryProcessors 空：RSSHub 不需要联动自动化，它优化的是「添加订阅时改写地址」
// 与「失败原因说人话」。
func (Plugin) Actions() []plugin.Action                 { return nil }
func (Plugin) EntryProcessors() []plugin.EntryProcessor { return nil }

func (Plugin) FetchClassifiers() []plugin.FetchClassifier {
	return []plugin.FetchClassifier{classifier{}}
}

// SettingsSections 设置弹窗「插件」页里的实例段（字段形状照搬原 RSSHubSettings 的表单）。
func (Plugin) SettingsSections() []plugin.SettingsSection {
	return []plugin.SettingsSection{{
		ID:    "rsshub-instance",
		Title: "RSSHub 实例",
		Fields: []plugin.Field{
			{
				Key:         "base_url",
				Label:       "自有实例地址",
				Type:        "text",
				Placeholder: "https://rsshub.example.com",
				Help:        "添加订阅时自动换到该实例。",
			},
			{
				Key:   "access_key",
				Label: "ACCESS_KEY（可选）",
				// 这里用 text 而不是 secret：ACCESS_KEY 要被**前端**拿去拼进新订阅地址
				// （plugins/rsshub/useRssHubRewrite → key 参数），secret 字段读出来是掩码，
				// 拼进地址会把 key=•••••••• 写进订阅 URL，密码等于被写坏。55-18 之前
				// 通用设置也是明文返回这一项，语义不变。
				Type:        "text",
				Placeholder: "ACCESS_KEY",
				Help:        "作为 key 参数拼进地址。",
			},
		},
	}}
}

// classifier 抓取失败归类扩展点。
type classifier struct{}

func (classifier) ID() string { return "rsshub-error-page" }

// Classify 只认领「指向自己实例」的失败；别人的源返回空串（交给下一家 / 原样透传）。
func (classifier) Classify(ctx context.Context, feed model.Feed, statusCode int, bodyHead []byte, fetchErr error) string {
	settings := Plugin{}.settings()
	// 不配实例地址 / 不指向实例 ⇒ 这次失败与 RSSHub 无关，不认领
	if !isRSSHubHost(ctx, settings, feed.URL) {
		return ""
	}
	if fetchErr != nil {
		return classifyRSSHubFetchFailure(ctx, settings, feed.URL, fetchErr, bodyHead)
	}
	return classifyRSSHubHTTPFailure(ctx, settings, feed.URL, statusCode, bodyHead)
}

// ---- 以下从 service/rsshub_error.go 原样搬来（55-18），只把设置来源换成插件设置 ----

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

// isRSSHubHost 判断这条订阅是不是指向用户自建的 RSSHub 实例（按插件设置 base_url 的 host）。
func isRSSHubHost(ctx context.Context, settings plugin.Settings, feedURL string) bool {
	if feedURL == "" {
		return false
	}
	baseURL := settings.Get(ctx, "base_url")
	if baseURL == "" {
		return false
	}
	return sameHost(feedURL, baseURL)
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
func classifyRSSHubFetchFailure(ctx context.Context, settings plugin.Settings, feedURL string, cause error, bodyHead []byte) string {
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
func classifyRSSHubHTTPFailure(ctx context.Context, settings plugin.Settings, feedURL string, statusCode int, body []byte) string {
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
