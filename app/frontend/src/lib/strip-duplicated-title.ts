/**
 * 很多源在正文开头重复一遍标题（`<h1>标题</h1>` 或同文段落），
 * 时间线视图里标题已经单独渲染过，这里把正文首段的重复标题去掉。
 *
 * 只在「首段归一化后与标题相同」或「首段是 h1~h6 且包含标题」时删除，
 * 其余情况保守地原样返回。
 */
export function stripDuplicatedTitle(
  html: string | null | undefined,
  title?: string | null,
): string {
  if (!html) return "";
  if (!title) return html;

  const normalize = (value: string) =>
    value
      .replace(/\s+/g, "")
      .replace(
        /[「」『』“”"'《》…·\-—–_:：,，.。!！?？|/\\[\]()（）]/g,
        "",
      )
      .toLowerCase();

  const target = normalize(title);
  // 太短的标题（“早报”之类）命中太随机，不做处理
  if (target.length < 6) return html;

  try {
    const doc = new DOMParser().parseFromString(html, "text/html");

    // 先去掉开头空白文本节点
    let node: ChildNode | null = doc.body.firstChild;
    while (
      node &&
      node.nodeType === Node.TEXT_NODE &&
      !node.textContent?.trim()
    ) {
      const next: ChildNode | null = node.nextSibling;
      node.remove();
      node = next;
    }

    const first = doc.body.firstElementChild;
    if (!first) return html;

    const isHeading = /^H[1-6]$/.test(first.tagName);
    const text = normalize(first.textContent ?? "");
    if (text === target || (isHeading && text.includes(target))) {
      first.remove();
      return doc.body.innerHTML;
    }

    const firstChild: ChildNode | null = doc.body.firstChild;
    if (
      firstChild?.nodeType === Node.TEXT_NODE &&
      normalize(firstChild.textContent ?? "") === target
    ) {
      firstChild.remove();
      return doc.body.innerHTML;
    }

    return html;
  } catch {
    return html;
  }
}
