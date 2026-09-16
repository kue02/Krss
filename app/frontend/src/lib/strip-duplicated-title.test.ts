import { describe, expect, it } from "vitest";
import { stripDuplicatedTitle } from "@/lib/strip-duplicated-title";

const TITLE = "当我怀念旧版 Edge 浏览器时";

describe("stripDuplicatedTitle", () => {
  it("去掉与标题完全相同的首段", () => {
    const html = `<p>${TITLE}</p><p>正文第一段。</p>`;
    expect(stripDuplicatedTitle(html, TITLE)).toBe("<p>正文第一段。</p>");
  });

  it("去掉与标题相同的首级标题（忽略标点与空白差异）", () => {
    const html = `<h1>当我怀念旧版 Edge 浏览器时！</h1><p>正文。</p>`;
    expect(stripDuplicatedTitle(html, TITLE)).toBe("<p>正文。</p>");
  });

  it("去掉与标题相同的开头纯文本", () => {
    const html = `${TITLE}<p>正文。</p>`;
    expect(stripDuplicatedTitle(html, TITLE)).toBe("<p>正文。</p>");
  });

  it("首段只是标题的一部分时不删（避免误伤正文）", () => {
    const html = `<p>当我怀念旧版 Edge 浏览器时，先说说别的。</p>`;
    expect(stripDuplicatedTitle(html, TITLE)).toBe(html);
  });

  it("标题过短时不动正文", () => {
    const html = `<p>早报</p><p>正文。</p>`;
    expect(stripDuplicatedTitle(html, "早报")).toBe(html);
  });

  it("没有标题或正文时原样返回", () => {
    expect(stripDuplicatedTitle("<p>正文。</p>", null)).toBe("<p>正文。</p>");
    expect(stripDuplicatedTitle(null, TITLE)).toBe("");
  });
});
