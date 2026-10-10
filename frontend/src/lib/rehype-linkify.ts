/**
 * 45 批：正文里的裸 URL 自动识别（linkify）。
 *
 * 上游给正文的口径不一：RSSHub 的 Twitter 路由把链接吐成纯文本，别的源吐 `<a>`。
 * `ArticleContent` 走 `parseHtml` → hast → React，而 hast 里纯文本就是纯文本，
 * 于是「有的链接能点、有的不能」。这个插件把文本节点里的裸 URL 换成 `<a>` 元素。
 *
 * 位置在管道里**必须排在 rehypeSanitize 之后**：sanitize 按白名单剥属性，
 * 我们后置生成 `<a href>` 才不会被剥掉（前置生成 = 白忙）。
 *
 * 两个实现要点：
 * 1. unist 树不维护 `parent`，`visit` 的 visitor 只给**直接**父节点。
 *    判断「这个文本是不是在 `<code>` 里」要追整条祖先链，所以先跑一个 visitor
 *    给每个元素挂 `__parent`，同时预先把跳过名单里的元素标进 WeakSet。
 * 2. 不要在 text visitor 里原地 splice 后 `return index` —— 新插入的 `<a>` 里
 *    还包着 text 节点，visit 会重新扫进去（实测栈溢出）。做法是收集待替换项，
 *    等遍历结束后一次性改 children。
 */

import type { Element, Root, Text } from "hast";
import { visit } from "unist-util-visit";
import { findBareUrls } from "./linkify-text";

/** 链接化要跳过的容器：这些里面的文本不当成正文链接化 */
const SKIP_TAGS = new Set([
  "a",
  "code",
  "pre",
  "kbd",
  "samp",
  "script",
  "style",
]);

type ElementWithParent = Element & { __parent?: ElementWithParent };

export function rehypeLinkifyBareUrls() {
  return (tree: Root) => {
    // 跳过标记：进了这个 Set 的元素，其后代一律不做链接化
    const inSkip = new WeakSet<ElementWithParent>();
    // 待替换的文本节点：{ parent, index } —— 遍历收完再统一改，避免 visit 重入
    const pending: Array<{ parent: ElementWithParent; index: number }> = [];

    visit(tree, "element", (node) => {
      const me = node as ElementWithParent;
      if (Array.isArray(me.children)) {
        for (const child of me.children) {
          if (child.type === "element") {
            (child as ElementWithParent).__parent = me;
          }
        }
      }
      if (SKIP_TAGS.has(me.tagName)) {
        let cur: ElementWithParent | undefined = me;
        while (cur) {
          inSkip.add(cur);
          cur = cur.__parent;
        }
      }
      return undefined;
    });

    visit(tree, "text", (node, index, parent) => {
      if (index === null || index === undefined || !parent) return;
      // 顶层裸文本：parent 是 Root（type: "root"），没有任何祖先要判，
      // 照样要链接化（报障条目就是 `<br>` 分隔的顶层裸 URL）
      if (parent.type === "element") {
        // 祖先链上任一跳过容器里的文本都不动
        let cur: ElementWithParent | undefined = parent;
        while (cur) {
          if (inSkip.has(cur)) return;
          cur = cur.__parent;
        }
      }

      const value = node.value;
      if (!value) return;
      // 连 scheme 都没有就省掉一次正则
      if (!value.includes("http://") && !value.includes("https://")) return;

      // 有候选就先记下来，稍后统一替换（此时还不改树）
      if (findBareUrls(value).length > 0) {
        pending.push({ parent: parent as ElementWithParent, index });
      }
      return undefined;
    });

    // 统一替换。按「父元素分组 + index 倒序」处理，保证前面的 splice 不影响后面的下标
    let replaced = 0;
    const byParent = new Map<ElementWithParent, number[]>();
    for (const { parent, index } of pending) {
      const list = byParent.get(parent);
      if (list) list.push(index);
      else byParent.set(parent, [index]);
    }
    for (const [parent, indexes] of byParent) {
      indexes.sort((a, b) => b - a); // 倒序替换，前面的 splice 不挪动后面的下标
      for (const index of indexes) {
        const node = parent.children[index];
        if (!node || node.type !== "text") continue;
        const matches = findBareUrls(node.value);
        if (matches.length === 0) continue;

        const children: Array<Text | Element> = [];
        let cursor = 0;
        for (const match of matches) {
          if (match.start > cursor) {
            children.push({ type: "text", value: node.value.slice(cursor, match.start) });
          }
          children.push({
            type: "element",
            tagName: "a",
            properties: { href: match.href },
            children: [{ type: "text", value: node.value.slice(match.start, match.end) }],
          });
          cursor = match.end;
        }
        if (cursor < node.value.length) {
          children.push({ type: "text", value: node.value.slice(cursor) });
        }

        parent.children.splice(index, 1, ...children);
        replaced += matches.length;
      }
    }

    // 供调试/测试：「这一批一共链接化了几个 URL」
    (tree as Root & { __linkifyCount?: number }).__linkifyCount = replaced;
  };
}
