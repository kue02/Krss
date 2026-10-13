/**
 * 订阅的「主站地址」（用户 11-11）—— 右键订阅 →「前往主站 / 复制主站地址」用。
 *
 * 两条来源，优先级从高到低：
 *   1. 订阅元数据里的 `site_url`：抓取时从 feed 里带回来的正牌主页（本机库里 77 个订阅有 73 个有），
 *      例如 Twitter @歸藏 → `https://x.com/op7418`、Telegram 频道 → `https://t.me/s/XiaoZhangDuBao`。
 *   2. RSSHub 的路由反解：`site_url` 为空时从订阅地址的路径推主页
 *      （`/twitter/user/op7418` → `x.com/op7418`）。
 *
 * 推不出来时返回 null，让调用方藏起菜单项 —— **宁可没有，也别给一个看着像主页其实是 RSSHub 实例的地址**。
 */
export interface FeedSiteSource {
  siteUrl?: string | null;
  url?: string | null;
}

/** RSSHub 路由反解表：只认「路径结构固定」的这几家，其余一律不猜 */
const RSSHUB_ROUTE_PATTERNS: { test: RegExp; resolve: (m: RegExpMatchArray) => string | null }[] = [
  { test: /^\/twitter\/user\/([^/]+)/, resolve: (m) => `https://x.com/${m[1]}` },
  { test: /^\/twitter\/keyword\/([^/]+)/, resolve: (m) => `https://x.com/search?q=${encodeURIComponent(m[1] ?? "")}` },
  { test: /^\/telegram\/channel\/([^/]+)/, resolve: (m) => `https://t.me/${m[1]}` },
  { test: /^\/weibo\/user\/([^/]+)/, resolve: (m) => `https://weibo.com/u/${m[1]}` },
  { test: /^\/bilibili\/user\/(?:video|dynamic)\/([^/]+)/, resolve: (m) => `https://space.bilibili.com/${m[1]}` },
  { test: /^\/zhihu\/(?:people\/)?(?:activities|posts)\/([^/]+)/, resolve: (m) => `https://www.zhihu.com/people/${m[1]}` },
  { test: /^\/youtube\/(user|channel)\/([^/]+)/, resolve: (m) => `https://www.youtube.com/${m[1]}/${m[2]}` },
  {
    test: /^\/github\/(?:repos|issue|pull)\/([^/]+)(?:\/([^/]+))?/,
    resolve: (m) => (m[2] ? `https://github.com/${m[1]}/${m[2]}` : `https://github.com/${m[1]}`),
  },
  { test: /^\/xiaohongshu\/user\/([^/]+)/, resolve: (m) => `https://www.xiaohongshu.com/user/profile/${m[1]}` },
  { test: /^\/douyin\/user\/([^/]+)/, resolve: (m) => `https://www.douyin.com/user/${m[1]}` },
  { test: /^\/jike\/user\/([^/]+)/, resolve: (m) => `https://web.okjike.com/u/${m[1]}` },
];

/** RSSHub 的常见命名空间：路径以它们开头、又不在上面的表里 ⇒ 认得出是 RSSHub，但不知道主页在哪 */
const RSSHUB_NAMESPACES = new Set([
  "twitter", "x", "telegram", "weibo", "bilibili", "zhihu", "youtube", "github",
  "xiaohongshu", "douyin", "jike", "instagram", "facebook", "reddit", "pixiv", "booru",
]);

/** Telegram 的 `site_url` 常是 `t.me/s/<id>`（频道预览页）—— 直接给频道本身更像「主站」 */
function normalizeSiteUrl(raw: string): string {
  return raw.replace(/^(https?:\/\/t\.me)\/s\/([^/?#]+)/, "$1/$2");
}

/**
 * 52-5：自动分组用的「网站域名」—— 只取 host 这一级，口径与上面的主站解析完全一致。
 *
 * **推不出主站就返回 null（= 这条不参与分组）**，不退到订阅地址自己的 host：
 * 用户拍板的是「按反解后的主站域名（x.com / t.me / appinn.com）分」，
 * 明确否掉了「用 RSSHub 实例 host —— 那等于把所有源塞进同一个文件夹」。
 * 认不出主站时宁可不分，也别建一个 `rsshub.xxx` 的大杂烩夹。
 */
export function groupDomainFor(feed: FeedSiteSource): string | null {
  const siteUrl = resolveFeedSiteUrl(feed);
  if (siteUrl) {
    const host = hostnameOf(siteUrl);
    if (host) return host.toLowerCase().replace(/^www\./, "");
    return null;
  }
  // 反解不出主站时的退路（52-5 实测发现：a.xml 这种没带 <link> 的源 site_url 是空的，
  // 又因「`.xml` 结尾不算主页」被 resolveFeedSiteUrl 判死 —— 结果同域名的两条散订阅永远分不到一起）。
  //
  // 这条退路只对**普通 feed** 开：它的地址 host 就是网站域名（blog.example.com/rss.xml）。
  // RSSHub 一类仍然不分 —— 那正是拍板否掉的「所有源挤进 rsshub.xxx 一个大杂烩夹」。
  const plain = plainHostOf(feed.url);
  if (!plain) return null;
  return plain.toLowerCase().replace(/^www\./, "");
}

/** 订阅地址自己的 host，仅当它不像 RSSHub/聚合器时才给 —— 判定口径与 resolveFeedSiteUrl 一致 */
function plainHostOf(rawUrl: string | null | undefined): string | null {
  const value = (rawUrl ?? "").trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const segments = parsed.pathname.replace(/\/+$/, "").split("/");
  const looksRSSHub =
    parsed.hostname.toLowerCase().includes("rsshub") ||
    RSSHUB_NAMESPACES.has((segments[1] ?? "").toLowerCase());
  if (looksRSSHub) return null;
  return parsed.hostname || null;
}

function hostnameOf(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

export function resolveFeedSiteUrl(feed: FeedSiteSource): string | null {
  const declared = (feed.siteUrl ?? "").trim();
  if (/^https?:\/\//i.test(declared)) return normalizeSiteUrl(declared);

  const raw = (feed.url ?? "").trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  // 订阅地址常带 RSSHub 的 key 等查询参数，只看路径
  const path = parsed.pathname.replace(/\/+$/, "");
  const segments = path.split("/");
  for (const pattern of RSSHUB_ROUTE_PATTERNS) {
    const matched = path.match(pattern.test);
    if (matched) return pattern.resolve(matched);
  }

  const host = parsed.hostname.toLowerCase();
  const looksRSSHub =
    host.includes("rsshub") || RSSHUB_NAMESPACES.has((segments[1] ?? "").toLowerCase());
  if (looksRSSHub) return null; // 是 RSSHub，但这条路由认不出来
  if (/\.(xml|rss|atom|json)$/i.test(parsed.pathname)) return null; // 纯 feed 文件，不是主页
  return parsed.origin;
}
