/**
 * 把正文里的图片标签摘掉，只留文字。
 *
 * Folo 的社交媒体时间线条目就是这么做的：正文按 `noMedia` 渲染（纯文字），
 * 图片单独抽出来、在正文下方排成一行缩略图。这样长文的排版不会被大图打断，
 * 也不需要在 prose 里跟图片尺寸较劲。
 */
export function stripContentImages(
  html: string | null | undefined,
): string {
  if (!html) return "";

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");

    // 引文块（.rsshub-quote / blockquote）里的媒体属于引文本身，留在引文框里；
    // 只有正文自己的图片才摘出来放到底下那排缩略图（见用户反馈：引文里的图被甩到引文框外面）
    const inQuote = (el: Element) =>
      el.closest(".rsshub-quote, blockquote") !== null;

    for (const img of Array.from(doc.body.querySelectorAll("img, picture"))) {
      if (inQuote(img)) continue;
      img.remove();
    }

    // 只剩图片的 figure 会留下空壳，一并清掉（引文里的不动）
    for (const figure of Array.from(doc.body.querySelectorAll("figure"))) {
      if (inQuote(figure)) continue;
      if (!figure.textContent?.trim()) figure.remove();
    }

    return doc.body.innerHTML;
  } catch {
    return html;
  }
}
