import { describe, it, expect } from "vitest";
import type { Entry } from "@/types/api";
import { collectUnreadIdsAboveVisible } from "./mark-above-visible";

function makeEntry(id: string, read = false): Entry {
  return {
    id,
    feedId: "feed-1",
    title: `Title ${id}`,
    content: `<p>Content for entry ${id}</p>`,
    read,
    starred: false,
    muted: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

describe("collectUnreadIdsAboveVisible", () => {
  it("有未读时只返回可视区域以上（前 firstVisibleIndex 条）的未读 id", () => {
    const entries = [
      makeEntry("1"),
      makeEntry("2"),
      makeEntry("3"),
      makeEntry("4"),
    ];
    // 前两条已滚出屏幕上方的未读条目 → 只标这两条
    expect(collectUnreadIdsAboveVisible(entries, 2)).toEqual(["1", "2"]);
  });

  it("过滤掉上方已读的条目：已读不重复标", () => {
    const entries = [
      makeEntry("1"),
      makeEntry("2", true),
      makeEntry("3"),
      makeEntry("4"),
    ];
    expect(collectUnreadIdsAboveVisible(entries, 3)).toEqual(["1", "3"]);
  });

  it("上方没有未读时返回空数组（调用方据此弹 toast，不再静默返回）", () => {
    const entries = [makeEntry("1", true), makeEntry("2", true), makeEntry("3")];
    expect(collectUnreadIdsAboveVisible(entries, 2)).toEqual([]);
  });

  it("firstVisibleIndex 为 0（仍停在顶部）时返回空数组", () => {
    const entries = [makeEntry("1"), makeEntry("2")];
    expect(collectUnreadIdsAboveVisible(entries, 0)).toEqual([]);
  });

  it("firstVisibleIndex 超过条目数时按条目数封顶，不会越界", () => {
    const entries = [makeEntry("1"), makeEntry("2")];
    expect(collectUnreadIdsAboveVisible(entries, 99)).toEqual(["1", "2"]);
  });

  it("空列表返回空数组", () => {
    expect(collectUnreadIdsAboveVisible([], 5)).toEqual([]);
  });
});
