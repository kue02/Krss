import { Profiler } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SocialMediaGallery } from "./SocialMediaGallery";
import { useImageDimensionsStore } from "@/stores/image-dimensions-store";

// 用**真实**的 image-dimensions-store，只把 IndexedDB 那层打桩 ——
// 本用例要验证的正是 store 订阅粒度（selector 只取自己 media 的尺寸），
// 所以不能像 SocialMediaGallery.test.tsx 那样把整个 store mock 成常对象。
vi.mock("@/lib/image-dimensions-db", () => ({
  getDimensionsBatch: vi.fn(() => Promise.resolve(new Map())),
  saveDimension: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/proxy-image-recovery", () => ({
  isRecoverableProxyUrl: () => false,
  renewProxyCookie: () => Promise.resolve(),
  withProxyCacheBust: (url: string) => url,
}));

beforeEach(() => {
  useImageDimensionsStore.setState({
    dimensions: {},
    failedImages: new Set(),
    isLoading: false,
  });
});

describe("SocialMediaGallery · 局部订阅（移动端性能）", () => {
  it("别的 gallery 尺寸变化不会重渲染本 gallery", () => {
    let rendersA = 0;
    let rendersB = 0;

    render(
      <>
        <Profiler
          id="A"
          onRender={() => {
            rendersA += 1;
          }}
        >
          <SocialMediaGallery media={[{ src: "https://example.com/a.jpg" }]} />
        </Profiler>
        <Profiler
          id="B"
          onRender={() => {
            rendersB += 1;
          }}
        >
          <SocialMediaGallery media={[{ src: "https://example.com/b.jpg" }]} />
        </Profiler>
      </>,
    );

    const baseA = rendersA;
    const baseB = rendersB;

    act(() => {
      useImageDimensionsStore
        .getState()
        .setDimension("https://example.com/a.jpg", 800, 600);
    });

    // A 自己这张量到尺寸 → 重渲染；B 与这次更新无关 → 保持不动
    expect(rendersA).toBeGreaterThan(baseA);
    expect(rendersB).toBe(baseB);
  });

  it("同一张图再次量到相同尺寸不触发重渲染（setDimension 判等）", () => {
    let renders = 0;
    render(
      <Profiler
        id="A"
        onRender={() => {
          renders += 1;
        }}
      >
        <SocialMediaGallery media={[{ src: "https://example.com/a.jpg" }]} />
      </Profiler>,
    );

    act(() => {
      useImageDimensionsStore
        .getState()
        .setDimension("https://example.com/a.jpg", 800, 600);
    });
    const afterFirst = renders;

    act(() => {
      useImageDimensionsStore
        .getState()
        .setDimension("https://example.com/a.jpg", 800, 600);
    });

    expect(renders).toBe(afterFirst);
  });
});
