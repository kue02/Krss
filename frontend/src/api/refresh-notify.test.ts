import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 用户 9-25 反馈「点刷新后悬停看到的还是上一次的摘要，逐源列表一帧都看不到」：
 * `useRefreshStatus` 空闲时 15 秒才轮询一次，「从空闲切到刷新中」这一跳前端发现得太晚，
 * 十几秒的刷新早跑完了。修法是在 api 层发起刷新后立刻 invalidate `["refreshStatus"]`。
 * 这里锁住这个行为，避免以后被"优化"掉。
 */

const invalidateQueries = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  queryClient: {
    invalidateQueries: (...args: unknown[]) => invalidateQueries(...args),
  },
}));

import { refreshAllFeeds, refreshFeeds } from "./index";

describe("刷新接口发起后通知 refreshStatus 重取", () => {
  beforeEach(() => {
    invalidateQueries.mockClear();
    vi.unstubAllGlobals();
  });

  it("refreshAllFeeds 之后 invalidate 了 refreshStatus", async () => {
    // 用 typeof fetch 标注，才能安全读 mock.calls[0][0]（否则参数元组类型是 []）
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshAllFeeds(true);

    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/feeds/refresh");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["refreshStatus"] });
  });

  it("refreshFeeds（指定源）之后同样 invalidate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await refreshFeeds([1, 2], false);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["refreshStatus"] });
  });

  it("请求失败时不该通知（免得空转重取）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
    );
    await expect(refreshAllFeeds()).rejects.toThrow();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
