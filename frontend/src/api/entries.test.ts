import { beforeEach, describe, expect, it, vi } from "vitest";

import { getEntry, listEntries, updateManyEntryReadStatus } from "@/api";

describe("entries api", () => {
  const storage = (() => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
      clear: () => {
        data.clear();
      },
    };
  })();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("localStorage", storage);
    localStorage.clear();
  });

  it("批量更新阅读状态时调用兼容批量端点", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await updateManyEntryReadStatus(["1", "2"], true);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/entries/read",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ ids: ["1", "2"], read: true }),
      }),
    );
  });

  // 回归：列表查询必须把外部 AbortSignal 透传到 fetch，并随其 abort，
  // 这样乐观更新的 cancelQueries 才能真正中断在途列表 GET、释放同源连接。
  it("listEntries 把外部 AbortSignal 透传到 fetch 并随之 abort", async () => {
    let captured: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_input, init) => {
      captured = init?.signal ?? undefined;
      return new Response(JSON.stringify({ entries: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const controller = new AbortController();
    await listEntries({}, controller.signal);

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
    controller.abort();
    expect(captured?.aborted).toBe(true);
  });

  it("getEntry 把外部 AbortSignal 透传到 fetch 并随之 abort", async () => {
    let captured: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_input, init) => {
      captured = init?.signal ?? undefined;
      return new Response(JSON.stringify({ id: "1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const controller = new AbortController();
    await getEntry("1", controller.signal);

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
    controller.abort();
    expect(captured?.aborted).toBe(true);
  });
});
