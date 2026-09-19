import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "@/types/api";
import {
  clearDeferredRemovals,
  deferEntryRemoval,
  deferredRemovalIds,
  getDeferredRemovalsVersion,
  hasDeferredRemovals,
  mergeDeferredRemovals,
  resetDeferredRemovals,
  subscribeDeferredRemovals,
} from "./deferred-removal";

function makeEntry(id: string, read = false): Entry {
  return {
    id,
    feedId: "f1",
    title: `entry ${id}`,
    url: `https://example.com/${id}`,
    content: "content",
    read,
    starred: false,
    muted: false,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
  } as unknown as Entry;
}

function idsOf(entries: Entry[]): string[] {
  return entries.map((entry) => entry.id);
}

describe("deferred-removal", () => {
  beforeEach(() => {
    resetDeferredRemovals();
  });

  it("没有记账时原样返回同一个引用（不白渲染）", () => {
    const list = [makeEntry("a"), makeEntry("b")];
    expect(mergeDeferredRemovals(list)).toBe(list);
  });

  it("重拉把已读条目换掉后，按原下标插回去", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const d = makeEntry("d");
    // b、c 被标已读并「先别消失」，记下它们当时的本体与下标
    deferEntryRemoval("b", { ...b, read: true }, 1);
    deferEntryRemoval("c", { ...c, read: true }, 2);
    // 服务端这次只回了 a、d（这就是「只看未读」重拉后的样子）
    const refetched = [a, d];
    const merged = mergeDeferredRemovals(refetched);
    expect(idsOf(merged)).toEqual(["a", "b", "c", "d"]);
    expect(merged[1]?.read).toBe(true);
    expect(merged[2]?.read).toBe(true);
  });

  it("服务端还回着这些条目时不重复插入", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const list = [a, b];
    deferEntryRemoval("a", { ...a, read: true }, 0);
    expect(mergeDeferredRemovals(list)).toBe(list);
  });

  it("离开列表清空后不再插回（换订阅再回来它们就该消失）", () => {
    deferEntryRemoval("b", makeEntry("b", true), 1);
    expect(hasDeferredRemovals()).toBe(true);
    clearDeferredRemovals();
    expect(hasDeferredRemovals()).toBe(false);
    expect(deferredRemovalIds()).toEqual([]);
    const refetched = [makeEntry("a")];
    expect(mergeDeferredRemovals(refetched)).toBe(refetched);
  });

  it("下标越界时落在列表末尾，不抛错", () => {
    deferEntryRemoval("x", makeEntry("x", true), 99);
    const merged = mergeDeferredRemovals([makeEntry("a")]);
    expect(idsOf(merged)).toEqual(["a", "x"]);
  });

  it("订阅者能收到变更通知（渲染要跟着走）", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDeferredRemovals(listener);
    const version = getDeferredRemovalsVersion();
    deferEntryRemoval("a", makeEntry("a", true), 0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getDeferredRemovalsVersion()).toBe(version + 1);
    unsubscribe();
    clearDeferredRemovals();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
