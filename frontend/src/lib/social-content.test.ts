import { describe, expect, it } from "vitest";
import { removeContentSeparators, splitSocialQuote } from "@/lib/social-content";

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

  it("引文里的图片/视频要保留（只拆作者名，不重建整块文本）", () => {
    const html =
      '<hr><div class="rsshub-quote">三上悠亜: 🌹❤️<br><br>' +
      '<img src="https://pbs.twimg.com/media/x.jpg" width="1280">' +
      '<video src="https://video.twimg.com/x.mp4" controls></video></div>';

    const out = removeContentSeparators(html);

    expect(out).toContain("rsshub-quote-author");
    expect(out).toContain("三上悠亜");
    // 媒体节点必须还在（原来会被 textContent 重建整块时丢掉）
    expect(out).toContain("<img");
    expect(out).toContain("pbs.twimg.com/media/x.jpg");
    expect(out).toContain("<video");
    expect(out).toContain("video.twimg.com/x.mp4");
    expect(out).toContain("🌹❤️");
  });
});

// 47-5（用户 2026-10-12）：社交卡的「正文 / 引文」要按来源顺序分两段渲染
describe("splitSocialQuote", () => {
  it("按第一个引文块切开：正文在前、引文在后（报障条目的原文形状）", () => {
    const html =
      '我的 Grok Bot 工作室配置<br>' +
      '<img width="934" height="1140" src="https://pbs.twimg.com/media/A.jpg">' +
      '<div class="rsshub-quote"><span class="rsshub-quote-author">歸藏</span>: 介绍一下新的 GrokBot 玩法</div>';

    const { body, quote } = splitSocialQuote(html);

    expect(body).toContain("我的 Grok Bot 工作室配置");
    expect(body).toContain("pbs.twimg.com/media/A.jpg");
    expect(body).not.toContain("rsshub-quote");
    expect(quote).toContain("rsshub-quote");
    expect(quote).toContain("介绍一下新的 GrokBot 玩法");
  });

  it("没有引文块时 quote 为空串、body 原样返回", () => {
    const html = "<p>只有正文</p><img src=\"https://x.com/a.jpg\">";
    expect(splitSocialQuote(html)).toEqual({ body: html, quote: "" });
  });

  it("引文在开头（正文为空）时 body 为空串", () => {
    const { body, quote } = splitSocialQuote(
      '<blockquote>纯引用</blockquote>',
    );
    expect(body).toBe("");
    expect(quote).toContain("纯引用");
  });

  it("引文块后面的内容跟着引文段走（不插回正文）", () => {
    const { body, quote } = splitSocialQuote(
      '<p>正文</p><div class="rsshub-quote">引用</div><p>引文之后的尾巴</p>',
    );
    expect(body).not.toContain("引文之后的尾巴");
    expect(quote).toContain("引文之后的尾巴");
  });

  it("空值返回两个空串", () => {
    expect(splitSocialQuote(null)).toEqual({ body: "", quote: "" });
  });
});
