/**
 * 56-22：正文装饰绘制。
 *
 * 契约（后端 `GET /api/entries/:id/decorations`）：插件交上来的是**纯文本的 rune 下标**
 * （`start`/`end`），宿主负责把它落到 DOM 上。这里只做两件事：
 *   ① 把区间在「正文容器的文本节点」上定位，包成 `<mark data-plugin data-decoration-id>`；
 *   ② 给一个还原函数，把 mark 拆回文本（切条目 / 重渲染前必须调，否则标注会跟着正文一起
 *      被 React 当成陌生节点，越积越多）。
 *
 * 三条口径：
 *   - **rune 下标**：一条 emoji（代理对）算 1 个位置。索引与切片一律 `Array.from(text)`，
 *     用 `slice()`（UTF-16 码元）会让后面的区间整体串位。
 *   - **只包行内元素**：不新建包裹层、不动块级结构与 className，段落/列表原样。
 *   - **幂等**：进函数时已经在的 `mark[data-plugin]` 跳过（第二次 apply 不会套娃）。
 *     本次调用里新包的 mark 不跳过 —— 重叠区间要靠它再往内层包。
 */

export type DecorationSpan = {
  plugin: string;
  id: string;
  start: number;
  end: number;
  style: string;
  color?: string;
  data?: Record<string, string>;
};

const MARK_SELECTOR = "mark[data-plugin]";

type TextEntry = {
  node: Text;
  /** 这个文本节点第一个字符在「容器纯文本」里的 rune 下标 */
  start: number;
  /** 节点文本的 rune 长度 */
  length: number;
};

function runeLength(text: string): number {
  return Array.from(text).length;
}

/** 这个文本节点是不是落在「本次调用之前就存在的插件 mark」里（是就跳过，保证幂等） */
function isInsideExistingMark(
  node: Text,
  root: HTMLElement,
  existing: Set<Element>,
): boolean {
  if (existing.size === 0) return false;
  for (
    let el: Element | null = node.parentElement;
    el && el !== root;
    el = el.parentElement
  ) {
    if (existing.has(el)) return true;
  }
  return false;
}

/**
 * 按文档顺序给文本节点编号。每次都重新扫：包一个区间会切分文本节点，
 * 旧索引立刻失效（这也是「重叠区间能嵌套」的前提）。
 */
function collectTextEntries(
  root: HTMLElement,
  existing: Set<Element>,
): TextEntry[] {
  const entries: TextEntry[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (isInsideExistingMark(text, root, existing)) continue;
    const length = runeLength(text.data);
    if (length === 0) continue;
    entries.push({ node: text, start: cursor, length });
    cursor += length;
  }
  return entries;
}

/** 把节点内 [from, to) 的 rune 区间包成 mark；from/to 是节点内的相对 rune 下标 */
function wrapSlice(
  entry: TextEntry,
  from: number,
  to: number,
  span: DecorationSpan,
): HTMLElement | null {
  const parent = entry.node.parentNode;
  if (!parent) return null;
  const chars = Array.from(entry.node.data);
  const before = chars.slice(0, from).join("");
  const target = chars.slice(from, to).join("");
  const after = chars.slice(to).join("");
  if (target.length === 0) return null;

  const mark = document.createElement("mark");
  mark.setAttribute("data-plugin", span.plugin);
  mark.setAttribute("data-decoration-id", span.id);
  mark.setAttribute("data-decoration-style", span.style);
  if (span.color) {
    mark.setAttribute("data-decoration-color", span.color);
    mark.style.color = span.color;
  }
  if (span.data) {
    mark.setAttribute("data-decoration-data", JSON.stringify(span.data));
  }
  mark.appendChild(document.createTextNode(target));

  if (before) parent.insertBefore(document.createTextNode(before), entry.node);
  parent.insertBefore(mark, entry.node);
  if (after) parent.insertBefore(document.createTextNode(after), entry.node);
  parent.removeChild(entry.node);
  return mark;
}

/**
 * 把 rune 区间画到 `root` 里的文本上，返回还原函数。
 *
 * 排序：`(start 升序, end 降序)` —— 先画外层大区间、再画内层小区间，
 * 内层能落在已经包好的外层 mark 里；反过来先包内层，外层再包时会跨着 mark
 * 切文本，把内层拆断。
 */
export function applyDecorations(
  root: HTMLElement,
  spans: DecorationSpan[],
): () => void {
  const created: HTMLElement[] = [];
  const valid = (spans ?? []).filter(
    (span) =>
      span && typeof span.start === "number" && span.end > span.start,
  );
  if (!root || valid.length === 0) return () => {};

  const existing = new Set<Element>(Array.from(root.querySelectorAll(MARK_SELECTOR)));
  const ordered = [...valid].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );

  for (const span of ordered) {
    for (const entry of collectTextEntries(root, existing)) {
      const from = Math.max(span.start, entry.start) - entry.start;
      const to = Math.min(span.end, entry.start + entry.length) - entry.start;
      if (to <= from) continue;
      const mark = wrapSlice(entry, from, to, span);
      if (mark) created.push(mark);
    }
  }

  /** 由内向外拆（创建顺序的逆序）：内层先还原成文本，外层再整体还原时文本才完整 */
  return () => {
    for (let index = created.length - 1; index >= 0; index -= 1) {
      const mark = created[index];
      if (!mark) continue;
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(
        document.createTextNode(mark.textContent ?? ""),
        mark,
      );
    }
    created.length = 0;
    // 拆完会剩一堆相邻文本节点，合并回一个（innerHTML 才能与原样相等）
    root.normalize();
  };
}
