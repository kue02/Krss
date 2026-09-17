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
