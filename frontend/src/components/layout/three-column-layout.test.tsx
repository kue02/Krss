import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreeColumnLayout } from "./three-column-layout";
import { setUISetting } from "@/hooks/useUISettings";

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
});

/**
 * 11-24（用户第 3 条）：双栏（订阅侧栏 + 内容）分界限的「自动隐藏」。
 * 优先级：视图关掉（splitterVisibleByView=false → never）> 自动隐藏（hover）> 平时也画（always）。
 * 第二栏（条目 ↔ 正文）那条不受影响，永远是 hover。
 */
describe("ThreeColumnLayout 第一栏分界限显示方式（11-24）", () => {
  function renderLayout() {
    const queryClient = new QueryClient();
    return render(
      <QueryClientProvider client={queryClient}>
        <ThreeColumnLayout
          sidebar={<div>sidebar</div>}
          list={<div>list</div>}
          content={<div>content</div>}
        />
      </QueryClientProvider>,
    );
  }

  /** PanelSplitter 里的 HeroUI Separator 是唯一的 role=separator 节点 */
  function separators(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll('[role="separator"]'));
  }

  beforeEach(() => {
    localStorage.clear();
    setUISetting("splitterVisibleByView", {
      article: true,
      picture: false,
      notification: false,
      social: false,
    });
    setUISetting("splitterAutoHide", false);
  });

  it("默认（自动隐藏关）= 平时也画这条线", () => {
    const { container } = renderLayout();
    const [first] = separators(container);
    expect(first).toBeDefined();
    expect(first?.className).toContain("bg-border");
  });

  it("自动隐藏开 = 平时透明，悬浮/拖拽才显出来", () => {
    setUISetting("splitterAutoHide", true);
    const { container } = renderLayout();
    const [first] = separators(container);
    expect(first).toBeDefined();
    expect(first?.className).toContain("bg-transparent");
    expect(first?.className).not.toContain("bg-border");
  });

  it("视图关掉优先于自动隐藏：article=false 时第一条线根本不画", () => {
    setUISetting("splitterVisibleByView", {
      article: false,
      picture: false,
      notification: false,
      social: false,
    });
    setUISetting("splitterAutoHide", true);
    const { container } = renderLayout();
    // 只剩第二栏那条（hover 档），第一栏那条不再渲染
    expect(separators(container)).toHaveLength(1);
  });

  it("第二栏那条始终是 hover 档，不跟自动隐藏走", () => {
    setUISetting("splitterAutoHide", false);
    const { container } = renderLayout();
    const list = separators(container);
    const second = list[list.length - 1];
    expect(second).toBeDefined();
    expect(second?.className).toContain("bg-transparent");
  });
});
