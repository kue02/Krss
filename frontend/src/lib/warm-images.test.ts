import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { warmEntryImages } from "./warm-images";

/**
 * 50-2：预载时顺手把正文头几张图 warm 进（浏览器 + 后端代理）缓存。
 *
 * 为什么值得测：正文图片都要过 /api/proxy/image 出网取一遍，而代理原来没有服务端
 * 缓存（实测同一张图连取三遍 0.708 / 0.967 / 0.669 s）。warm 的**张数上限**和
 * **走代理 URL** 这两点错了就白拉流量或者根本填不进缓存。
 */

class FakeImage {
  static created: FakeImage[] = [];
  decoding = "";
  fetchPriority = "";
  src = "";
  constructor() {
    FakeImage.created.push(this);
  }
}

describe("warmEntryImages", () => {
  beforeEach(() => {
    FakeImage.created = [];
    vi.stubGlobal("Image", FakeImage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const html = (srcs: string[]) =>
    `<p>x</p>${srcs.map((s) => `<img src="${s}">`).join("")}`;

  it("只 warm 前 N 张，且走 /api/proxy/image（要和真正渲染时同一个地址，缓存才命中）", () => {
    warmEntryImages(
      html([
        "https://cdn.example.com/1.png",
        "https://cdn.example.com/2.png",
        "https://cdn.example.com/3.png",
        "https://cdn.example.com/4.png",
      ]),
      "https://example.com/post",
      3,
    );

    expect(FakeImage.created).toHaveLength(3);
    for (const img of FakeImage.created) {
      expect(img.src).toContain("/api/proxy/image/");
      expect(img.fetchPriority).toBe("low"); // 别跟正在渲染的内容抢优先级
      expect(img.decoding).toBe("async");
    }
    // 第 4 张不该被拉
    expect(FakeImage.created.some((i) => i.src.includes("4.png"))).toBe(false);
  });

  it("正文没有图 / content 为空 → 一个都不创建", () => {
    warmEntryImages(html([]), "https://example.com/post");
    expect(FakeImage.created).toHaveLength(0);

    warmEntryImages(null, "https://example.com/post");
    warmEntryImages(undefined, undefined);
    expect(FakeImage.created).toHaveLength(0);
  });

  it("data: 图跳过（没有出网取的必要）", () => {
    warmEntryImages(
      '<img src="data:image/png;base64,iVBORw0KGgo="><img src="https://cdn.example.com/a.png">',
      "https://example.com/post",
    );
    expect(FakeImage.created).toHaveLength(1);
    expect(FakeImage.created[0]!.src).toContain("/api/proxy/image/");
  });

  it("limit=0 时不做事", () => {
    warmEntryImages(html(["https://cdn.example.com/1.png"]), "https://e.com", 0);
    expect(FakeImage.created).toHaveLength(0);
  });
});
