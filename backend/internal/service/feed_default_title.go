package service

import (
	"net/url"
	"regexp"
	"strings"
)

// 第五十二批：订阅的**可读默认名**与**分组域名**（52-2 / 52-3 / 52-5）。
//
// 用户报的现象：添加订阅没填名称 → 订阅名变成 `https://rsshub.xxx/telegram/channel/…`。
// 取证结论（todo §2.52）：正常抓到的 feed 走 `fetched.title`（实测少数派 → 落库「少数派」，
// 没问题）；出问题的是两条兜底分支 —— **抓取失败**与 **feed 自身没有 title**，它们原先
// 直接把整条订阅地址当名称。这里把兜底换成可读名：主站域名（+ 路由尾段），推不出主站才用实例域名。
//
// 域名口径与前端 `lib/feed-site.ts` 保持一致（同一张 RSSHub 反解表）：
// 主站（feed 声明的 site_url 或 RSSHub 路由反解）优先，退到订阅地址自己的 host。

// maxFallbackTitleLen 默认名上限（rune）。超长说明推得不对，截断比塞一整条 URL 好。
const maxFallbackTitleLen = 80

// rsshubRoutePatterns RSSHub「路径结构固定」的几类路由 → 主页模板（与前端同一份表）。
var rsshubRoutePatterns = []struct {
	re   *regexp.Regexp
	tmpl string
}{
	{regexp.MustCompile(`^/twitter/user/([^/]+)`), "https://x.com/$1"},
	{regexp.MustCompile(`^/twitter/keyword/([^/]+)`), "https://x.com/search"},
	{regexp.MustCompile(`^/telegram/channel/([^/]+)`), "https://t.me/$1"},
	{regexp.MustCompile(`^/weibo/user/([^/]+)`), "https://weibo.com/u/$1"},
	{regexp.MustCompile(`^/bilibili/user/(?:video|dynamic)/([^/]+)`), "https://space.bilibili.com/$1"},
	{regexp.MustCompile(`^/zhihu/(?:people/)?(?:activities|posts)/([^/]+)`), "https://www.zhihu.com/people/$1"},
	{regexp.MustCompile(`^/youtube/(?:user|channel)/([^/]+)`), "https://www.youtube.com/$1"},
	{regexp.MustCompile(`^/github/(?:repos|issue|pull)/([^/]+)(?:/([^/]+))?`), "https://github.com/$1/$2"},
	{regexp.MustCompile(`^/xiaohongshu/user/([^/]+)`), "https://www.xiaohongshu.com/user/profile/$1"},
	{regexp.MustCompile(`^/douyin/user/([^/]+)`), "https://www.douyin.com/user/$1"},
	{regexp.MustCompile(`^/jike/user/([^/]+)`), "https://web.okjike.com/u/$1"},
}

// rsshubNamespaces RSSHub 常见命名空间：认得出这是聚合实例的路由（用来决定要不要带路由尾段）。
var rsshubNamespaces = map[string]struct{}{
	"twitter": {}, "x": {}, "telegram": {}, "weibo": {}, "bilibili": {}, "zhihu": {},
	"youtube": {}, "github": {}, "xiaohongshu": {}, "douyin": {}, "jike": {},
	"instagram": {}, "facebook": {}, "reddit": {}, "pixiv": {}, "booru": {},
}

var feedFileExt = regexp.MustCompile(`(?i)\.(xml|rss|atom|json)$`)
var telegramPreviewRe = regexp.MustCompile(`(?i)^(https?://t\.me)/s/([^/?#]+)`)

// fallbackFeedTitle 默认订阅名：主站（声明的或反解的）优先，推不出退到实例域名。
// 三条输入都可能为空（OPML 里 site_url 常缺）；全推不出来时才保留原地址 —— 至少不是空名。
func fallbackFeedTitle(feedURL string, siteURL string) string {
	feedURL = strings.TrimSpace(feedURL)
	siteURL = strings.TrimSpace(siteURL)

	if label := titleFromSite(siteURL, feedURL); label != "" {
		return label
	}
	if label := titleFromRoute(feedURL); label != "" {
		return label
	}
	// 反解不出主站：用订阅地址自己的域名（RSSHub 实例），仍比整条 URL 好读
	if host := titleHostOf(feedURL); host != "" {
		if isAggregatorPath(feedURL) {
			if tail := routeTail(feedURL); tail != "" {
				return clampTitle(host + "/" + tail)
			}
		}
		return clampTitle(host)
	}
	return clampTitle(feedURL)
}

// titleFromSite 有主站地址时：host（去 www.）+ 可读路径尾段（最多两段、去掉 feed 文件后缀）。
func titleFromSite(siteURL string, feedURL string) string {
	host := titleHostOf(normalizeSiteURL(siteURL))
	if host == "" {
		return ""
	}
	path := pathOf(siteURL)
	if path == "" && isAggregatorPath(feedURL) {
		// 主站只给了域名、订阅走的是聚合实例：把路由尾段带上，同域的多条源才分得开
		path = routeTail(feedURL)
	}
	if path == "" {
		return clampTitle(host)
	}
	return clampTitle(host + "/" + path)
}

// titleFromRoute 没有主站、但订阅地址是已知的 RSSHub 路由：反解出主页再用它。
func titleFromRoute(feedURL string) string {
	resolved := resolveSiteFromRoute(feedURL)
	if resolved == "" {
		return ""
	}
	host := titleHostOf(resolved)
	if host == "" {
		return ""
	}
	if tail := pathOf(resolved); tail != "" {
		return clampTitle(host + "/" + tail)
	}
	return clampTitle(host)
}

// resolveSiteFromRoute 从订阅地址的 RSSHub 路由反解主页地址；认不出来返回空。
func resolveSiteFromRoute(feedURL string) string {
	path := cleanPath(feedURL)
	if path == "" {
		return ""
	}
	for _, pattern := range rsshubRoutePatterns {
		if pattern.re.MatchString(path) {
			return pattern.re.ReplaceAllString(path, pattern.tmpl)
		}
	}
	return ""
}

// normalizeSiteURL 与前端 feed-site.ts 同口径：Telegram 的 `t.me/s/<id>`（预览页）折回频道本身。
func normalizeSiteURL(raw string) string {
	return telegramPreviewRe.ReplaceAllString(strings.TrimSpace(raw), "$1/$2")
}

// isAggregatorPath 订阅地址像不像聚合实例（RSSHub 自身，或路径以已知命名空间开头）。
func isAggregatorPath(rawURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return false
	}
	if strings.Contains(strings.ToLower(parsed.Hostname()), "rsshub") {
		return true
	}
	segments := splitPath(parsed.Path)
	if len(segments) == 0 {
		return false
	}
	_, ok := rsshubNamespaces[strings.ToLower(segments[0])]
	return ok
}

// routeTail 路径里有信息量的最后一段（去掉 feed 文件后缀）：`/telegram/channel/Foo/feed` → `Foo`。
func routeTail(rawURL string) string {
	segments := splitPath(cleanPath(rawURL))
	if len(segments) == 0 {
		return ""
	}
	last := segments[len(segments)-1]
	if feedFileExt.MatchString(last) {
		if len(segments) < 2 {
			return ""
		}
		last = segments[len(segments)-2]
	}
	return last
}

// pathOf 地址的展示路径：去掉 feed 文件后缀、最多两段。
func pathOf(rawURL string) string {
	segments := splitPath(cleanPath(rawURL))
	if len(segments) == 0 {
		return ""
	}
	if feedFileExt.MatchString(segments[len(segments)-1]) {
		segments = segments[:len(segments)-1]
	}
	if len(segments) == 0 {
		return ""
	}
	if len(segments) > 2 {
		segments = segments[:2]
	}
	return strings.Join(segments, "/")
}

// cleanPath 取 path 并去掉结尾斜杠。
func cleanPath(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	return strings.TrimRight(parsed.Path, "/")
}

func splitPath(path string) []string {
	var out []string
	for _, part := range strings.Split(path, "/") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// titleHostOf 域名（去 `www.`、去端口、转小写）；解析不了返回空。
// 名字带 title 前缀：包里已有一个 `hostOf`（icon_service.go，不去 www.），语义不同不复用。
func titleHostOf(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	return strings.TrimPrefix(host, "www.")
}

func clampTitle(title string) string {
	runes := []rune(title)
	if len(runes) <= maxFallbackTitleLen {
		return title
	}
	return string(runes[:maxFallbackTitleLen])
}
