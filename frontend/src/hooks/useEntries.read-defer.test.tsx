import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "@/types/api";
import {
  deferredRemovalIds,
  mergeDeferredRemovals,
  resetDeferredRemovals,
} from "@/components/entry-list/deferred-removal";

vi.mock("@/api", () => ({
  listEntries: vi.fn(),
  getEntry: vi.fn(),
  updateEntryReadStatus: vi.fn(() => Promise.resolve()),
  updateManyEntryReadStatus: vi.fn(() => Promise.resolve()),
  updateEntryStarred: vi.fn(() => Promise.resolve()),
  markAllAsRead: vi.fn(() => Promise.resolve()),
  getUnreadCounts: vi.fn(),
  getStarredCount: vi.fn(),
}));

import { useMarkAsRead } from "./useEntries";

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
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
  } as unknown as Entry;
}

function seed(client: QueryClient) {
  client.setQueryData(["entries", { unreadOnly: true, tag: "u" }], {
    pages: [{ entries: [makeEntry("a"), makeEntry("b")], hasMore: false }],
  });
  client.setQueryData(["entries", { unreadOnly: false, tag: "all" }], {
    pages: [{ entries: [makeEntry("a"), makeEntry("b")], hasMore: false }],
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useMarkAsRead —— 47-1 手动标已读不当场摘条目", () => {
  beforeEach(() => {
    resetDeferredRemovals();
  });

  it("read=true 时不 invalidate entries，而是把条目记进 deferred（按原位留着）", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    seed(client);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useMarkAsRead(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      result.current.mutate({ id: "b", read: true });
    });

    await waitFor(() => expect(deferredRemovalIds()).toContain("b"));
    // 重拉丢掉的条目会按原位插回，且是已读态
    const merged = mergeDeferredRemovals([makeEntry("a")]);
    expect(merged.map((e) => e.id)).toEqual(["a", "b"]);
    expect(merged[1]?.read).toBe(true);

    // 不该触发 entries 重拉（只刷未读计数）
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["entries"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["unreadCounts"] });
  });

  it("read=false 时仍照旧 invalidate entries（标未读不涉及「先别摘」）", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    seed(client);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useMarkAsRead(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      result.current.mutate({ id: "a", read: false });
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["entries"] }),
    );
    expect(deferredRemovalIds()).not.toContain("a");
  });
});
