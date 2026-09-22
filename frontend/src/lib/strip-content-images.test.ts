import { describe, expect, it } from "vitest";
import { stripContentImages } from "@/lib/strip-content-images";

describe("stripContentImages", () => {
  it("去掉 img，保留文字与其它标签", () => {
    const html = `<p>正文<img src="https://a.com/1.png" /></p><p>第二段</p>`;
    expect(stripContentImages(html)).toBe("<p>正文</p><p>第二段</p>");
  });

  it("去掉 picture 包裹的图片", () => {
    const html = `<picture><source srcset="a.webp" /><img src="a.jpg" /></picture><p>文字</p>`;
    expect(stripContentImages(html)).toBe("<p>文字</p>");
  });

  it("只剩图片的 figure 一并清掉，带说明文字的 figure 保留", () => {
    const onlyMedia = `<figure><img src="a.jpg" /></figure><p>文字</p>`;
    expect(stripContentImages(onlyMedia)).toBe("<p>文字</p>");

    const withCaption = `<figure><img src="a.jpg" /><figcaption>图注</figcaption></figure>`;
    expect(stripContentImages(withCaption)).toBe(
      "<figure><figcaption>图注</figcaption></figure>",
    );
  });

  it("空值返回空串", () => {
    expect(stripContentImages(null)).toBe("");
    expect(stripContentImages(undefined)).toBe("");
  });

  it("引文块里的图片要留着（它属于引文，不能甩到引文框外面）", () => {
    const html =
      '<p>正文</p><img src="main.jpg">' +
      '<div class="rsshub-quote">作者: 引文<img src="quote.jpg"></div>';

    const out = stripContentImages(html);

    // 正文自己的图摘掉（下面那排缩略图会用）
    expect(out).not.toContain("main.jpg");
    // 引文里的图必须留在引文框内
    expect(out).toContain("quote.jpg");
    expect(out).toContain("rsshub-quote");
  });

  it("blockquote 里的媒体同样保留", () => {
    const html = '<p>正文</p><blockquote>引用<video src="v.mp4"></video></blockquote>';
    const out = stripContentImages(html);
    expect(out).toContain("v.mp4");
  });
});
