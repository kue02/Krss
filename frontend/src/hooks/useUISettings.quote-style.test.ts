import { describe, expect, it, afterEach } from "vitest";
import { applyQuoteStyleToDocument } from "./useUISettings";

/**
 * 用户第十一批 11-10：引文样式新增「卡片」。
 * 落盘形式是把 style 写到 <html data-quote-style>，CSS 三套规则各认一个值 ——
 * 这里钉住「三个值都能原样落到属性上」（以前这里只认 block/divider，card 会被悄悄改成 block）。
 */
describe("引文样式落地", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-quote-style");
  });

  it("三种样式都原样写到 <html data-quote-style>", () => {
    for (const style of ["block", "divider", "card"] as const) {
      applyQuoteStyleToDocument(style);
      expect(document.documentElement.getAttribute("data-quote-style")).toBe(style);
    }
  });
});
