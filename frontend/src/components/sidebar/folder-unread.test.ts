import { describe, it, expect } from "vitest";
import type { Folder, Feed, ContentType } from "@/types/api";
import { computeFolderUnreadCounts } from "./folder-unread";

function makeFolder(
  id: string,
  parentId?: string,
  overrides: Partial<Folder> = {},
): Folder {
  return {
    id,
    name: id,
    type: "article" as ContentType,
    parentId,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeFeed(id: string, folderId?: string): Feed {
  return {
    id,
    folderId,
    title: id,
    url: `https://example.com/${id}`,
    type: "article" as ContentType,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

/** 便捷构造 unreadCounts */
function unreadMap(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

describe("computeFolderUnreadCounts", () => {
  it("sums direct feeds only", () => {
    const folders = [makeFolder("f1")];
    const feeds = [
      makeFeed("a", "f1"),
      makeFeed("b", "f1"),
      makeFeed("c", "f1"),
    ];
    const counts = computeFolderUnreadCounts(
      folders,
      feeds,
      unreadMap({ a: 2, b: 3, c: 1 }),
    );
    expect(counts.get("f1")).toBe(6);
  });

  it("aggregates one level of nesting: parent with no direct feeds", () => {
    const folders = [makeFolder("parent"), makeFolder("child", "parent")];
    const feeds = [makeFeed("a", "child"), makeFeed("b", "child")];
    const counts = computeFolderUnreadCounts(
      folders,
      feeds,
      unreadMap({ a: 4, b: 5 }),
    );
    expect(counts.get("child")).toBe(9);
    expect(counts.get("parent")).toBe(9);
  });

  it("aggregates two+ levels deep: grandparent gets total, direct feeds counted once", () => {
    const folders = [
      makeFolder("grandparent"),
      makeFolder("parent", "grandparent"),
      makeFolder("child", "parent"),
    ];
    const feeds = [
      makeFeed("a", "child"), // 3
      makeFeed("b", "parent"), // 2
      makeFeed("c", "grandparent"), // 1
    ];
    const counts = computeFolderUnreadCounts(
      folders,
      feeds,
      unreadMap({ a: 3, b: 2, c: 1 }),
    );
    expect(counts.get("child")).toBe(3);
    expect(counts.get("parent")).toBe(5); // 2 direct + 3 from child
    expect(counts.get("grandparent")).toBe(6); // 1 + 2 + 3
  });

  it("returns 0 for a folder with no unread feeds", () => {
    const folders = [makeFolder("empty"), makeFolder("hasUnread")];
    const feeds = [makeFeed("a", "hasUnread")];
    const counts = computeFolderUnreadCounts(
      folders,
      feeds,
      unreadMap({ a: 7 }),
    );
    expect(counts.get("empty")).toBe(0);
    expect(counts.get("hasUnread")).toBe(7);
  });

  it("handles empty input and still returns an entry for every folder", () => {
    const folders = [makeFolder("f1"), makeFolder("f2")];
    const counts = computeFolderUnreadCounts(folders, [], unreadMap({}));
    expect(counts.get("f1")).toBe(0);
    expect(counts.get("f2")).toBe(0);
    expect(counts.size).toBe(2);
  });

  it("guards against a parent cycle without infinite looping", () => {
    const folders = [
      makeFolder("a", "b"),
      makeFolder("b", "a"),
    ];
    const feeds = [makeFeed("x", "a"), makeFeed("y", "b")];
    const counts = computeFolderUnreadCounts(
      folders,
      feeds,
      unreadMap({ x: 2, y: 3 }),
    );
    // 每个文件夹都能拿到环内互相贡献的合计，且不挂死
    expect(counts.get("a")).toBe(5);
    expect(counts.get("b")).toBe(5);
  });
});
