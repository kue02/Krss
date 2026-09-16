import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarHotkeys, type SidebarTarget } from "@/hooks/useSidebarHotkeys";

const toggleCategory = vi.fn();

vi.mock("@/hooks/useCategoryState", () => ({
  isCategoryOpen: () => true,
  toggleCategory: (name: string) => toggleCategory(name),
}));

const targets: SidebarTarget[] = [
  { kind: "folder", id: "10", name: "科技" },
  { kind: "feed", id: "1", name: "少数派", folderId: "10" },
  { kind: "feed", id: "2", name: "Cloudflare Blog", folderId: "10" },
  { kind: "feed", id: "3", name: "阮一峰" },
];

function press(key: string, options: KeyboardEventInit = {}) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
  );
}

function setup(selection: Parameters<typeof useSidebarHotkeys>[0]["selection"]) {
  const onSelectFeed = vi.fn();
  const onSelectFolder = vi.fn();
  const onAddFeed = vi.fn();
  renderHook(() =>
    useSidebarHotkeys({
      targets,
      selection,
      onSelectFeed,
      onSelectFolder,
      onAddFeed,
    }),
  );
  return { onSelectFeed, onSelectFolder, onAddFeed };
}

describe("useSidebarHotkeys", () => {
  beforeEach(() => {
    toggleCategory.mockClear();
  });

  it("n 选中下一个目标（订阅）", () => {
    const { onSelectFeed } = setup({ type: "feed", feedId: "1" });
    press("n");
    expect(onSelectFeed).toHaveBeenCalledWith("2");
  });

  it("p 选中上一个目标（跨过分组时选分组本身）", () => {
    const { onSelectFolder } = setup({ type: "feed", feedId: "1" });
    press("p");
    expect(onSelectFolder).toHaveBeenCalledWith("10");
  });

  it("到末尾再按 n 会绕回开头", () => {
    const { onSelectFolder } = setup({ type: "feed", feedId: "3" });
    press("n");
    expect(onSelectFolder).toHaveBeenCalledWith("10");
  });

  it("没有选中项时 n 从第一个开始", () => {
    const { onSelectFolder } = setup({ type: "all" });
    press("n");
    expect(onSelectFolder).toHaveBeenCalledWith("10");
  });

  it("x 折叠选中订阅所属的分组", () => {
    const { } = setup({ type: "feed", feedId: "2" });
    press("x");
    expect(toggleCategory).toHaveBeenCalledWith("科技");
  });

  it("x 在未分组订阅上不做事", () => {
    setup({ type: "feed", feedId: "3" });
    press("x");
    expect(toggleCategory).not.toHaveBeenCalled();
  });

  it("Shift+N 触发添加订阅", () => {
    const { onAddFeed } = setup({ type: "feed", feedId: "1" });
    press("N", { shiftKey: true });
    expect(onAddFeed).toHaveBeenCalled();
  });

  it("带修饰键或输入框里不响应", () => {
    const { onSelectFeed } = setup({ type: "feed", feedId: "1" });

    press("n", { metaKey: true });
    expect(onSelectFeed).not.toHaveBeenCalled();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", bubbles: true }),
    );
    expect(onSelectFeed).not.toHaveBeenCalled();
    input.remove();
  });
});
