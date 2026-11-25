import { NON_CONTENT_TAG_SELECTOR } from "./html-content-tags";

/**
 * 第四十三批（移动端性能）：`stripHtml` 的有界 LRU 缓存。
 *
 * 列表每一行、通知卡、翻译摘要都会对同一段正文反复 `stripHtml`（切 tab / 回滚会
 * 重新挂载组件）。每次 `new DOMParser().parseFromString` 对长文都很贵，这里按
 * html 字符串缓存结果，命中直接返回同一份字符串。
 *
 * 必须有界：正文 HTML 可能很大，无界缓存会把整段正文留在内存里。
 *   - 最多 {@link STRIP_CACHE_MAX_ENTRIES} 条；
 *   - 累计保留的 html 字符数不超过 {@link STRIP_CACHE_MAX_CHARS}。
 * 用 `Map` 的插入顺序当 LRU：命中时先 delete 再 set 移到末尾；超限从最旧（队首）
 * 淘汰，直到两条约束都满足。
 */
const STRIP_CACHE_MAX_ENTRIES = 80;
const STRIP_CACHE_MAX_CHARS = 4_000_000;
const stripCache = new Map<string, string>();
let stripCacheChars = 0;

/** 纯计算：解析一遍 HTML 并取正文纯文本。无缓存、无副作用。 */
function computeStripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll(NON_CONTENT_TAG_SELECTOR)
    .forEach((element) => element.remove());
  return doc.body.textContent || "";
}

/**
 * Strip HTML tags and return plain text content.
 *
 * 结果按 html 字符串做有界 LRU 缓存（见上），相同 html 第二次返回同一份结果，
 * 不再重复 `DOMParser` 解析。空串直接返回、不进缓存。
 */
export function stripHtml(html: string): string {
  if (!html) {
    return "";
  }

  const cached = stripCache.get(html);
  if (cached !== undefined) {
    // 命中：移到末尾，标记为最近使用
    stripCache.delete(html);
    stripCache.set(html, cached);
    return cached;
  }

  const result = computeStripHtml(html);

  // 先淘汰最旧的，直到满足「条数 < 上限」且「加入后字符数 <= 上限」
  while (
    stripCache.size > 0 &&
    (stripCache.size >= STRIP_CACHE_MAX_ENTRIES ||
      stripCacheChars + html.length > STRIP_CACHE_MAX_CHARS)
  ) {
    const oldest = stripCache.keys().next().value;
    if (oldest === undefined) break;
    stripCache.delete(oldest);
    stripCacheChars -= oldest.length;
  }

  stripCache.set(html, result);
  stripCacheChars += html.length;
  return result;
}
