/**
 * 正文视频识别与白名单工具。
 *
 * 两件事：
 * 1. 判断一个地址是不是「直接视频文件」（.mp4 / .webm / .m3u8 …），
 *    用于正文为空但 entry.url 本身就是视频文件的小站订阅。
 * 2. 归一用户填写的 iframe 视频站点（可填域名或完整 URL），并做 host 匹配。
 *
 * 这里只做纯字符串/URL 判断，不依赖 React，便于单测。
 */

/** 直接视频文件扩展名（不含点）。m3u8 是 HLS 播放列表。 */
const DIRECT_VIDEO_EXTENSIONS = [
  ".mp4",
  ".webm",
  ".m3u8",
  ".mov",
  ".m4v",
  ".ogv",
  ".ogg",
] as const;

/** 内置允许内嵌的 iframe 视频站点（用户白名单是在此之上追加）。 */
export const BUILTIN_IFRAME_VIDEO_HOSTS: readonly string[] = [
  "bilibili.com",
  "youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
  "fast.wistia.net",
  "wistia.net",
];

function toHttpUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/** entry.url 是否是直接的视频文件地址（大小写不敏感，忽略 query / hash）。 */
export function isDirectVideoUrl(raw: string | null | undefined): boolean {
  const url = toHttpUrl(raw);
  if (!url) return false;
  const path = url.pathname.toLowerCase();
  return DIRECT_VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * 把用户输入归一成主机名：
 * - 支持 `example.com`、`https://example.com/path`、`//example.com`；
 * - 去掉端口、通配前缀 `*.` 与首尾空白；
 * - 非法输入返回 null。
 */
export function normalizeIframeVideoHost(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  let host: string;
  if (/^(https?:)?\/\//i.test(value)) {
    const url = toHttpUrl(value);
    if (!url) return null;
    host = url.hostname;
  } else {
    host = value.split("/")[0]?.split("?")[0]?.split("#")[0] ?? "";
  }

  host = host.toLowerCase().replace(/^\*?\./, "").trim();
  if (!host) return null;
  // 允许 a-z 0-9 - .（含 punycode）；不允许空格、路径、端口等残留。
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (!host.includes(".")) return null;
  return host;
}

/** 主机是否命中规则（规则可以是根域，也匹配其子域）。 */
export function hostMatchesRules(
  hostname: string,
  rules: readonly string[],
): boolean {
  const host = hostname.toLowerCase();
  return rules.some((rule) => {
    const normalized = rule.toLowerCase().replace(/^\*?\./, "");
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

/** 合并内置白名单与用户白名单，去重后返回。 */
export function mergeIframeVideoHosts(
  extraHosts: readonly string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const host of [...BUILTIN_IFRAME_VIDEO_HOSTS, ...(extraHosts ?? [])]) {
    const normalized = normalizeIframeVideoHost(host);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}
