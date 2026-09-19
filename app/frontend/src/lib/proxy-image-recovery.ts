import { getCurrentUser } from "@/api";

/**
 * 24-4：代理图的 cookie 自愈。
 *
 * `<img>` 带不上 Bearer，代理接口认的是 `gist_auth` cookie —— cookie 一掉
 * （过期 / 被清），图就 401，文字走 API 反而没事。后端已在 `GET /api/auth/me`
 * 里加了顺手重写（有效 Bearer 来就重写 cookie），这里是前端兜底：
 * 图挂了先调一次 `/auth/me`（localStorage 的 token 还活着就能把 cookie 写回来），
 * 再换个 URL（`_r=1`，后端忽略）绕开失败缓存重载一次。
 *
 * 两处接入：
 *   - 带错误态的 React 图片（ArticleImage、列表缩略图）：走下面的 helper，
 *     在自己的 onError 里先救、救不回来才进占位 / 隐藏（全局监听够不着它们——
 *     它们出错就把 img 卸载了）；
 *   - 其余裸 `<img>`：`initProxyImageRecovery()` 全局兜底，每张图只救一次。
 *
 * 验收：清 cookie 后进列表，图应自愈，无需重登。
 */

const RETRIED_FLAG = "proxyRecovered";
let installed = false;
let renewing: Promise<unknown> | null = null;

/** cookie 续期一次（并发只发一个请求，失败自己吞——调用方只管重载）。 */
export function renewProxyCookie(): Promise<void> {
  if (!renewing) {
    renewing = getCurrentUser()
      .catch(() => {
        // Bearer 也失效了（真掉线）：auth-store 的 onUnauthorized 会处理登出，
        // 这里只保证不把图卡在重试循环里。
      })
      .finally(() => {
        renewing = null;
      });
  }
  return renewing.then(() => undefined);
}

/** 只有代理图才值得救（后端只认路径里的 base64，`_r` 参数忽略）。 */
export function isRecoverableProxyUrl(url: string): boolean {
  return url.includes("/api/proxy/");
}

/** 换个 URL 绕开失败缓存（不要在续期前调，续期是 Set-Cookie 先落盘）。 */
export function withProxyCacheBust(url: string): string {
  if (url.includes("_r=1")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}_r=1`;
}

function handleError(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLImageElement)) return;
  const src = target.currentSrc || target.src;
  if (!isRecoverableProxyUrl(src)) return;
  if (target.dataset[RETRIED_FLAG] === "1") return;
  target.dataset[RETRIED_FLAG] = "1";

  void renewProxyCookie().finally(() => {
    const next = withProxyCacheBust(src);
    if (target.src !== next) target.src = next;
  });
}

/** 在 App 挂载一次，多次调用只有第一次生效（测试用 resetProxyImageRecovery 解锁）。 */
export function initProxyImageRecovery(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", handleError, true);
}

/** 测试用 */
export function resetProxyImageRecovery(): void {
  if (!installed) return;
  installed = false;
  window.removeEventListener("error", handleError, true);
}
