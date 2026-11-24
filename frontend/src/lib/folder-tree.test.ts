import { describe, it, expect } from "vitest";
import type { Folder, Feed, ContentType } from "@/types/api";
import {
  collectDescendantFolderIds,
  computeFolderSubtreeUnread,
} from "./folder-tree";

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

function makeFeed(
  id: string,
  folderId: string | undefined,
  overrides: Partial<Feed> = {},
): Feed {
  return {
    id,
    folderId,
    title: id,
    url: `https://example.com/${id}`,
    type: "article" as ContentType,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("collectDescendantFolderIds", () => {
  const folders = [
    makeFolder("root"),
    makeFolder("child", "root"),
    makeFolder("grand", "child"),
    makeFolder("sibling"),
    makeFolder("siblingChild", "sibling"),
  ];

  it("返回自身 + 所有后代（含孙级）", () => {
    expect(collectDescendantFolderIds(folders, "root")).toEqual(
      new Set(["root", "child", "grand"]),
    );
    expect(collectDescendantFolderIds(folders, "child")).toEqual(
      new Set(["child", "grand"]),
    );
    expect(collectDescendantFolderIds(folders, "grand")).toEqual(
      new Set(["grand"]),
    );
  });

  it("不包含同级/其它分支", () => {
    const ids = collectDescendantFolderIds(folders, "root");
    expect(ids.has("sibling")).toBe(false);
    expect(ids.has("siblingChild")).toBe(false);
  });

  it("parentId 成环也不会死循环（去重后终止）", () => {
    const cyclic = [
      makeFolder("a", "c"),
      makeFolder("b", "a"),
      makeFolder("c", "b"),
    ];
    expect(collectDescendantFolderIds(cyclic, "a")).toEqual(
      new Set(["a", "b", "c"]),
    );
  });
});

describe("computeFolderSubtreeUnread", () => {
  const folders = [
    makeFolder("root"),
    makeFolder("child", "root"),
    makeFolder("grand", "child"),
    makeFolder("sibling"),
  ];
  const feeds = [
    makeFeed("rootFeed", "root"),
    makeFeed("grandFeed", "grand"),
    makeFeed("siblingFeed", "sibling"),
    makeFeed("looseFeed", undefined),
  ];

  it("汇总自身 + 所有后代订阅的未读，不含同级", () => {
    const counts = { rootFeed: 2, grandFeed: 5, siblingFeed: 9, looseFeed: 7 };
    expect(computeFolderSubtreeUnread(folders, feeds, counts, "root")).toBe(7);
    expect(computeFolderSubtreeUnread(folders, feeds, counts, "child")).toBe(5);
  });

  it("传 contentType 时只统计该类型的订阅", () => {
    const mixedFeeds = [
      makeFeed("a1", "grand", { type: "article" }),
      makeFeed("s1", "grand", { type: "social" }),
    ];
    const counts = { a1: 4, s1: 6 };
    expect(
      computeFolderSubtreeUnread(folders, mixedFeeds, counts, "root", "article"),
    ).toBe(4);
    expect(
      computeFolderSubtreeUnread(folders, mixedFeeds, counts, "root", "social"),
    ).toBe(6);
    expect(
      computeFolderSubtreeUnread(folders, mixedFeeds, counts, "root"),
    ).toBe(10);
  });
});
