import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
