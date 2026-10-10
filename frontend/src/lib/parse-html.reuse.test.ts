// parse-html.ts: parseHtml 多次调用后行为不变（模块级单例管线 + 单例 schema 的回归护栏）
import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHtml } from "./parse-html";

/** 把 React 元素树压成可比较的形状串（type + children 结构） */
function shape(node: unknown): string {
  if (node == null || typeof node !== "object") return String(node);
  const el = node as { type?: unknown; props?: { children?: unknown } };
  const type =
    typeof el.type === "string"
      ? el.type
      : ((el.type as { name?: string })?.name ?? "comp");
  const kids = el.props?.children;
  const childShape = Array.isArray(kids)
    ? kids.map((k) => shape(k)).join(",")
    : kids
      ? shape(kids)
      : "";
  return `${type}(${childShape})`;
}

const SAMPLE = `
  <h2>标题</h2>
  <p>段落一，带一个 <a href="https://example.com/x">链接</a> 和裸 URL https://bare.example.org/y</p>
  <pre><code class="language-js">const a = 1;</code></pre>
  <table><tr><td>单元格 A</td><td>单元格 B</td></tr></table>
  <figure><img src="https://cdn.example.com/a.png" alt="图 A"><figcaption>图注</figcaption></figure>
  <video src="https://cdn.example.com/v.mp4" controls></video>
  <details><summary>更多</summary><p>折叠内容</p></details>
  <style>.x{color:red}</style>
  <p><img class="wp-smiley" alt="😀" src="https://cdn.example.com/e.png"></p>
  <p onclick="evil()">行内样式 <span style="color:blue">蓝字</span></p>
`;

describe("parseHtml 复用模块级管线后行为不变", () => {
  it("多次调用得到完全相同的结果（管线/schema 是共享单例，不能互相污染）", () => {
    const first = shape(parseHtml(SAMPLE).toContent());
    for (let i = 0; i < 4; i++) {
      expect(shape(parseHtml(SAMPLE).toContent())).toBe(first);
    }
  });

  it("交替处理不同文档不会串味（A 的结果不受 B 影响）", () => {
    const docA = "<p>甲文档</p><img src='https://cdn.example.com/a.png'>";
    const docB = "<table><tr><td>乙</td></tr></table><script>bad()</script>";
    const a1 = shape(parseHtml(docA).toContent());
    const b1 = shape(parseHtml(docB).toContent());
    const a2 = shape(parseHtml(docA).toContent());
    const b2 = shape(parseHtml(docB).toContent());
    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
    expect(a2).not.toBe(b2);
    // script 必须被剥掉
    expect(b1).not.toContain("bad()");
  });

  it("净化白名单仍然生效：script 被剥、onclick 被剥、style 保留在白名单里", () => {
    const s = shape(parseHtml(SAMPLE).toContent());
    expect(s).not.toContain("script");
    expect(s).not.toContain("onclick");
    // * 通配允许 style/className（见 REHYPE_SCHEMA），img 的 className 也在白名单
    expect(s).toContain("img");
    expect(s).toContain("table");
    expect(s).toContain("video");
  });

  it("带 components 的调用仍正常（组件映射不依赖管线单例）", () => {
    // components 里的是 React 组件：toContent() 只是把组件**函数**放进 type，
    // 真正调用发生在渲染期。所以要 renderToStaticMarkup 才验得到映射生效。
    const out = parseHtml("<p>hi</p>", {
      components: { p: (props) => createElement("em", null, `组件:${props.children}`) },
    }).toContent();
    expect(renderToStaticMarkup(out as ReactElement)).toBe("<em>组件:hi</em>");
  });
});