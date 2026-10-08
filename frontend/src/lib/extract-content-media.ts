/**
 * 社交媒体视图的正文图片清单（第四十二批）。
 *
 * 与 `extract-images.ts` 的区别：**带尺寸**。
 *
 * 为什么单独一份而不是给 `getEntryImages` 加参数：图片视图 / 照片墙 / 灯箱
 * 全都调 `getEntryImages()`，它们要的是「一堆 URL」；社交视图要的是
 * 「每张图的宽高」，因为它按原图比例排版（112×112 正方形会把 2048×570 的
 * 横图压成一条细带，见 §2.40）。两条需求的返回值形状不同，混在一起会让
 * 每个调用点都要判一次「我到底用不用 width/height」。
 *
 * 尺寸三级兜底（与 Folo 同构，krss 缺第一级）：
 *  1. `<img>` 的 `width`/`height` 属性（Twitter 系 RSSHub 会带，137/439 张）
 *  2. `image-dimensions-store` 里上次量到的缓存
 *  3. `onLoad` 实测 → 写回 store（第二次出现就是同步命中）
 * 本模块只负责第 1 级 + 给出前两级的 key；第 2/3 级在 `SocialMediaGallery` 里。
 *
 * ⚠️ store 的 key 必须是**原始 URL**：`PictureItem.tsx:45` 用的就是
 * `entry.thumbnailUrl`（未代理）。代理 URL 带 base64 路径 + `?ref=`，
 * 每次拼法都一样但与原始 URL 不是同一个 key —— 用代理 URL 当 key 会让
 * 图片视图和社交视图各存一份缓存。§2.40-42-1 就是这条。
 */

/** 一张正文图片。`src` 是原始 URL（store key / 去重用），不是代理 URL。 */
export interface ContentMedia {
  src: string;
  /** `<img>` 上的 width；缺失或 0（0 常见于「未知尺寸」写法）时为 undefined */
  width?: number;
  /** `<img>` 上的 height；同上 */
  height?: number;
}

/**
 * HTML 实体反转义。
 *
 * `DOMParser` 读到的 `img.src` 已经把 `&amp;` 解成 `&` 了，但我们要用
 * `getAttribute("src")` 才能同时拿到 width/height，而属性值是**未解实体**的。
 * 不解就会让 `thumbnail_url`（`...&name=orig`）和正文里的
 * （`...&amp;name=orig`）比不上 ⇒ 首图被判成两张图。
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** 只认 http/https 与站点绝对路径（`/path`），其余（data:、blob:、协议相对）丢弃 */
function normalizeSrc(raw: string, baseUrl?: string): string | null {
  const src = decodeEntities(raw).trim();
  if (!src) return null;
  if (src.startsWith("data:") || src.startsWith("blob:")) return null;
  if (src.startsWith("//")) return `https:${src}`;
  if (src.startsWith("/")) {
    if (!baseUrl) return null;
    try {
      return new URL(src, baseUrl).toString();
    } catch {
      return null;
    }
  }
  if (!/^https?:\/\//i.test(src)) return null;
  return src;
}

/** 比较用：去掉 query 与 fragment，`pbs.twimg.com/media/X?format=jpg&name=orig` → `pbs.twimg.com/media/X` */
function comparableKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function positiveInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 从正文 HTML 里抽出图片清单（带可用的 width/height）。
 *
 * @param html       条目正文
 * @param baseUrl    条目地址，用于把 `/path` 这类站点绝对路径补全
 * @param thumbnailUrl 条目的 `thumbnail_url`。实测社交条目里它**永远是正文首图**
 *   （507 条逐条比对，0 条例外），所以这里把它当「候选首图」而不是额外图片 ——
 *   否则它会和正文首图重复渲染两次。
 *   注意：去重只在 `thumbnailUrl` 确实命中正文某张图时生效，命中了就整条丢掉
 *   （保留正文那份，它带尺寸）；没命中才把 thumbnail 作为第一张加入。
 */
export function extractContentMedia(
  html: string | null | undefined,
  baseUrl?: string,
  thumbnailUrl?: string,
): ContentMedia[] {
  if (!html) return normalizeSingle(thumbnailUrl, baseUrl);

  let media: ContentMedia[];
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    media = [];
    const seen = new Set<string>();

    for (const img of Array.from(doc.querySelectorAll("img"))) {
      const src = normalizeSrc(img.getAttribute("src") ?? "", baseUrl);
      if (!src) continue;
      // 与 extract-images.ts 同口径：懒加载站会把真地址放 data-src
      const lazy =
        img.getAttribute("data-src") ?? img.getAttribute("data-lazy-src");
      const finalSrc = lazy ? (normalizeSrc(lazy, baseUrl) ?? src) : src;
      const key = comparableKey(finalSrc);
      if (seen.has(key)) continue;
      seen.add(key);
      media.push({
        src: finalSrc,
        width: positiveInt(img.getAttribute("width")),
        height: positiveInt(img.getAttribute("height")),
      });
    }
  } catch {
    media = [];
  }

  const thumb = thumbnailUrl
    ? normalizeSrc(thumbnailUrl, baseUrl)
    : null;
  if (thumb) {
    const key = comparableKey(thumb);
    // 命中正文 → 丢掉 thumbnail（正文那份才带尺寸）
    // 没命中 → 当第一张（有些源的 thumbnail 不在正文里）
    if (!media.some((m) => comparableKey(m.src) === key)) {
      media.unshift({ src: thumb });
    }
  }

  return media;
}

function normalizeSingle(
  thumbnailUrl: string | undefined,
  baseUrl: string | undefined,
): ContentMedia[] {
  const src = thumbnailUrl ? normalizeSrc(thumbnailUrl, baseUrl) : null;
  return src ? [{ src }] : [];
}

/** 比例是否都一致（决定走横排还是 grid）。
 *
 *  与 Folo `media-gallery.tsx:25-40` 同口径：**任何一张缺尺寸就判定为不一致**，
 *  因为那样没法算出每张的盒子高度。`allowUnknownRatio` 只在「调用方确认
 *  尺寸已从 store 补齐」时为真 —— 也就是渲染那一刻尺寸都已知的场合。 */
export function isSameRatio(
  media: ContentMedia[],
  allowUnknownRatio = false,
): boolean {
  if (media.length <= 1) return true;
  let ratio = 0;
  for (const item of media) {
    if (!item.width || !item.height) return allowUnknownRatio;
    const current = item.height / item.width;
    if (ratio === 0) ratio = current;
    // Folo 用严格相等；这里给 0.5% 容差，避免 1/3 与 0.3333 这类舍入判成不一致
    else if (Math.abs(current - ratio) / ratio > 0.005) return false;
  }
  return true;
}

/** grid 分支的列数（Folo `media-gallery.tsx:115-121`：2~4 张两列，5+ 三列） */
export function gridColumns(count: number): 2 | 3 {
  return count >= 5 ? 3 : 2;
}

/**
 * 单图封顶后的盒子尺寸（Folo `media-gallery.tsx:56-63`）。
 *
 * 宽 = 容器宽，高按比例；**超过 `maxHeight` 就改成「高 = maxHeight、宽按比例收」**，
 * 于是两侧留边、**不裁切任何像素**。多图不封顶 —— Folo 只对单图封顶，
 * 那是它的逻辑现状（不是抄漏）；本项目照此执行，不额外引入裁切。
 */
export function computeSingleBox(
  containerWidth: number,
  width: number,
  height: number,
  maxHeight: number,
): { width: number; height: number } {
  const ratio = height / width;
  const fullWidth = containerWidth;
  const fullHeight = fullWidth * ratio;
  if (fullHeight > maxHeight) {
    return { width: maxHeight / ratio, height: maxHeight };
  }
  return { width: fullWidth, height: fullHeight };
}

/** 横排分支里每张图的宽度（Folo `media-gallery.tsx:53-74`，gap 固定 8px） */
export function rowItemWidth(count: number, containerWidth: number): number {
  if (count === 1) return containerWidth;
  if (count === 2) return (containerWidth - 8) / 2;
  return containerWidth / 3;
}