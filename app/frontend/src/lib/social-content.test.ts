import { describe, expect, it } from "vitest";
import { removeContentSeparators } from "@/lib/social-content";

describe("removeContentSeparators", () => {
  it("去掉 RSSHub 的分隔线", () => {
    const html = `<div>正文<br><br><hr style="margin: 12px 0px;"><div class="rsshub-quote">引用</div></div>`;
    const out = removeContentSeparators(html);
    expect(out).not.toContain("<hr");
    expect(out).toContain("rsshub-quote");
    expect(out).toContain("正文");
  });

  it("没有分割线时原样返回", () => {
    const html = `<div>正文<br><br>下一段</div>`;
    expect(removeContentSeparators(html)).toBe(html);
  });

  it("空值返回空串", () => {
    expect(removeContentSeparators(null)).toBe("");
  });
});
