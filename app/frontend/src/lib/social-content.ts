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

    /*
     * 只动「开头那一个文本节点」里的作者名。
     *
     * 原来是读 quote.textContent 之后把内容整体重建成两个 span —— 文本以外的节点
     * （引文里的图片、视频、链接）会被一并丢掉，于是引文只剩一行字：
     * 用户报的「点开正文看不到图片」和「引文里的媒体没被引文样式兜住」都是这个原因。
     */
    const walker = doc.createTreeWalker(quote, NodeFilter.SHOW_TEXT);
    const firstText = walker.nextNode();
    const value = firstText?.nodeValue;
    if (!firstText || !value) continue;

    // 作者名一般很短，且后面跟中英文冒号（且必须出现在整段开头）
    const match = /^\s*([^：:\n]{1,30}?)\s*[：:]\s*/.exec(value);
    if (!match) continue;

    const author = match[1]?.trim() ?? "";
    if (!author) continue;

    const authorEl = doc.createElement("span");
    authorEl.className = "rsshub-quote-author";
    authorEl.textContent = author;

    firstText.parentNode?.insertBefore(authorEl, firstText);
    // 剩下的正文留在原文本节点里，后面的图片/视频/链接原样保留
    firstText.nodeValue = value.slice(match[0].length);
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
