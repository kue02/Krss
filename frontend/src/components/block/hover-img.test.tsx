import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { HoverImg } from "./hover-img";

// gsap 在 jsdom 里没有真实布局，动画部分不测；这里锁的是 krss 对上游的静态扩展：
// ① 行首来源图标 ② 多图才给左右按钮 ③ 计数与按钮作用于当前行
vi.mock("gsap", () => {
  const noop = () => undefined;
  const quickTo = () => noop;
  const api = {
    set: noop,
    to: noop,
    quickTo,
    utils: { toArray: () => [] },
  };
  return { default: api, ...api };
});

const project = (over: Record<string, unknown> = {}) => ({
  title: "标题",
  label: "来源 · 1 小时前",
  imageSrc: "/proxy/a.jpg",
  ...over,
});

beforeEach(() => cleanup());

describe("hover-img（krss 扩展）", () => {
  it("行首渲染来源图标", () => {
    const { container } = render(
      <HoverImg projects={[project({ iconSrc: "/icons/abc.jpg" })]} />
    );
    const icon = container.querySelector(".hover-img-icon") as HTMLImageElement;
    expect(icon).toBeTruthy();
    expect(icon.tagName).toBe("IMG");
    expect(icon.getAttribute("src")).toBe("/icons/abc.jpg");
    // 图标在标题之前
    const titleRow = container.querySelector(".hover-img-title-row")!;
    expect(titleRow.firstElementChild).toBe(icon);
  });

  it("没有 iconSrc 时用占位块，不留空洞", () => {
    const { container } = render(<HoverImg projects={[project()]} />);
    const icon = container.querySelector(".hover-img-icon")!;
    expect(icon.tagName).toBe("SPAN");
    expect(icon.classList.contains("hover-img-icon-empty")).toBe(true);
  });

  it("多图时给出左右切换按钮与 n/N 计数", () => {
    const { container } = render(
      <HoverImg
        projects={[project({ images: ["/proxy/1.jpg", "/proxy/2.jpg", "/proxy/3.jpg"] })]}
      />
    );
    expect(container.querySelectorAll(".hover-img-nav")).toHaveLength(2);
    expect(container.querySelector(".hover-img-nav.prev")).toBeTruthy();
    expect(container.querySelector(".hover-img-nav.next")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("单图时不出按钮", () => {
    const { container } = render(<HoverImg projects={[project()]} />);
    expect(container.querySelectorAll(".hover-img-nav")).toHaveLength(0);
    expect(container.querySelector(".hover-img-counter")).toBeNull();
  });

  it("一篇的多张图都铺进 track，按张数均分宽度", () => {
    const { container } = render(
      <HoverImg projects={[project({ images: ["/proxy/1.jpg", "/proxy/2.jpg"] })]} />
    );
    const track = container.querySelector(".hover-img-thumbnail-track") as HTMLElement;
    const imgs = track.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(track.style.width).toBe("200%");
    // 每张占半格，初始不偏移
    expect((imgs[0] as HTMLElement).style.width).toBe("50%");
    expect(track.style.transform).toBe("translateX(-0%)");
  });

  it("multi 组：按钮只反映当前行（第 2 行多图、第 1 行单图时计数按第 1 行）", () => {
    const { container } = render(
      <HoverImg
        projects={[project({ title: "单图" }), project({ title: "多图", images: ["/1.jpg", "/2.jpg"] })]}
      />
    );
    // activeIndex 默认 0（第一行，单图）
    expect(container.querySelectorAll(".hover-img-nav")).toHaveLength(0);
  });
});
