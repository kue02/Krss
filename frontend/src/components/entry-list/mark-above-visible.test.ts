import { describe, it, expect } from "vitest";
import type { Entry } from "@/types/api";
import { collectUnreadIdsUpToVisible } from "./mark-above-visible";

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

describe("collectUnreadIdsUpToVisible", () => {
  it("返回「列表顶部到可视区最后一条」的未读 id（含最后一条）", () => {
    const entries = [
      makeEntry("1"),
      makeEntry("2"),
      makeEntry("3"),
      makeEntry("4"),
    ];
    // 可视区最后一条是下标 2（第 3 条）→ 标 0..2 三条
    expect(collectUnreadIdsUpToVisible(entries, 2)).toEqual(["1", "2", "3"]);
  });

  it("过滤掉范围内已读的条目：已读不重复标", () => {
    const entries = [
      makeEntry("1"),
      makeEntry("2", true),
      makeEntry("3"),
      makeEntry("4"),
    ];
    expect(collectUnreadIdsUpToVisible(entries, 2)).toEqual(["1", "3"]);
  });

  it("最后一条刚好是列表末尾时也能正常截取", () => {
    const entries = [makeEntry("1"), makeEntry("2"), makeEntry("3")];
    expect(collectUnreadIdsUpToVisible(entries, 2)).toEqual(["1", "2", "3"]);
  });

  it("lastVisibleIndex 超过条目数时按条目数封顶，不会越界", () => {
    const entries = [makeEntry("1"), makeEntry("2")];
    expect(collectUnreadIdsUpToVisible(entries, 99)).toEqual(["1", "2"]);
  });

  it("范围内没有未读时返回空数组（调用方据此弹 toast）", () => {
    const entries = [makeEntry("1", true), makeEntry("2", true), makeEntry("3")];
    expect(collectUnreadIdsUpToVisible(entries, 1)).toEqual([]);
  });

  it("lastVisibleIndex 为 -1（尚未测量）时返回空数组", () => {
    const entries = [makeEntry("1"), makeEntry("2")];
    expect(collectUnreadIdsUpToVisible(entries, -1)).toEqual([]);
  });

  it("空列表返回空数组", () => {
    expect(collectUnreadIdsUpToVisible([], 5)).toEqual([]);
  });
});
