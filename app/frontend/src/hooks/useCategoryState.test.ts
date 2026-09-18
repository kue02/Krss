import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spyOnStorageWrites } from "@/test/storage-write-spy";

/**
 * 21 批：侧栏分类展开态进服务端同步（`ui.sidebar_state`），键名 gist-* → krss-*。
 * 「全部展开 / 全部收起」旧写法在循环里挨个写，10 个分类 = 10 次落盘 + 10 次同步；
 * 这批改成一次写完。
 */
async function freshModule(): Promise<typeof import("./useCategoryState")> {
  vi.resetModules();
  return await import("./useCategoryState");
}

function stored(): Record<string, boolean> {
  return JSON.parse(localStorage.getItem("krss-category-state") ?? "{}");
}

beforeEach(() => {
  localStorage.clear();
});

describe("分类展开态（21 批）", () => {
  it("老键 gist-category-state 迁移，非布尔的脏值被丢掉", async () => {
    localStorage.setItem(
      "gist-category-state",
      JSON.stringify({ 技术: true, 新闻: false, junk: "yes" }),
    );

    const mod = await freshModule();

    expect(mod.isCategoryOpen("技术")).toBe(true);
    expect(mod.isCategoryOpen("junk")).toBe(false);
    expect(localStorage.getItem("gist-category-state")).toBeNull();
  });

  it("损坏的 JSON 不会让启动崩掉（回落空状态）", async () => {
    localStorage.setItem("krss-category-state", "{not json");

    const mod = await freshModule();

    expect(mod.isCategoryOpen("技术")).toBe(false);
  });

  it("一次改多个分类只写一次盘（全部展开 / 全部收起）", async () => {
    const mod = await freshModule();
    const names = ["技术", "新闻", "设计", "摄影", "播客"];

    const { result } = renderHook(() => mod.useCategoryActions());
    const spy = spyOnStorageWrites();

    act(() => {
      result.current.expandAll(names);
    });

    // 旧写法是循环里挨个 setCategoryState → 5 个分类 5 次落盘
    expect(spy.countOf("krss-category-state")).toBe(1);
    spy.restore();

    expect(stored()).toEqual(Object.fromEntries(names.map((name) => [name, true])));

    act(() => {
      result.current.collapseAll(names);
    });
    expect(Object.values(stored()).every((open) => open === false)).toBe(true);
  });

  it("服务端回来的展开态覆盖本地（只认布尔值）", async () => {
    const mod = await freshModule();
    mod.toggleCategory("技术");
    expect(mod.isCategoryOpen("技术")).toBe(true);

    mod.applyCategoryStateFromServer({ 新闻: false, junk: 1 } as unknown as Record<
      string,
      boolean
    >);

    expect(mod.isCategoryOpen("技术")).toBe(false); // 服务端说了算（本地那份被整体替换）
    expect(mod.isCategoryOpen("新闻")).toBe(false);
    expect(stored()).toEqual({ 新闻: false });
  });
});
