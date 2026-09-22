import { describe, expect, it } from "vitest";
import { looksLikeJunkContent } from "@/lib/readable-quality";

const longText = (word: string) => `<p>${word} ${"正文内容。".repeat(60)}</p>`;

describe("looksLikeJunkContent", () => {
  it("空内容视为垃圾", () => {
    expect(looksLikeJunkContent(null)).toBe(true);
    expect(looksLikeJunkContent("")).toBe(true);
  });

  it("太短的结果视为垃圾", () => {
    expect(looksLikeJunkContent("<p>短</p>")).toBe(true);
  });

  it("识别 X 未登录落地页（实测样本）", () => {
    const junk = `<div>See what's happening and join the conversation</div><div>Log in</div><div>Sign up</div><div>Continue with phone</div>${"x".repeat(300)}`;
    expect(looksLikeJunkContent(junk)).toBe(true);
  });

  it("识别付费墙 / 验证页", () => {
    expect(
      looksLikeJunkContent(`${longText("订阅")} subscribe to continue reading this content is for subscribers`),
    ).toBe(true);
    expect(
      looksLikeJunkContent(`${longText("稍候")} just a moment checking your browser`),
    ).toBe(true);
  });

  it("正常长文不误判（即使正文里提到登录）", () => {
    const article = `${longText("正文")}<p>你需要登录后才能评论，登录入口在右上角。</p>`;
    expect(looksLikeJunkContent(article)).toBe(false);
  });
});
