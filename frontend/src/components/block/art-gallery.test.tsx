import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ArtGallery from "@/components/block/art-gallery";

/**
 * 降级路径（31-1）：WebGL 不可用时不能白屏，要给**看得见的**普通方格照片墙 + 一行提示。
 * jsdom 里 `canvas.getContext("webgl2")` 本来就是 null ⇒ 这两个测试跑的是真降级分支
 * （不是 mock）；顺带覆盖「环境没有 matchMedia 也不能崩」。
 */
describe("照片墙 · WebGL 降级", () => {
  afterEach(cleanup);

  it("WebGL 不可用：容器仍在，里面换成普通方格 + 照片 + 提示文案，且不起画布", () => {
    const images = [
      "/api/proxy/image/a.jpg",
      "/api/proxy/image/b.jpg",
      "/api/proxy/image/c.jpg",
    ];
    const { container } = render(
      <ArtGallery
        images={images}
        hint="拖动浏览"
        unsupportedNote="此设备不支持 WebGL，已改用普通方格"
      />,
    );

    const root = container.querySelector('[data-art-gallery="true"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-art-gallery-count")).toBe("3");

    const fallback = container.querySelector(
      '[data-art-gallery-fallback="true"]',
    );
    expect(fallback).not.toBeNull();
    expect(fallback?.querySelectorAll("img").length).toBe(3);
    expect(screen.getByText("此设备不支持 WebGL，已改用普通方格")).toBeTruthy();
    // 没 WebGL 就不该有画布
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("照片为空：容器照出（count 0），不起画布，也不崩", () => {
    const { container } = render(<ArtGallery images={[]} hint="拖动浏览" />);
    const root = container.querySelector('[data-art-gallery="true"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-art-gallery-count")).toBe("0");
    expect(container.querySelector("canvas")).toBeNull();
  });
});
