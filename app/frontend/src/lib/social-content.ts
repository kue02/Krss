/**
 * 社交媒体正文的规范化。
 *
 * 订阅走 RSSHub 时，正文里会带两类「结构性标记」：
 * - 一条 `<hr>` 分隔线（自带 12px 外边距），紧挨着 `<br><br>`，视觉上会撑出一大段空白；
 * - 引用推文放在 `.rsshub-quote` 里，容器本身没有任何样式。
 *
 * 分隔线在这里去掉，引用块改由 CSS 的左边框 + 间距区分
 * （样式见 index.css 的 `.entry-content .rsshub-quote`）。
 */
export function removeContentSeparators(
  html: string | null | undefined,
): string {
  if (!html) return "";

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const separators = Array.from(doc.body.querySelectorAll("hr"));
    if (separators.length === 0) return html;

    for (const hr of separators) {
      hr.remove();
    }

    return doc.body.innerHTML;
  } catch {
    return html;
  }
}
