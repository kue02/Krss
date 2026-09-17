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

/**
 * 引文块（.rsshub-quote）的内容通常是「作者: 正文」一行文本，
 * 一行读起来和正文糊在一起（Folo 是把作者单独拎出来做小标题的）。
 * 这里把「作者」拆成独立的元素，方便 CSS 给它单独的字重/颜色。
 */
function normalizeQuoteBlocks(doc: Document): void {
  for (const quote of Array.from(doc.querySelectorAll(".rsshub-quote"))) {
    if (quote.querySelector(".rsshub-quote-author")) continue;
    const text = quote.textContent ?? "";
    // 作者名一般很短，且后面跟中英文冒号
    const match = /^\s*([^：:\n]{1,30})\s*[：:]\s*([\s\S]+)$/.exec(text);
    if (!match) continue;

    const author = match[1] ?? "";
    const rest = match[2] ?? "";
    quote.textContent = "";
    const authorEl = doc.createElement("span");
    authorEl.className = "rsshub-quote-author";
    authorEl.textContent = author.trim();
    const bodyEl = doc.createElement("span");
    bodyEl.textContent = rest.trim();
    quote.append(authorEl, bodyEl);
  }
}

export function removeContentSeparators(
  html: string | null | undefined,
): string {
  if (!html) return "";

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const separators = Array.from(doc.body.querySelectorAll("hr"));
    const hasQuotes = doc.body.querySelector(".rsshub-quote") !== null;
    if (separators.length === 0 && !hasQuotes) return html;

    for (const hr of separators) {
      hr.remove();
    }

    normalizeQuoteBlocks(doc);

    return doc.body.innerHTML;
  } catch {
    return html;
  }
}
