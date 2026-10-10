import type { Element, Parent, Root, Text } from "hast";
import type { Schema } from "hast-util-sanitize";
import type { Components } from "hast-util-to-jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { NON_CONTENT_TAG_NAMES } from "./html-content-tags";
import { rehypeLinkifyBareUrls } from "./rehype-linkify";

export type ParseHtmlOptions = {
  components?: Components;
};

// Emoji image class patterns (WordPress, EmojiOne, Twemoji, etc.)
const EMOJI_CLASS_PATTERNS = [
  "wp-smiley",
  "emoji",
  "emojione",
  "emoticon",
  "smiley",
];

// Check if a string contains emoji characters
function isEmojiChar(str: string): boolean {
  // Match common emoji ranges:
  // - Miscellaneous Symbols (U+2600-U+26FF)
  // - Dingbats (U+2700-U+27BF)
  // - Miscellaneous Symbols and Arrows (U+2B00-U+2BFF)
  // - Variation Selectors (U+FE00-U+FEFF)
  // - Supplemental Symbols (U+1F000-U+1FFFF)
  const emojiRegex =
    /[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{2B00}-\u{2BFF}]|[\u{FE00}-\u{FEFF}]|[\u{1F000}-\u{1FFFF}]/u;
  return emojiRegex.test(str);
}

/**
 * Rehype plugin to convert emoji images back to native emoji text.
 * Handles WordPress wp-smiley, EmojiOne, Twemoji, and similar implementations.
 */
function rehypeEmojiImages() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "img" || !parent || index === undefined) return;

      const props = node.properties || {};
      // className in hast is an array
      const classNames = Array.isArray(props.className) ? props.className : [];
      const className = classNames.join(" ");
      const alt = String(props.alt || "");

      // Check if this is an emoji image by class name
      const isEmojiClass = EMOJI_CLASS_PATTERNS.some((pattern) =>
        className.toLowerCase().includes(pattern),
      );

      if (isEmojiClass && alt && isEmojiChar(alt)) {
        // Replace img with text node containing the emoji
        const textNode: Text = { type: "text", value: alt };
        parent.children.splice(index, 1, textNode);
      }
    });
  };
}

/**
 * Remove trailing <br> elements from the tree
 */
function rehypeTrimEndBrElement() {
  function trim(tree: Parent): void {
    if (!Array.isArray(tree.children) || tree.children.length === 0) {
      return;
    }

    for (let i = tree.children.length - 1; i >= 0; i--) {
      const item = tree.children[i]!;
      if (item.type === "element") {
        if ((item as Element).tagName === "br") {
          tree.children.pop();
          continue;
        } else {
          trim(item as Parent);
        }
      }
      break;
    }
  }
  return trim;
}

/**
 * Remove non-content elements entirely, including their text children.
 * This prevents tags like <style> from leaking raw CSS into article body text
 * after sanitize strips the tag wrapper.
 */
function rehypeDropNonContentElements() {
  const blockedTagNames: ReadonlySet<string> = new Set(NON_CONTENT_TAG_NAMES);

  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (!parent || index === undefined) return;
      if (!blockedTagNames.has(node.tagName)) return;

      parent.children.splice(index, 1);
      return index;
    });
  };
}

/**
 * 净化 schema：模块级单例。
 *
 * 原来在 `parseHtml()` 体内展开 defaultSchema 再拼数组/对象，**每次调用都重建一遍**
 * （tagNames 数组、attributes 里 4 个数组全量复制）。每篇文章都要 parse 一次
 * ⇒ 每篇都白付这份构建。schema 是纯只读配置，hast-util-sanitize 只读不写，
 * 所以建一次复用即可，行为不变。
 */
const REHYPE_SCHEMA: Schema = { ...defaultSchema };
REHYPE_SCHEMA.tagNames = [
  ...REHYPE_SCHEMA.tagNames!,
  "video",
  "source",
  "audio",
  "figure",
  "figcaption",
  "details",
  "summary",
];

REHYPE_SCHEMA.attributes = {
  ...REHYPE_SCHEMA.attributes,
  "*": [...REHYPE_SCHEMA.attributes!["*"]!, "style", "className"],
  video: [
    "src",
    "poster",
    "controls",
    "autoplay",
    "loop",
    "muted",
    "width",
    "height",
  ],
  audio: ["src", "controls", "autoplay", "loop", "muted"],
  source: ["src", "type"],
  img: [
    "src",
    "alt",
    "title",
    "width",
    "height",
    "loading",
    "srcset",
    "sizes",
    "className",
  ],
};

/**
 * 处理管线：模块级单例。
 *
 * `components` **不进管线**——它只喂给 toJsxRuntime（见函数末尾），unified 这条链
 * 每次调用都在重建一个 processor 并 freeze（.use() 7 次 + freeze）。
 * 这条链是纯配置：7 个插件的 attacher 都只在 freeze 时跑一次，transformer 内部
 * 不跨文档保留可变状态（rehype-stringify 每次 transform 重新 toHtml 建 compiler）。
 * 所以建一次复用。
 */
const BASE_PIPELINE = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeDropNonContentElements)
  .use(rehypeSanitize, REHYPE_SCHEMA)
  .use(rehypeEmojiImages)
  .use(rehypeTrimEndBrElement)
  // 45 批：裸 URL 链接化。必须排在 sanitize 之后 —— sanitize 按白名单剥属性，
  // 前置生成 <a href> 会被剥掉；后置生成的才活得下来（见 rehype-linkify.ts 注释）
  .use(rehypeLinkifyBareUrls)
  .use(rehypeStringify)
  .freeze();

/**
 * Parse HTML string to React components
 */
export function parseHtml(content: string, options?: ParseHtmlOptions) {
  const { components } = options || {};

  // Parse and process the HTML
  const tree = BASE_PIPELINE.parse(content);
  const hastTree = BASE_PIPELINE.runSync(tree, content);

  return {
    hastTree,
    toContent: () =>
      toJsxRuntime(hastTree, {
        Fragment,
        ignoreInvalidStyle: true,
        jsx: (type, props, key) => {
          // Prefer key from props (set by custom components) over auto-generated key
          const actualKey = props?.key ?? key;
          // Type cast needed: hast-util-to-jsx-runtime's type is broader than React's jsx expects
          return jsx(type as React.ElementType, props, actualKey);
        },
        jsxs: (type, props, key) => {
          const actualKey = props?.key ?? key;
          return jsxs(type as React.ElementType, props, actualKey);
        },
        passNode: true,
        components,
      }),
  };
}
