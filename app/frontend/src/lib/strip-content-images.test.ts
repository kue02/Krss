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
});
