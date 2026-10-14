import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArticleImage } from "./article-image";
import { useImageDimensionsStore } from "@/stores/image-dimensions-store";

// jsdom 无 IndexedDB：db 持久化层 mock 掉（存量 store 测试同做法），
// 只验证内存态的写入/读取。
vi.mock("@/lib/image-dimensions-db", () => ({
  getDimensionsBatch: vi.fn(),
  saveDimension: vi.fn(),
}));

// 注意：loadedImagesCache 是模块级全局缓存（load 过一次就记住），
// 每个用例用独立 SRC 隔离，避免互相污染。
const src = (n: number) => `https://example.com/no-dims-${n}.jpg`;

beforeEach(() => {
  useImageDimensionsStore.setState({ dimensions: {}, failedImages: new Set() });
});

describe("ArticleImage 无源尺寸预占（CLS）", () => {
  it("无宽高 → 渲染预占容器（aspect-ratio 16/10 + 最小高度）", () => {
    const { container } = render(<ArticleImage src={src(1)} alt="x" />);
    const reserve = container.querySelector(
      '[data-slot="article-image-reserve"]',
    ) as HTMLElement;
    expect(reserve).not.toBeNull();
    expect(reserve.style.aspectRatio).toBe("16 / 10");
    expect(reserve.style.minHeight).toBe("120px");
  });

  it("解码后回写 dimension-store（同源复用）", () => {
    const s = src(2);
    const { container } = render(<ArticleImage src={s} alt="x" />);
    const img = container.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 800 });
    Object.defineProperty(img, "naturalHeight", { value: 600 });
    fireEvent.load(img);
    expect(useImageDimensionsStore.getState().getDimension(s)).toMatchObject({
      width: 800,
      height: 600,
    });
  });

  it("store 有缓存 → 按真实比例预占（非 16/10）", () => {
    const s = src(3);
    useImageDimensionsStore.getState().setDimension(s, 400, 800);
    const { container } = render(<ArticleImage src={s} alt="x" />);
    const reserve = container.querySelector(
      '[data-slot="article-image-reserve"]',
    ) as HTMLElement;
    expect(reserve).not.toBeNull();
    expect(reserve.style.aspectRatio).toBe("400 / 800");
  });

  it("有源尺寸 → 走原路径（img 直接渲染 + width/height 属性，不包预占容器）", () => {
    const { container } = render(
      <ArticleImage src={src(4)} alt="x" width={300} height={200} />,
    );
    expect(
      container.querySelector('[data-slot="article-image-reserve"]'),
    ).toBeNull();
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("width")).toBe("300");
    expect(img.getAttribute("height")).toBe("200");
  });

  it("fit=true → 不包预占容器（fit 路径不动）", () => {
    const { container } = render(<ArticleImage src={src(5)} alt="x" fit />);
    expect(
      container.querySelector('[data-slot="article-image-reserve"]'),
    ).toBeNull();
    expect(screen.getByAltText("x").tagName).toBe("IMG");
  });
});
