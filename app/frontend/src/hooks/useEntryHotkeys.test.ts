import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEntryHotkeys } from "./useEntryHotkeys";
import type { Entry } from "@/types/api";

const markAsRead = vi.fn();
const markAsStarred = vi.fn();

vi.mock("@/hooks/useEntries", () => ({
  useMarkAsRead: () => ({ mutate: markAsRead }),
  useMarkAsStarred: () => ({ mutate: markAsStarred }),
}));

function entry(id: string, read: boolean, starred = false): Entry {
  return {
    id,
    feedId: "f1",
    title: `title ${id}`,
    url: `https://example.com/${id}`,
    read,
    starred,
    createdAt: "2026-09-16T00:00:00Z",
    updatedAt: "2026-09-16T00:00:00Z",
  };
}

const entries = [entry("a", false), entry("b", true), entry("c", false)];

function press(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
  );
}

describe("useEntryHotkeys", () => {
  let onSelect: Mock<(entryId: string) => void>;
  let onEscape: Mock<() => void>;

  beforeEach(() => {
    markAsRead.mockClear();
    markAsStarred.mockClear();
    onSelect = vi.fn();
    onEscape = vi.fn();
  });

  /**
   * selectedEntryId 由路由驱动：真实使用时按键后会重渲染并带来新的选中项，
   * 所以用例也要用 rerender 复现这一步，否则 j 会一直停在第一篇。
   */
  function setup(initial: string | null = null, enabled = true) {
    return renderHook(
      ({ selectedEntryId }: { selectedEntryId: string | null }) =>
        useEntryHotkeys({
          entries,
          selectedEntryId,
          onSelect,
          onEscape,
          enabled,
        }),
      { initialProps: { selectedEntryId: initial } },
    );
  }

  it("j 选中下一篇并标记已读；k 回到上一篇", () => {
    const view = setup(null);

    press("j");
    expect(onSelect).toHaveBeenLastCalledWith("a");
    expect(markAsRead).toHaveBeenLastCalledWith({ id: "a", read: true });

    view.rerender({ selectedEntryId: "a" });
    press("j");
    expect(onSelect).toHaveBeenLastCalledWith("b");
    // b 已是已读，不该再发一次
    expect(markAsRead).toHaveBeenCalledTimes(1);

    view.rerender({ selectedEntryId: "b" });
    press("k");
    expect(onSelect).toHaveBeenLastCalledWith("a");
  });

  it("已在第一篇按 k 不越界", () => {
    setup("a");
    press("k");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("m 按当前状态取反已读；s 取反星标", () => {
    setup("a");
    press("m");
    expect(markAsRead).toHaveBeenLastCalledWith({ id: "a", read: true });

    press("s");
    expect(markAsStarred).toHaveBeenLastCalledWith({ id: "a", starred: true });
  });

  it("已读文章上按 m 会标回未读", () => {
    setup("b");
    press("m");
    expect(markAsRead).toHaveBeenLastCalledWith({ id: "b", read: false });
  });

  it("没有选中文章时 m / s / v 不动作", () => {
    setup(null);
    press("m");
    press("s");
    press("v");
    expect(markAsRead).not.toHaveBeenCalled();
    expect(markAsStarred).not.toHaveBeenCalled();
  });

  it("v 在新标签打开原文", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    setup("c");
    press("v");
    expect(open).toHaveBeenCalledWith(
      "https://example.com/c",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("Escape 关闭详情，没有选中项时不触发", () => {
    setup(null);
    press("Escape");
    expect(onEscape).not.toHaveBeenCalled();

    setup("a");
    press("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("焦点在输入框时不抢键", () => {
    setup("a");
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "m", bubbles: true }),
    );
    expect(markAsRead).not.toHaveBeenCalled();
    input.remove();
  });

  it("带 Ctrl/Cmd/Alt 的组合键放行给浏览器", () => {
    setup("a");
    press("m", { ctrlKey: true });
    press("s", { metaKey: true });
    press("j", { altKey: true });
    expect(markAsRead).not.toHaveBeenCalled();
    expect(markAsStarred).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("enabled 为 false 时不绑定（例如移动端正在读文章）", () => {
    setup("a", false);
    press("m");
    press("j");
    expect(markAsRead).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
