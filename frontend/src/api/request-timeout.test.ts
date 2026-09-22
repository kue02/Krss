import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, listFeeds } from "./index";

/**
 * 回归（用户第十一批 11-21）：外部依赖（推送 / AI / 抓取）慢或挂住时，界面不能永远转圈。
 *
 * 后端那一侧实测是有超时的（外部调用 10s 断），所以前端也必须有兜底：
 * 至少要把「一直转」变成「一句看得懂的失败原因」。
 */
describe("request 兜底超时", () => {
  // 同目录其它测试会动 localStorage/window，这里自己备一份，避免互相污染
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("给每个普通请求带上 abort signal（调用方没给信号时由兜底超时提供）", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await listFeeds();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("超时（DOMException: TimeoutError）要抛一句人能看懂的失败原因，而不是空错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );

    await expect(listFeeds()).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("请求超时"),
    });
    await expect(listFeeds()).rejects.toBeInstanceOf(ApiError);
  });

  it("其它网络错误原样抛出（不要把它们伪装成超时）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(listFeeds()).rejects.toBeInstanceOf(TypeError);
  });
});
