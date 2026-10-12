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

/**
 * 47-5（用户 2026-10-12）：把社交正文按「引文块」切成两段。
 *
 * 用户原话：「这个本质就是两段，一段正文，一段引文，这两个的排序是根据来源顺序决定的，
 * 跟这两段里的图片无关」—— 卡片原先把整块 prose（正文 + 末尾引文）一起塞进 300px 折叠容器、
 * 正文自己的图片被抽成画廊挂在**整块之后**，于是浏览器里看到的是「正文 → 引文 → 正文图片」，
 * 与原帖顺序（正文 → 正文图片 → 引文）相反。
 *
 * 返回：
 *   - `body`  = 第一个引文块**之前**的内容（含正文自己的文字，图片已被 `stripContentImages` 摘走）
 *   - `quote` = 从第一个引文块起（含它后面的一切）的内容
 * 没有引文块时 `quote` 是空串，调用方按「不分段」走原来的样子。
 *
 * 只在顶层子节点里找引文块：RSSHub 的 `.rsshub-quote` 与 Telegram 的 `<blockquote>` 都排在顶层
 * （`normalizeQuoteBlocks` 也是这个口径）。引文块在开头（正文为空）时 `body` 为空串。
 */
export function splitSocialQuote(html: string | null | undefined): {
  body: string;
  quote: string;
} {
  if (!html) return { body: "", quote: "" };

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const nodes = Array.from(doc.body.childNodes);
    const index = nodes.findIndex(
      (node) =>
        node.nodeType === 1 &&
        ((node as Element).classList?.contains("rsshub-quote") ||
          (node as Element).tagName === "BLOCKQUOTE"),
    );
    if (index < 0) return { body: html, quote: "" };

    // 用容器序列化而不是读 `outerHTML`：文本节点没有 outerHTML，硬读会丢掉正文里的纯文字
    const serialize = (list: ChildNode[]) => {
      const container = doc.createElement("div");
      for (const node of list) container.appendChild(node.cloneNode(true));
      return container.innerHTML;
    };

    return {
      body: serialize(nodes.slice(0, index)),
      quote: serialize(nodes.slice(index)),
    };
  } catch {
    return { body: html, quote: "" };
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
