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
});
