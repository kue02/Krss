import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api";
import { useUpdateCheckStore } from "./update-check-store";
import type { UpdateCheckResult } from "@/types/settings";

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
}));

vi.mock("@/api", async () => {
  const actual = await vi.importActual<typeof import("@/api")>("@/api");
  return {
    ...actual,
    checkForUpdate: mocks.checkForUpdate,
  };
});

function result(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    currentVersion: "1.4.0",
    latestVersion: "v1.5.0",
    hasUpdate: true,
    releaseName: "v1.5.0",
    releaseUrl: "https://github.com/example/krss/releases/tag/v1.5.0",
    publishedAt: "2026-12-01T10:00:00Z",
    releaseNotesHtml: "<h2>1.5.0</h2>",
    assets: [],
    releases: [
      {
        version: "v1.5.0",
        name: "v1.5.0",
        url: "https://github.com/example/krss/releases/tag/v1.5.0",
        publishedAt: "2026-12-01T10:00:00Z",
        notesHtml: "<h2>1.5.0</h2>",
        assets: [],
      },
    ],
    ...overrides,
  };
}

describe("update-check-store", () => {
  beforeEach(() => {
    mocks.checkForUpdate.mockReset();
    useUpdateCheckStore.getState().reset();
  });

  it("检查成功后写入结果与时间戳", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());

    await useUpdateCheckStore.getState().check();

    const state = useUpdateCheckStore.getState();
    expect(state.status).toBe("success");
    expect(state.result?.latestVersion).toBe("v1.5.0");
    expect(state.checkedAt).not.toBeNull();
    expect(state.lastAttemptAt).not.toBeNull();
  });

  it("30 分钟内再次调用不重复出网", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());

    await useUpdateCheckStore.getState().check();
    await useUpdateCheckStore.getState().check();

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("force 跳过节流（用户点「检查更新」必须真查）", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());

    await useUpdateCheckStore.getState().check();
    await useUpdateCheckStore.getState().check({ force: true });

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("失败也计入节流：限流期间反复进关于页不该继续打 GitHub", async () => {
    mocks.checkForUpdate.mockRejectedValue(new ApiError("rate limited", 429));

    await useUpdateCheckStore.getState().check();
    await useUpdateCheckStore.getState().check();

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("并发调用共享同一次请求", async () => {
    let release: (value: UpdateCheckResult) => void = () => {};
    mocks.checkForUpdate.mockReturnValue(
      new Promise<UpdateCheckResult>((resolve) => {
        release = resolve;
      }),
    );

    const store = useUpdateCheckStore.getState();
    const first = store.check();
    const second = store.check();
    release(result());
    await Promise.all([first, second]);

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(useUpdateCheckStore.getState().result?.hasUpdate).toBe(true);
  });

  it("429 归类为限流、404 归类为仓库不存在、其余归为通用失败", async () => {
    const store = useUpdateCheckStore.getState();

    mocks.checkForUpdate.mockRejectedValueOnce(new ApiError("x", 429));
    await store.check({ force: true });
    expect(useUpdateCheckStore.getState().errorKind).toBe("rateLimited");

    mocks.checkForUpdate.mockRejectedValueOnce(new ApiError("x", 404));
    await store.check({ force: true });
    expect(useUpdateCheckStore.getState().errorKind).toBe("notFound");

    mocks.checkForUpdate.mockRejectedValueOnce(new ApiError("x", 502));
    await store.check({ force: true });
    expect(useUpdateCheckStore.getState().errorKind).toBe("generic");
  });

  it("失败时保留上一次成功的结果（横幅不因一次失败就消失）", async () => {
    mocks.checkForUpdate.mockResolvedValueOnce(result());
    await useUpdateCheckStore.getState().check();

    mocks.checkForUpdate.mockRejectedValueOnce(new ApiError("x", 502));
    await useUpdateCheckStore.getState().check({ force: true });

    const state = useUpdateCheckStore.getState();
    expect(state.status).toBe("error");
    expect(state.result?.hasUpdate).toBe(true);
  });

  it("markAnnounced 记录已提示过的版本，供右下角提示去重", () => {
    useUpdateCheckStore.getState().markAnnounced("v1.5.0");
    expect(useUpdateCheckStore.getState().announcedVersion).toBe("v1.5.0");
  });

  it("reset 把状态清回初始值（登出后下一位登录者不该看到上一位的结果）", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());
    await useUpdateCheckStore.getState().check();
    useUpdateCheckStore.getState().markAnnounced("v1.5.0");
    useUpdateCheckStore.getState().setToastVisible(true);
    useUpdateCheckStore.getState().setDetailOpen(true);

    useUpdateCheckStore.getState().reset();

    const state = useUpdateCheckStore.getState();
    expect(state.status).toBe("idle");
    expect(state.result).toBeNull();
    expect(state.checkedAt).toBeNull();
    expect(state.lastAttemptAt).toBeNull();
    expect(state.announcedVersion).toBeNull();
    expect(state.toastVisible).toBe(false);
    expect(state.detailOpen).toBe(false);
  });

  it("reset 后重新检查不受旧节流影响（换账号立刻能查）", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());
    await useUpdateCheckStore.getState().check();

    useUpdateCheckStore.getState().reset();
    await useUpdateCheckStore.getState().check();

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("reset 会让在飞请求作废：旧账号的结果不落到新账号身上", async () => {
    let release: (value: UpdateCheckResult) => void = () => {};
    mocks.checkForUpdate.mockReturnValue(
      new Promise<UpdateCheckResult>((resolve) => {
        release = resolve;
      }),
    );

    const pending = useUpdateCheckStore.getState().check();
    useUpdateCheckStore.getState().reset();
    release(result({ latestVersion: "v9.9.9" }));
    await pending;

    const state = useUpdateCheckStore.getState();
    expect(state.status).toBe("idle");
    expect(state.result).toBeNull();
  });

  it("reset 不会释放新请求的去重标记（旧请求的 finally 不清理新请求）", async () => {
    const releases: Array<(value: UpdateCheckResult) => void> = [];
    mocks.checkForUpdate.mockImplementation(
      () =>
        new Promise<UpdateCheckResult>((resolve) => {
          releases.push(resolve);
        }),
    );

    const first = useUpdateCheckStore.getState().check();
    useUpdateCheckStore.getState().reset();
    const second = useUpdateCheckStore.getState().check();

    // 旧请求回来时不能把 second 的 inFlight 清掉
    releases[0]?.(result({ latestVersion: "v1.0.0" }));
    await first;

    const third = useUpdateCheckStore.getState().check();
    // 第三次调用复用了第二次的 inFlight，所以没有新增出网
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(2);

    releases[1]?.(result({ latestVersion: "v2.0.0" }));
    await Promise.all([second, third]);
    expect(useUpdateCheckStore.getState().result?.latestVersion).toBe("v2.0.0");
  });

  it("setToastVisible 记录提示是否在屏上（PWA 提示靠它避让）", () => {
    useUpdateCheckStore.getState().setToastVisible(true);
    expect(useUpdateCheckStore.getState().toastVisible).toBe(true);

    useUpdateCheckStore.getState().setToastVisible(false);
    expect(useUpdateCheckStore.getState().toastVisible).toBe(false);
  });
});
