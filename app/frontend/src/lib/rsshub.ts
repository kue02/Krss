/**
 * RSSHub 实例适配。
 *
 * 场景：手里有一部分订阅走的是公共实例（rsshub.app）或别人的实例，
 * 想统一换到自己的实例（比如 https://rsshub.example.com）并且带上 ACCESS_KEY。
 */

/** 判断是否像是 RSSHub 的地址（公共实例、含 rsshub 的主机名，或用户显式声明的实例） */
export function isRssHubUrl(raw: string, extraHosts: string[] = []): boolean {
  const parsed = safeParse(raw);
  if (!parsed) return false;

  const host = parsed.hostname.toLowerCase();
  if (host === "rsshub.app" || host.includes("rsshub")) return true;

  return extraHosts.some((item) => {
    const extra = safeParse(item);
    return extra ? extra.hostname.toLowerCase() === host : false;
  });
}

/**
 * 把 RSSHub 地址换到目标实例。
 *
 * - 保留原路径与查询参数（路由后缀不动）
 * - accessKey 非空时写入 `key` 参数，为空时清掉 `key`
 * - 目标实例本身带路径前缀时（如 https://example.com/rsshub）会拼在前面
 *
 * 返回新地址；不是 RSSHub 地址或解析失败时返回 null（调用方保持原样）。
 */
export function rewriteRssHubUrl(
  raw: string,
  base: string,
  accessKey?: string,
  extraHosts: string[] = [],
): string | null {
  const source = safeParse(raw);
  const target = safeParse(base);
  if (!source || !target) return null;
  if (!isRssHubUrl(raw, extraHosts)) return null;

  const parsed = new URL(target.toString());
  const prefix = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${prefix}${source.pathname}`;
  parsed.search = source.search;
  parsed.hash = "";

  const key = (accessKey ?? "").trim();
  if (key) {
    parsed.searchParams.set("key", key);
  } else {
    parsed.searchParams.delete("key");
  }

  return parsed.toString();
}

function safeParse(raw: string): URL | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
}
