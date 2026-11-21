import { useEffect, useState } from "react";

/**
 * 正文内的选中区间（56-23）。
 *
 * 给插件动作用的 `selection.textRange` 是**相对正文容器纯文本的 rune 区间**，与装饰
 * （`components/reader/decorations.ts`）用同一套下标口径：一条 emoji 算 1 个位置。
 * 为什么不用 `Range.startOffset`：那是 UTF-16 码元偏移，遇到 emoji / 代理对会和后端
 * 存回来的 rune 下标错开，插件按区间取原文就会切在字符中间。
 */

export type TextRange = {
  start: number;
  end: number;
  text: string;
};

function runeLength(text: string): number {
  return Array.from(text).length;
}

/**
 * 某个边界点（`node` 的第 `offset` 个位置）在容器纯文本里的 rune 下标。
 * 用「从头量到该点」的 Range 取文本再数 rune：`node` 是文本节点、元素节点（选区端点
 * 常落在 `<mark>` / `<p>` 这种元素上）、还是跨过元素边界，都能算对。
 */
function runeOffsetAt(
  root: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  if (node !== root && !root.contains(node)) return null;
  const probe = document.createRange();
  probe.selectNodeContents(root);
  try {
    probe.setEnd(node, offset);
  } catch {
    // offset 越界（有些浏览器在元素节点上允许 child 数 + 1）：算不出来就别画，别让选区把正文搞崩
    return null;
  }
  return runeLength(probe.toString());
}

/** 当前选区在 `root` 里的 rune 区间；选区为空 / 不在正文里 → null（没选中就不占位） */
export function textRangeIn(
  root: HTMLElement | null,
  selection?: Selection | null,
): TextRange | null {
  if (!root) return null;
  const current =
    selection ??
    (typeof window !== "undefined" && typeof window.getSelection === "function"
      ? window.getSelection()
      : null);
  if (!current || current.rangeCount === 0 || current.isCollapsed) return null;

  const range = current.getRangeAt(0);
  const start = runeOffsetAt(root, range.startContainer, range.startOffset);
  const end = runeOffsetAt(root, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;

  const [from, to] = start <= end ? [start, end] : [end, start];
  if (to <= from) return null;
  const text = range.toString();
  if (text.trim().length === 0) return null;
  return { start: from, end: to, text };
}

/**
 * 监听 `selectionchange`，把选区映射成相对正文容器的 rune 区间。
 *
 * 不做「effect 里 setState(null)」那套重置：区间和它属于哪个容器 / 哪一条条目一起进 state，
 * 读出来时对不上就当作「没有选中」。换条目（`resetKey` 变）的一瞬间旧区间自然失效 ——
 * 浏览器在 DOM 换过之后还留着上一条的选区，直接信任它会让插件对旧正文取词。
 */
export function useReaderTextRange(
  root: HTMLElement | null,
  resetKey?: string | null,
): TextRange | null {
  const [snapshot, setSnapshot] = useState<{
    root: HTMLElement;
    key: string | null | undefined;
    range: TextRange | null;
  } | null>(null);

  useEffect(() => {
    if (!root) return undefined;
    const update = () =>
      setSnapshot({ root, key: resetKey, range: textRangeIn(root) });
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [root, resetKey]);

  if (!snapshot || snapshot.root !== root || snapshot.key !== resetKey) {
    return null;
  }
  return snapshot.range;
}
