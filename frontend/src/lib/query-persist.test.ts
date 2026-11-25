import { QueryClient, type DehydratedState, type Query } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 轻量内存版 idb-keyval：测试只关心「存了什么、能不能读回来 / 什么时候被清掉」，
// 不需要真实 IndexedDB。工厂里的 memory 在所有 get/set/del 间共享。
const idbMemory = vi.hoisted(() => new Map<unknown, unknown>());

vi.mock("idb-keyval", () => {
  return {
    createStore: () => ({ name: "mock-store" }),
    get: vi.fn(async (key: unknown) => idbMemory.get(key)),
    set: vi.fn(async (key: unknown, value: unknown) => {
      idbMemory.set(key, value);
    }),
    del: vi.fn(async (key: unknown) => {
      idbMemory.delete(key);
    }),
    keys: vi.fn(async () => Array.from(idbMemory.keys())),
  };
});

import {
  PERSIST_MAX_AGE,
  bootstrapQueryCache,
  boundDehydratedState,
  clearSnapshot,
  computeDehydratedState,
  getCacheBuster,
  isSnapshotFresh,
  persistNow,
  readSnapshot,
  restoreSnapshot,
  shouldDehydrateQuery,
  writeSnapshot,
  type PersistedSnapshot,
} from "./query-persist";

const entriesData = {
  pages: [
    {
      entries: [
        { id: "1", title: "hello", read: false },
        { id: "2", title: "world", read: true },
      ],
      hasMore: true,
    },
  ],
  pageParams: [0],
};

function fakeQuery(
  status: string,
  fetchStatus: string,
  queryKey: readonly unknown[],
): Query {
  return { state: { status, fetchStatus }, queryKey } as unknown as Query;
}

describe("shouldDehydrateQuery", () => {
  it("persists completed entries list and entry detail queries", () => {
    expect(
      shouldDehydrateQuery(fakeQuery("success", "idle", ["entries", { limit: 50 }])),
    ).toBe(true);
    expect(shouldDehydrateQuery(fakeQuery("success", "idle", ["entry", "42"]))).toBe(
      true,
    );
  });

  it("skips count queries and other families", () => {
    expect(shouldDehydrateQuery(fakeQuery("success", "idle", ["unreadCounts"]))).toBe(
      false,
    );
    expect(shouldDehydrateQuery(fakeQuery("success", "idle", ["viewCounts"]))).toBe(
      false,
    );
    expect(
      shouldDehydrateQuery(fakeQuery("success", "idle", ["starredCount", "all"])),
    ).toBe(false);
    expect(
      shouldDehydrateQuery(fakeQuery("success", "idle", ["feeds"] )),
    ).toBe(false);
  });

  it("skips pending/error queries (no durable data)", () => {
    expect(shouldDehydrateQuery(fakeQuery("pending", "idle", ["entries", {}]))).toBe(
      false,
    );
    expect(shouldDehydrateQuery(fakeQuery("error", "idle", ["entries", {}]))).toBe(
      false,
    );
  });

  it("skips queries that are actively fetching", () => {
    expect(
      shouldDehydrateQuery(fakeQuery("success", "fetching", ["entries", {}])),
    ).toBe(false);
  });
});

describe("computeDehydratedState", () => {
  it("keeps only whitelisted queries and no mutations", () => {
    const client = new QueryClient();
    client.setQueryData(["entries", { limit: 50 }], entriesData);
    client.setQueryData(["entry", "1"], { id: "1", title: "hello", read: false });
    client.setQueryData(["unreadCounts"], { total: 3 });
    client.setQueryData(["viewCounts"], [{ id: "v", count: 1 }]);

    const state = computeDehydratedState(client);
    const keys = state.queries.map((q) => q.queryKey[0]).sort();
    expect(keys).toEqual(["entries", "entry"]);
    expect(state.mutations).toEqual([]);
  });
});

describe("boundDehydratedState", () => {
  type DehydratedQuery = DehydratedState["queries"][number];

  function dehydratedQuery(partial: {
    queryHash: string;
    queryKey: readonly unknown[];
    queryType?: "infinite";
    data: unknown;
  }): DehydratedQuery {
    return {
      queryHash: partial.queryHash,
      queryKey: partial.queryKey,
      ...(partial.queryType && { queryType: partial.queryType }),
      state: { data: partial.data } as unknown as DehydratedQuery["state"],
    };
  }

  it("trims an infinite entries query to its first page", () => {
    const state: DehydratedState = {
      mutations: [],
      queries: [
        dehydratedQuery({
          queryHash: '["entries",{}]',
          queryKey: ["entries", {}],
          queryType: "infinite",
          data: {
            pages: [{ p: 0 }, { p: 1 }, { p: 2 }],
            pageParams: [0, 50, 100],
          },
        }),
      ],
    };

    const bounded = boundDehydratedState(state);
    const data = bounded.queries[0]!.state.data as {
      pages: unknown[];
      pageParams: unknown[];
    };
    expect(data.pages).toHaveLength(1);
    expect(data.pageParams).toEqual([0]);
  });

  it("keeps non-infinite (detail) queries untouched", () => {
    const detail = dehydratedQuery({
      queryHash: '["entry","1"]',
      queryKey: ["entry", "1"],
      data: { id: "1" },
    });
    const bounded = boundDehydratedState({ mutations: [], queries: [detail] });
    expect(bounded.queries[0]).toBe(detail);
  });
});

describe("isSnapshotFresh", () => {
  const snapshot: PersistedSnapshot = {
    buster: "1.0.0",
    owner: "u-test",
    savedAt: 1_000,
    state: { mutations: [], queries: [] },
  };

  it("accepts a snapshot within maxAge for the same buster", () => {
    expect(isSnapshotFresh(snapshot, "1.0.0", 1_000 + 10, 1_000)).toBe(true);
  });

  it("rejects a snapshot whose buster changed (app version bump)", () => {
    expect(isSnapshotFresh(snapshot, "2.0.0", 1_000 + 10, 1_000)).toBe(false);
  });

  it("rejects an expired snapshot", () => {
    expect(isSnapshotFresh(snapshot, "1.0.0", 1_000 + 2_000, 1_000)).toBe(false);
  });

  it("rejects a snapshot stamped in the future (clock rollback)", () => {
    expect(isSnapshotFresh(snapshot, "1.0.0", 500, 1_000)).toBe(false);
  });
});

describe("IndexedDB storage round-trip", () => {
  beforeEach(async () => {
    // jsdom 没有 indexedDB；这里补一个占位符让 isBrowser() 成立，真正的存储由上面的 mock 承担。
    vi.stubGlobal("indexedDB", { open: () => undefined });
    // 未登录（无令牌）时 persistNow 会跳过落盘，测试里放一个令牌代表已登录用户。
    localStorage.setItem("krss_auth_token", "test-token");
    idbMemory.clear();
    await clearSnapshot();
  });

  afterEach(() => {
    localStorage.removeItem("krss_auth_token");
  });

  it("persistNow → readSnapshot → restoreSnapshot restores entries data", async () => {
    const source = new QueryClient();
    source.setQueryData(["entries", { limit: 50 }], entriesData);
    source.setQueryData(["unreadCounts"], { total: 3 });

    await persistNow(source);

    const snapshot = await readSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot?.buster).toBe(getCacheBuster());
    // 只落了 entries 一条
    expect(snapshot?.state.queries).toHaveLength(1);

    const target = new QueryClient();
    const restored = await restoreSnapshot(target);
    expect(restored).toBe(true);
    expect(target.getQueryData(["entries", { limit: 50 }])).toEqual(entriesData);
    // 未持久化的 unreadCounts 不应被恢复
    expect(target.getQueryData(["unreadCounts"])).toBeUndefined();
  });

  it("drops the snapshot when the buster does not match", async () => {
    const source = new QueryClient();
    source.setQueryData(["entries", { limit: 50 }], entriesData);
    await persistNow(source);

    const stored = await readSnapshot();
    expect(stored).toBeDefined();
    // 篡改成旧版本号，模拟 app 升级
    const staleSnapshot: PersistedSnapshot = {
      ...(stored as PersistedSnapshot),
      buster: "0.0.1",
    };
    await writeSnapshot(staleSnapshot);

    const target = new QueryClient();
    const restored = await restoreSnapshot(target);
    expect(restored).toBe(false);
    expect(target.getQueryData(["entries", { limit: 50 }])).toBeUndefined();
    // 失配后旧快照被清掉
    expect(await readSnapshot()).toBeUndefined();
  });

  it("drops a snapshot older than maxAge", async () => {
    const source = new QueryClient();
    source.setQueryData(["entries", { limit: 50 }], entriesData);
    await persistNow(source);

    const target = new QueryClient();
    const restored = await restoreSnapshot(target, {
      now: Date.now() + PERSIST_MAX_AGE + 1,
    });
    expect(restored).toBe(false);
    expect(target.getQueryData(["entries", { limit: 50 }])).toBeUndefined();
  });

  it("does not create a snapshot when there is nothing persistable", async () => {
    const source = new QueryClient();
    source.setQueryData(["unreadCounts"], { total: 3 });
    await persistNow(source);
    expect(await readSnapshot()).toBeUndefined();
  });

  it("does not wipe an existing snapshot when a persist pass is transiently empty", async () => {
    const withEntries = new QueryClient();
    withEntries.setQueryData(["entries", { limit: 50 }], entriesData);
    await persistNow(withEntries);
    expect(await readSnapshot()).toBeDefined();

    // 模拟「查询正处于 refetch、被 shouldDehydrateQuery 跳过」导致的空状态：
    // 这不应清掉已有快照（旧版会在此处误删本地优先缓存）。
    const transient = new QueryClient();
    transient.setQueryData(["unreadCounts"], { total: 3 });
    await persistNow(transient);
    const snapshot = await readSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot?.state.queries).toHaveLength(1);
  });

  it("does not persist or restore another account's snapshot (owner isolation)", async () => {
    const source = new QueryClient();
    source.setQueryData(["entries", { limit: 50 }], entriesData);
    await persistNow(source);
    expect(await readSnapshot()).toBeDefined();

    // 换账号（令牌变化）：读不到上一位的快照，也不会恢复它的条目。
    localStorage.setItem("krss_auth_token", "another-account-token");
    expect(await readSnapshot()).toBeUndefined();
    const target = new QueryClient();
    expect(await restoreSnapshot(target)).toBe(false);
    expect(target.getQueryData(["entries", { limit: 50 }])).toBeUndefined();
  });

  it("does not persist while signed out (no token)", async () => {
    localStorage.removeItem("krss_auth_token");
    const source = new QueryClient();
    source.setQueryData(["entries", { limit: 50 }], entriesData);
    await persistNow(source);
    expect(await readSnapshot()).toBeUndefined();
  });

  it("新账号启动时清掉其它账号遗留的快照键", async () => {
    const source = new QueryClient();
    source.setQueryData(["entries", { limit: 50 }], entriesData);

    localStorage.setItem("krss_auth_token", "account-a");
    await persistNow(source);
    expect(await readSnapshot()).toBeDefined();

    localStorage.setItem("krss_auth_token", "account-b");
    await persistNow(source);
    await bootstrapQueryCache(new QueryClient(), { timeoutMs: 100 });

    // 自己的还在
    expect(await readSnapshot()).toBeDefined();
    // 上一位账号的键被清掉
    localStorage.setItem("krss_auth_token", "account-a");
    expect(await readSnapshot()).toBeUndefined();
  });

  it("未登录启动不删其它账号遗留的快照", async () => {
    const source = new QueryClient();
    source.setQueryData(["entries", { limit: 50 }], entriesData);

    localStorage.setItem("krss_auth_token", "account-a");
    await persistNow(source);
    expect(await readSnapshot()).toBeDefined();

    localStorage.removeItem("krss_auth_token");
    await bootstrapQueryCache(new QueryClient(), { timeoutMs: 100 });

    // 登录页（anon）不能把真实账号的缓存清掉
    localStorage.setItem("krss_auth_token", "account-a");
    expect(await readSnapshot()).toBeDefined();
  });

  it("is a no-op without a browser (no window)", async () => {
    vi.unstubAllGlobals();
    // jsdom 下 window 仍存在；直接验证 isBrowser 依赖的 indexedDB 缺失场景由 storage 层兜底：
    // 这里仅断言 persistNow 在无 indexedDB 时不会抛错（回归保护）。
    await expect(persistNow(new QueryClient())).resolves.toBeUndefined();
  });
});
