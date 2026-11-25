import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Entry } from "@/types/api";
import { findCachedListEntry } from "./entry-cache";

function makeEntry(id: string, content: string): Entry {
  return {
    id,
    feedId: "f1",
    title: `entry ${id}`,
    url: `https://example.com/${id}`,
    content,
    read: false,
    starred: false,
    muted: false,
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
  } as unknown as Entry;
}

describe("findCachedListEntry", () => {
  it("从 entries 无限列表的 pages[].entries 里找到同 id 条目", () => {
    const client = new QueryClient();
    client.setQueryData(["entries", { unreadOnly: false }], {
      pages: [
        { entries: [makeEntry("a", "A content")], hasMore: true },
        { entries: [makeEntry("b", "B content")], hasMore: false },
      ],
    });

    expect(findCachedListEntry(client, "b")?.content).toBe("B content");
  });

  it("列表里没有该 id 时返回 undefined", () => {
    const client = new QueryClient();
    client.setQueryData(["entries", { unreadOnly: false }], {
      pages: [{ entries: [makeEntry("a", "A content")], hasMore: false }],
    });

    expect(findCachedListEntry(client, "missing")).toBeUndefined();
  });

  it("正文为空的条目不作为兜底（避免显示空白正文）", () => {
    const client = new QueryClient();
    client.setQueryData(["entries", { unreadOnly: false }], {
      pages: [{ entries: [makeEntry("empty", "")], hasMore: false }],
    });

    expect(findCachedListEntry(client, "empty")).toBeUndefined();
  });
});
