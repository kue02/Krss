import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/server-url";
import { LS_KEYS } from "@/lib/settings-storage";

/**
 * App（自定义 scheme）里 `<img>` 无法带 Authorization 头，而 `/api/proxy/*` 走 JWT；
 * 这里用带 token 的 fetch 取回二进制，再换成 blob: URL 交给 `<img>`。
 * 网页同源构建（API_BASE_URL 为空）直接透传，不增加任何请求。
 *
 * 复审 P2：blob URL 不回收会一直涨内存，登出后旧 token 的图也不该留着。
 * 这里用「插入序即最近使用序」的 LRU（命中时先删再放回队尾），超限回收最旧的；
 * 登出时由 `clearAuthToken()` 调 `clearAuthedImageCache()` 全量 revoke。
 */
const BLOB_CACHE_LIMIT = 64;
const blobCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function needsAuth(src: string | undefined): src is string {
  return Boolean(API_BASE_URL) && Boolean(src?.startsWith(`${API_BASE_URL}/api/`));
}

function cacheKey(src: string): string {
  return `${localStorage.getItem(LS_KEYS.authToken.key) ?? ""}\u0000${src}`;
}

function revoke(url: string | undefined): void {
  if (!url || !url.startsWith("blob:")) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // 测试环境/旧 WebView 没有 revoke：忽略，交给页面销毁
  }
}

function remember(key: string, url: string): void {
  const previous = blobCache.get(key);
  if (previous && previous !== url) revoke(previous);
  // 命中/更新都挪到队尾，Map 的插入序就是 LRU 的顺序
  blobCache.delete(key);
  blobCache.set(key, url);
  while (blobCache.size > BLOB_CACHE_LIMIT) {
    const oldestKey = blobCache.keys().next().value;
    if (oldestKey === undefined) break;
    revoke(blobCache.get(oldestKey));
    blobCache.delete(oldestKey);
  }
}

/** 取回需要鉴权的图片，返回 blob URL；同源构建或非 /api/ 地址直接返回原地址。 */
export async function getAuthedImageUrl(
  src: string | undefined,
): Promise<string | null> {
  if (!src) return null;
  if (!needsAuth(src)) return src;
  const key = cacheKey(src);
  const cached = blobCache.get(key);
  if (cached) {
    remember(key, cached);
    return cached;
  }
  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async () => {
    try {
      const token = localStorage.getItem(LS_KEYS.authToken.key);
      const response = await fetch(src, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) return null;
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      remember(key, objectUrl);
      return objectUrl;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/**
 * 复审 P2：App 内图片加载失败时，可能是 token 刚被刷新/替换。丢掉旧的 blob 缓存，
 * 用当前 localStorage 里的 token 重新取一次；仍然失败才交给调用方进占位。
 */
export async function refetchAuthedImageUrl(
  src: string | undefined,
): Promise<string | null> {
  if (!src || !needsAuth(src)) return getAuthedImageUrl(src);
  const key = cacheKey(src);
  revoke(blobCache.get(key));
  blobCache.delete(key);
  inflight.delete(key);
  return getAuthedImageUrl(src);
}

/** 登出/会话失效时清空所有 blob URL，避免旧账号的图片留在内存里。 */
export function clearAuthedImageCache(): void {
  for (const url of blobCache.values()) revoke(url);
  blobCache.clear();
  inflight.clear();
}

interface UseAuthedImageOptions {
  /** 先不取（例如有封面的视频，等悬停再拉流），命中缓存时仍直接返回。 */
  enabled?: boolean;
  /** 换一个值强制重取（token 刷新后的重试用）。 */
  refreshKey?: number;
}

/** 返回可直接给 `<img src>` 的地址；未取回前返回 undefined。 */
export function useAuthedImageUrl(
  src: string | undefined,
  options: UseAuthedImageOptions = {},
): string | undefined {
  const { enabled = true, refreshKey = 0 } = options;
  const auth = needsAuth(src);
  const [resolved, setResolved] = useState<string | undefined>(() => {
    if (!src) return undefined;
    if (!auth) return src;
    return blobCache.get(cacheKey(src));
  });

  useEffect(() => {
    if (!src) {
      setResolved(undefined);
      return;
    }
    if (!auth) {
      setResolved(src);
      return;
    }
    if (!enabled) {
      setResolved(blobCache.get(cacheKey(src)));
      return;
    }
    let cancelled = false;
    setResolved(blobCache.get(cacheKey(src)));
    void getAuthedImageUrl(src).then((url) => {
      if (!cancelled) setResolved(url ?? undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [src, auth, enabled, refreshKey]);

  return resolved;
}

/** 批量版本：给照片墙/图集用，保持顺序与长度；未取回/失败时给空串占位。 */
export function useAuthedImageUrls(srcs: string[]): string[] {
  const signature = srcs.join("\u0000");
  const [resolved, setResolved] = useState<string[]>(() =>
    srcs.map((src) => (needsAuth(src) ? (blobCache.get(cacheKey(src)) ?? "") : src)),
  );
  useEffect(() => {
    let cancelled = false;
    void Promise.all(srcs.map((src) => getAuthedImageUrl(src))).then((urls) => {
      if (!cancelled) setResolved(urls.map((url) => url ?? ""));
    });
    return () => {
      cancelled = true;
    };
    // signature 覆盖内容变化，避免调用方每次传新数组导致重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return resolved;
}