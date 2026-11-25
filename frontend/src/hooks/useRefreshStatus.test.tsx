import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getRefreshStatus = vi.fn();
vi.mock("@/api", () => ({
  getRefreshStatus: (...args: unknown[]) => getRefreshStatus(...args),
}));

const requestEntriesHeadSync = vi.fn((..._args: unknown[]) =>
  Promise.resolve(),
);
vi.mock("@/lib/entries-head-sync", () => ({
  requestEntriesHeadSync: (...args: unknown[]) => requestEntriesHeadSync(...args),
}));

import {
  getRefreshStatusPollInterval,
  useRefreshStatus,
} from "./useRefreshStatus";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        // 隔离测试：不让 TanStack 自带的 focus 重取干扰「我们显式 refetch 了几次」的计数，
        // refetchInterval 的 fake-timer 计数也不受 focus 影响。
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** 强制 jsdom 的 document.visibilityState（默认 visible），测试后清理自有属性还原原型 getter */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("getRefreshStatusPollInterval", () => {
  it("可见且非刷新中 → 5000ms", () => {
    expect(getRefreshStatusPollInterval(false, true)).toBe(5_000);
  });

  it("可见且刷新中 → 2000ms", () => {
    expect(getRefreshStatusPollInterval(true, true)).toBe(2_000);
  });

  it("隐藏 → 60000ms（后台降频兜底）", () => {
    expect(getRefreshStatusPollInterval(false, false)).toBe(60_000);
    expect(getRefreshStatusPollInterval(true, false)).toBe(60_000);
  });
});

describe("useRefreshStatus —— 可见时加快轮询", () => {
  beforeEach(() => {
    getRefreshStatus.mockReset();
    requestEntriesHeadSync.mockReset();
    setVisibility("visible");
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("可见空闲时每 5s 轮询一次（fake timers 观察 refetch 次数）", async () => {
    vi.useFakeTimers();
    try {
      getRefreshStatus.mockResolvedValue({
        isRefreshing: false,
        lastRefreshedAt: "2026-11-25T00:00:00Z",
      });
      const client = makeClient();
      renderHook(() => useRefreshStatus(), { wrapper: wrapper(client) });

      // 首轮请求 + refetchInterval 定时器建立
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const afterInit = getRefreshStatus.mock.calls.length;
      expect(afterInit).toBe(1);

      // 4.9s 内不该再轮询
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_900);
      });
      expect(getRefreshStatus.mock.calls.length).toBe(afterInit);

      // 越过 5s 应轮询一次
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(getRefreshStatus.mock.calls.length).toBe(afterInit + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("刷新中每 2s 轮询一次（fake timers）", async () => {
    vi.useFakeTimers();
    try {
      getRefreshStatus.mockResolvedValue({
        isRefreshing: true,
        lastRefreshedAt: "2026-11-25T00:00:00Z",
        completed: 0,
      });
      const client = makeClient();
      renderHook(() => useRefreshStatus(), { wrapper: wrapper(client) });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const afterInit = getRefreshStatus.mock.calls.length;
      expect(afterInit).toBe(1);

      // 1.9s 内不该再轮询
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_900);
      });
      expect(getRefreshStatus.mock.calls.length).toBe(afterInit);

      // 越过 2s 应轮询一次
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(getRefreshStatus.mock.calls.length).toBe(afterInit + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useRefreshStatus —— 切回前台立即刷新", () => {
  beforeEach(() => {
    getRefreshStatus.mockReset();
    requestEntriesHeadSync.mockReset();
    setVisibility("visible");
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("visibilitychange 变为 visible 时立即 refetch 一次", async () => {
    getRefreshStatus.mockResolvedValue({
      isRefreshing: false,
      lastRefreshedAt: "2026-11-25T00:00:00Z",
    });
    const client = makeClient();
    const { result } = renderHook(() => useRefreshStatus(), {
      wrapper: wrapper(client),
    });
    await waitFor(() =>
      expect(result.current?.lastRefreshedAt).toBe("2026-11-25T00:00:00Z"),
    );
    const before = getRefreshStatus.mock.calls.length;

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() =>
      expect(getRefreshStatus.mock.calls.length).toBe(before + 1),
    );
  });

  it("页面隐藏时的 visibilitychange 不触发 refetch", async () => {
    getRefreshStatus.mockResolvedValue({
      isRefreshing: false,
      lastRefreshedAt: "2026-11-25T00:00:00Z",
    });
    const client = makeClient();
    const { result } = renderHook(() => useRefreshStatus(), {
      wrapper: wrapper(client),
    });
    await waitFor(() =>
      expect(result.current?.lastRefreshedAt).toBe("2026-11-25T00:00:00Z"),
    );
    const before = getRefreshStatus.mock.calls.length;

    await act(async () => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // 给一轮微任务机会，确认没有新增请求
    await act(async () => {
      await Promise.resolve();
    });
    expect(getRefreshStatus.mock.calls.length).toBe(before);
  });

  it("window focus 时立即 refetch 一次", async () => {
    getRefreshStatus.mockResolvedValue({
      isRefreshing: false,
      lastRefreshedAt: "2026-11-25T00:00:00Z",
    });
    const client = makeClient();
    const { result } = renderHook(() => useRefreshStatus(), {
      wrapper: wrapper(client),
    });
    await waitFor(() =>
      expect(result.current?.lastRefreshedAt).toBe("2026-11-25T00:00:00Z"),
    );
    const before = getRefreshStatus.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(getRefreshStatus.mock.calls.length).toBe(before + 1),
    );
  });
});

describe("useRefreshStatus —— 保留原有 head-sync 行为", () => {
  beforeEach(() => {
    getRefreshStatus.mockReset();
    requestEntriesHeadSync.mockReset();
    setVisibility("visible");
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("lastRefreshedAt 变化时 head-sync 并 invalidate unreadCounts/feeds", async () => {
    getRefreshStatus.mockResolvedValueOnce({
      isRefreshing: false,
      lastRefreshedAt: "2026-11-25T00:00:00Z",
    });
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRefreshStatus(), {
      wrapper: wrapper(client),
    });
    await waitFor(() =>
      expect(result.current?.lastRefreshedAt).toBe("2026-11-25T00:00:00Z"),
    );
    // 首次数据只记基线，不触发同步
    expect(requestEntriesHeadSync).not.toHaveBeenCalled();
    invalidateSpy.mockClear();

    // 第二轮返回新的 lastRefreshedAt
    getRefreshStatus.mockResolvedValue({
      isRefreshing: false,
      lastRefreshedAt: "2026-11-25T00:05:00Z",
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["refreshStatus"] });
    });

    await waitFor(() => expect(requestEntriesHeadSync).toHaveBeenCalledTimes(1));
    expect(requestEntriesHeadSync).toHaveBeenCalledWith(client);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["unreadCounts"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["feeds"] });
  });

  it("刷新中 completed 增长时提前 head-sync", async () => {
    getRefreshStatus.mockResolvedValueOnce({
      isRefreshing: true,
      lastRefreshedAt: "2026-11-25T00:00:00Z",
      completed: 1,
    });
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRefreshStatus(), {
      wrapper: wrapper(client),
    });
    await waitFor(() =>
      expect(result.current?.completed).toBe(1),
    );
    invalidateSpy.mockClear();

    getRefreshStatus.mockResolvedValue({
      isRefreshing: true,
      lastRefreshedAt: "2026-11-25T00:00:00Z",
      completed: 2,
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["refreshStatus"] });
    });

    await waitFor(() => expect(requestEntriesHeadSync).toHaveBeenCalledTimes(1));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["unreadCounts"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["feeds"] });
  });
});
