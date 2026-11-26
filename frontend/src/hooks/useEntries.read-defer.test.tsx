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

import {
  useMarkAsRead,
  useMarkAllAsRead,
  useMarkManyAsRead,
  useMarkAsStarred,
  useRemoveReadEntriesFromUnreadList,
} from "./useEntries";
import { updateEntryStarred } from "@/api";

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

describe("useMarkAsStarred —— 59 星标乐观更新不触发 entries 重拉", () => {
  beforeEach(() => {
    resetDeferredRemovals();
    vi.mocked(updateEntryStarred).mockReset();
    vi.mocked(updateEntryStarred).mockResolvedValue(undefined);
  });

  it("mutate(starred:true) 乐观写入 entries 列表与单条缓存，成功后不 invalidate entries", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    seed(client);
    // 单条条目缓存（正文页读的就是这条）
    client.setQueryData(["entry", "b"], makeEntry("b"));
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useMarkAsStarred(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      result.current.mutate({ id: "b", starred: true });
    });

    // 乐观：两个 entries 列表里 b 的 starred 都已置真
    const unreadList = client.getQueryData<{
      pages: { entries: Entry[] }[];
    }>(["entries", { unreadOnly: true, tag: "u" }]);
    expect(
      unreadList?.pages[0]?.entries.find((e) => e.id === "b")?.starred,
    ).toBe(true);

    const allList = client.getQueryData<{
      pages: { entries: Entry[] }[];
    }>(["entries", { unreadOnly: false, tag: "all" }]);
    expect(
      allList?.pages[0]?.entries.find((e) => e.id === "b")?.starred,
    ).toBe(true);

    // 单条缓存同样置真
    expect(client.getQueryData<Entry>(["entry", "b"])?.starred).toBe(true);

    // 成功后只刷星标数量，绝不重拉 entries（否则刚读过的条目会消失、列表跳动）
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["starredCount"] }),
    );
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["entries"] });
  });

  it("onError 时把单条缓存与列表缓存回滚到原 starred 值", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    seed(client);
    client.setQueryData(["entry", "b"], makeEntry("b"));
    vi.mocked(updateEntryStarred).mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useMarkAsStarred(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      result.current.mutate({ id: "b", starred: true });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // 回滚：单条与列表里的 b 都恢复成原来的 starred=false
    expect(client.getQueryData<Entry>(["entry", "b"])?.starred).toBe(false);
    const allList = client.getQueryData<{
      pages: { entries: Entry[] }[];
    }>(["entries", { unreadOnly: false, tag: "all" }]);
    expect(
      allList?.pages[0]?.entries.find((e) => e.id === "b")?.starred,
    ).toBe(false);
  });

  it("取消星标(starred:false) 时列表与单条缓存里的 starred 变 false", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // 造一个已星标的条目
    client.setQueryData(["entries", { unreadOnly: false, tag: "all" }], {
      pages: [
        { entries: [{ ...makeEntry("b"), starred: true }], hasMore: false },
      ],
    });
    client.setQueryData(["entry", "b"], { ...makeEntry("b"), starred: true });

    const { result } = renderHook(() => useMarkAsStarred(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      result.current.mutate({ id: "b", starred: false });
    });

    await waitFor(() =>
      expect(client.getQueryData<Entry>(["entry", "b"])?.starred).toBe(false),
    );
    const allList = client.getQueryData<{
      pages: { entries: Entry[] }[];
    }>(["entries", { unreadOnly: false, tag: "all" }]);
    expect(
      allList?.pages[0]?.entries.find((e) => e.id === "b")?.starred,
    ).toBe(false);
  });

  it("取消星标(starred:false) 不当场摘行：starredOnly 视图不重拉，只记账等离开列表再清", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    seed(client); // unreadOnly / all 两个普通视图
    client.setQueryData(["entries", { starredOnly: true }], {
      pages: [
        { entries: [{ ...makeEntry("b"), starred: true }], hasMore: false },
      ],
    });

    const { result } = renderHook(() => useMarkAsStarred(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      result.current.mutate({ id: "b", starred: false });
    });

    // 不再重拉：starredOnly 视图保持原样（行还在，只是 starred 变 false），
    // 与「已读不立刻消失」同一套语义 —— 离开列表时才由 removeUnstarredFromStarredList 收口。
    await waitFor(() => {
      const starredOnlyQuery = client
        .getQueryCache()
        .findAll({ queryKey: ["entries"] })
        .find(
          (q) =>
            (q.queryKey[1] as { starredOnly?: boolean } | undefined)
              ?.starredOnly === true,
        );
      expect(starredOnlyQuery?.state.isInvalidated).toBe(false);
    });

    // 该行仍留在 starredOnly 缓存里，只是星标态已就地改成 false
    const starredList = client.getQueryData<{
      pages: { entries: Entry[] }[];
    }>(["entries", { starredOnly: true }]);
    expect(
      starredList?.pages[0]?.entries.find((e) => e.id === "b"),
    ).toBeTruthy();
    expect(
      starredList?.pages[0]?.entries.find((e) => e.id === "b")?.starred,
    ).toBe(false);

    // 已经记账：离开列表时可据此真正摘掉
    expect(deferredRemovalIds()).toContain("b");

    // 普通（未读/全部）视图不受影响，避免重新引入「读时收藏条目消失」的 bug
    const unreadQuery = client
      .getQueryCache()
      .findAll({ queryKey: ["entries"] })
      .find((q) => (q.queryKey[1] as { tag?: string } | undefined)?.tag === "u");
    expect(unreadQuery?.state.isInvalidated).toBe(false);
  });
});

describe("useRemoveReadEntriesFromUnreadList —— 离开列表按 read 兜底摘除已读条目", () => {
  it("摘掉 unreadOnly 里的已读条目、保留未读，且不动非 unreadOnly 查询", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // unreadOnly：a 已读（模拟「点开路径/竞态」漏记账的残留）、b 未读
    client.setQueryData(["entries", { unreadOnly: true, tag: "u" }], {
      pages: [
        { entries: [makeEntry("a", true), makeEntry("b", false)], hasMore: false },
      ],
    });
    // 非 unreadOnly：本来就允许有已读条目，不应被动
    client.setQueryData(["entries", { unreadOnly: false, tag: "all" }], {
      pages: [
        { entries: [makeEntry("a", true), makeEntry("b", false)], hasMore: false },
      ],
    });

    const { result } = renderHook(() => useRemoveReadEntriesFromUnreadList(), {
      wrapper: wrapper(client),
    });
    act(() => {
      result.current();
    });

    const unread = client.getQueryData<{ pages: { entries: Entry[] }[] }>([
      "entries",
      { unreadOnly: true, tag: "u" },
    ]);
    expect(unread?.pages[0]?.entries.map((e) => e.id)).toEqual(["b"]);

    const all = client.getQueryData<{ pages: { entries: Entry[] }[] }>([
      "entries",
      { unreadOnly: false, tag: "all" },
    ]);
    expect(all?.pages[0]?.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("useMarkManyAsRead / useMarkAllAsRead —— 批量标已读也不当场摘条目", () => {
  beforeEach(() => {
    resetDeferredRemovals();
  });

  function seedUnread(client: QueryClient) {
    client.setQueryData(["entries", { unreadOnly: true, tag: "u" }], {
      pages: [
        { entries: [makeEntry("a"), makeEntry("b")], hasMore: false },
      ],
    });
  }

  it("markMany 标已读后条目原位保留（read=true），并记进 deferred", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    seedUnread(client);

    const { result } = renderHook(() => useMarkManyAsRead(), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      result.current.mutate({ ids: ["a"], read: true });
    });

    const list = client.getQueryData<{ pages: { entries: Entry[] }[] }>([
      "entries",
      { unreadOnly: true, tag: "u" },
    ]);
    const rows = list?.pages[0]?.entries ?? [];
    expect(rows.map((e) => e.id)).toEqual(["a", "b"]);
    expect(rows.find((e) => e.id === "a")?.read).toBe(true);
    expect(deferredRemovalIds()).toContain("a");
    expect(deferredRemovalIds()).not.toContain("b");
  });

  it("markAll 后整屏已读条目原位保留（read=true），全部记进 deferred", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    seedUnread(client);

    const { result } = renderHook(() => useMarkAllAsRead(), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      result.current.mutate({} as never);
    });

    const list = client.getQueryData<{ pages: { entries: Entry[] }[] }>([
      "entries",
      { unreadOnly: true, tag: "u" },
    ]);
    const rows = list?.pages[0]?.entries ?? [];
    expect(rows.map((e) => e.id)).toEqual(["a", "b"]);
    expect(rows.every((e) => e.read)).toBe(true);
    expect(deferredRemovalIds()).toContain("a");
    expect(deferredRemovalIds()).toContain("b");
  });

  it("markAll 在普通视图（unreadOnly=false）也把行内改成已读，圆点当场消失且不记账", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // 普通「全部文章」视图：a、b 都未读
    client.setQueryData(["entries", { unreadOnly: false, tag: "all" }], {
      pages: [{ entries: [makeEntry("a"), makeEntry("b")], hasMore: false }],
    });

    const { result } = renderHook(() => useMarkAllAsRead(), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      result.current.mutate({} as never);
    });

    const list = client.getQueryData<{ pages: { entries: Entry[] }[] }>([
      "entries",
      { unreadOnly: false, tag: "all" },
    ]);
    const rows = list?.pages[0]?.entries ?? [];
    expect(rows.every((e) => e.read)).toBe(true);
    // 普通视图不摘行、也不需要延迟记账
    expect(deferredRemovalIds()).toEqual([]);
  });
});
