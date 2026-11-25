import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreeColumnLayout } from "./three-column-layout";

describe("ThreeColumnLayout", () => {
  it("uses app viewport height instead of 100vh", () => {
    const queryClient = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ThreeColumnLayout
          sidebar={<div>sidebar</div>}
          list={<div>list</div>}
          content={<div>content</div>}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("sidebar")).toBeTruthy();
    expect(screen.getByText("list")).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();

    const root = container.firstElementChild;
    expect(root?.classList.contains("h-full")).toBe(true);
    expect(root?.classList.contains("h-dvh")).toBe(false);
    expect(root?.classList.contains("h-screen")).toBe(false);
  });

  it("覆盖模式 coverList：条目栏吃满、正文浮层绝对覆盖其上（未选中时隐藏但保留在树）", () => {
    const queryClient = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ThreeColumnLayout
          sidebar={<div>sidebar</div>}
          list={<div>list</div>}
          content={<div>content</div>}
          coverList
          hideContent
        />
      </QueryClientProvider>,
    );

    // 未选中时 list 与 content 仍在树里（保 AnimatePresence 推进），但正文不可点
    expect(screen.getByText("list")).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();

    const main = container.querySelector("main");
    expect(main).toBeTruthy();
    expect(main?.className).toContain("absolute");
    expect(main?.className).toContain("pointer-events-none");
    // 覆盖层之外：条目栏与侧栏都不在 <main> 内（浮层只盖第二栏，不动侧栏）
    expect(main?.contains(screen.getByText("list"))).toBe(false);
    expect(main?.contains(screen.getByText("sidebar"))).toBe(false);
    expect(screen.getByText("sidebar")).toBeTruthy();
  });

  it("非覆盖模式（默认）：正文为第三栏，不绝对定位覆盖条目栏", () => {
    const queryClient = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ThreeColumnLayout
          sidebar={<div>sidebar</div>}
          list={<div>list</div>}
          content={<div>content</div>}
        />
      </QueryClientProvider>,
    );

    const main = container.querySelector("main");
    expect(main?.className ?? "").not.toContain("absolute");
  });

  it("经典三栏文章档：正文栏左缘留 8px 浮动缺口（sm:pl-2），与社交/内联/覆盖档一致", () => {
    const queryClient = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ThreeColumnLayout
          sidebar={<div>sidebar</div>}
          list={<div>list</div>}
          content={<div>content</div>}
        />
      </QueryClientProvider>,
    );

    // 默认档 = 经典三栏（hideList=false / hideContent=false）：<main> 必须留左内边距，
    // 否则正文卡左缘贴死条目栏，且 overflow-hidden 裁掉卡片左缘圆角与外阴影 → 无「浮动」效果。
    const main = container.querySelector("main");
    expect(main?.className).toContain("sm:pl-2");
    expect(main?.className).not.toContain("sm:pl-0");
  });
});

/**
 * 2026-11-25（用户）：「双栏自动隐藏分界限」改为随布局自动联动——
 * 三栏（订阅栏 + 条目栏 + 正文）常显；双栏（只有订阅栏 + 内容）平时隐藏、悬浮到分界处/拖拽才现。
 * 第二栏（条目 ↔ 正文）那条不受影响，永远是 hover。
 */
describe("ThreeColumnLayout 第一栏分界限按布局自动联动（2026-11-25）", () => {
  function renderLayout(props: Partial<ComponentProps<typeof ThreeColumnLayout>> = {}) {
    const queryClient = new QueryClient();
    return render(
      <QueryClientProvider client={queryClient}>
        <ThreeColumnLayout
          sidebar={<div>sidebar</div>}
          list={<div>list</div>}
          content={<div>content</div>}
          {...props}
        />
      </QueryClientProvider>,
    );
  }

  /** PanelSplitter 里的 HeroUI Separator 是唯一的 role=separator 节点 */
  function separators(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll('[role="separator"]'));
  }

  it("三栏（默认）= 第一栏分界限常显（bg-border）", () => {
    const { container } = renderLayout();
    const [first] = separators(container);
    expect(first).toBeDefined();
    expect(first?.className).toContain("bg-border");
  });

  it("双栏（hideList 档，如社交/图片/通知）= 平时透明，悬浮/拖拽才现", () => {
    const { container } = renderLayout({ hideList: true });
    const [first] = separators(container);
    expect(first).toBeDefined();
    expect(first?.className).toContain("bg-transparent");
    expect(first?.className).not.toContain("bg-border");
  });

  it("双栏（正文内联 inlineContent 档）= 平时透明", () => {
    const { container } = renderLayout({ inlineContent: true });
    const [first] = separators(container);
    expect(first?.className).toContain("bg-transparent");
  });

  it("双栏（正文覆盖 coverList 档，如文章 rows 布局）= 平时透明", () => {
    const { container } = renderLayout({ coverList: true, hideContent: true });
    const [first] = separators(container);
    expect(first).toBeDefined();
    expect(first?.className).toContain("bg-transparent");
    expect(first?.className).not.toContain("bg-border");
  });

  it("双栏（文章悬停档未选中→hideContent、只剩条目栏）= 平时透明", () => {
    const { container } = renderLayout({ hideContent: true });
    const [first] = separators(container);
    expect(first).toBeDefined();
    expect(first?.className).toContain("bg-transparent");
    expect(first?.className).not.toContain("bg-border");
  });

  it("第二栏那条始终是 hover 档，不跟布局走", () => {
    const { container } = renderLayout();
    const list = separators(container);
    const second = list[list.length - 1];
    expect(second).toBeDefined();
    expect(second?.className).toContain("bg-transparent");
  });
});
