/**
 * 50-2：把正文里的头几张图「warm」进后端代理缓存。
 *
 * 为什么要有它：正文图片都走 `/api/proxy/image/...` 出网取一遍，而代理原来**没有
 * 服务端缓存**（实测同一张图连取三遍 0.708 / 0.967 / 0.669 s，一遍都不快）。
 * 现在后端会落盘，但第一次仍要出网 —— 预载时顺手把前几张取一遍，
 * 用户点开时这几张就是毫秒级。
 *
 * 用 `new Image()` 而不是 fetch：这样走的是浏览器自己的图片加载路径，
 * 同时把**浏览器缓存**和**后端磁盘缓存**都填上，后面真正渲染时两边都命中。
 */

import { extractImagesFromHtml } from "./extract-images";
import { getProxiedImageUrl } from "./image-proxy";

/** 默认 warm 几张：够盖住首屏，又不会为了用户可能不看的内容狂拉流量 */
export const DEFAULT_WARM_IMAGE_COUNT = 3;

export function warmEntryImages(
  content: string | null | undefined,
  articleUrl: string | undefined,
  limit: number = DEFAULT_WARM_IMAGE_COUNT,
): void {
  if (!content || limit <= 0) return;
  if (typeof Image === "undefined") return; // 非浏览器环境（测试/SSR）直接跳过

  let urls: string[];
  try {
    urls = extractImagesFromHtml(content);
  } catch {
    return;
  }

  for (const url of urls.slice(0, limit)) {
    const src = getProxiedImageUrl(url, articleUrl);
    if (!src || src.startsWith("data:")) continue;
    const img = new Image();
    img.decoding = "async";
    // 别与正在渲染的内容抢优先级
    img.fetchPriority = "low";
    img.src = src;
  }
}
