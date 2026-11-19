import { useEffect, useState } from "react";
import { API_BASE_URL } from "@/lib/server-url";
import { LS_KEYS } from "@/lib/settings-storage";

/**
 * App（自定义 scheme）里 `<img>` 无法带 Authorization 头，而 `/api/proxy/*` 走 JWT；
 * 这里用带 token 的 fetch 取回二进制，再换成 blob: URL 交给 `<img>`。
 * 网页同源构建（API_BASE_URL 为空）直接透传，不增加任何请求。
 */
const blobCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function needsAuth(src: string | undefined): src is string {
  return Boolean(API_BASE_URL) && Boolean(src?.startsWith(`${API_BASE_URL}/api/`));
}

function cacheKey(src: string): string {
  return `${localStorage.getItem(LS_KEYS.authToken.key) ?? ""}\u0000${src}`;
}

/** 取回需要鉴权的图片，返回 blob URL；同源构建或非 /api/ 地址直接返回原地址。 */
export async function getAuthedImageUrl(
  src: string | undefined,
): Promise<string | null> {
  if (!src) return null;
  if (!needsAuth(src)) return src;
  const key = cacheKey(src);
  const cached = blobCache.get(key);
  if (cached) return cached;
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
      blobCache.set(key, objectUrl);
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

/** 返回可直接给 `<img src>` 的地址；未取回前返回 undefined。 */
export function useAuthedImageUrl(src: string | undefined): string | undefined {
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
    let cancelled = false;
    void getAuthedImageUrl(src).then((url) => {
      if (!cancelled) setResolved(url ?? undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [src, auth]);

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
