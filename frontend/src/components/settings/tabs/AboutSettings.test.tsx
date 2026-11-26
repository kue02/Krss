import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AboutSettings } from "./AboutSettings";
import { ApiError } from "@/api";
import { useUpdateCheckStore } from "@/stores/update-check-store";
import { useSettingsModalStore } from "@/stores/settings-modal-store";
import type { UpdateCheckResult } from "@/types/settings";

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      const extra = Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",");
      return `${key}(${extra})`;
    },
  }),
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
    releaseNotesHtml: "<h2>1.5.0</h2><ul><li>新功能</li></ul>",
    assets: [],
    releases: [
      {
        version: "v1.5.0",
        name: "v1.5.0",
        url: "https://github.com/example/krss/releases/tag/v1.5.0",
        publishedAt: "2026-12-01T10:00:00Z",
        notesHtml: "<h2>1.5.0</h2><ul><li>新功能</li></ul>",
        assets: [],
      },
    ],
    ...overrides,
  };
}

/** 点「查看更新内容」：弹窗已搬到 App 层，这里只验证开关被打开。 */
async function clickViewDetails() {
  const trigger = await screen.findByText("update.view_details");
  fireEvent.click(trigger);
}

describe("AboutSettings", () => {
  beforeEach(() => {
    mocks.checkForUpdate.mockReset();
    // store 是模块级单例：不重置的话上一个用例的结果/节流时间戳会漏到下一个用例，
    // 表现为「第一个用例过了，后面全部失败」。
    useUpdateCheckStore.getState().reset();
    useSettingsModalStore.setState({ open: false, initialTab: null });
  });

  afterEach(() => {
    cleanup();
    useUpdateCheckStore.getState().reset();
    useSettingsModalStore.setState({ open: false, initialTab: null });
  });

  it("挂载即自动检查一次", async () => {
    mocks.checkForUpdate.mockResolvedValue(result({ hasUpdate: false }));

    render(<AboutSettings />);

    await waitFor(() => expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1));
  });

  it("有更新时展示提示条与最新版本", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());

    render(<AboutSettings />);

    expect(await screen.findByText("update.available")).toBeTruthy();
    expect(
      screen.getAllByText("v1.5.0").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("update.view_details")).toBeTruthy();
  });

  it("已是最新时不展示提示条", async () => {
    mocks.checkForUpdate.mockResolvedValue(result({ hasUpdate: false }));

    render(<AboutSettings />);

    await waitFor(() =>
      expect(screen.getByText("update.up_to_date_short")).toBeTruthy(),
    );
    expect(screen.queryByText("update.available")).toBeNull();
  });

  it("限流（429）给的是「稍后再试」而不是「连不上 GitHub」", async () => {
    mocks.checkForUpdate.mockRejectedValue(
      new ApiError("update check rate limited", 429),
    );

    render(<AboutSettings />);

    await waitFor(() =>
      expect(screen.getByText("update.check_failed")).toBeTruthy(),
    );
    expect(screen.getByText("update.check_rate_limited")).toBeTruthy();
    expect(screen.queryByText("update.check_failed_hint")).toBeNull();
    expect(screen.queryByText("update.available")).toBeNull();
  });

  it("Release 不存在（404）给的是配置方向", async () => {
    mocks.checkForUpdate.mockRejectedValue(
      new ApiError("update release not found", 404),
    );

    render(<AboutSettings />);

    await waitFor(() =>
      expect(screen.getByText("update.check_not_found")).toBeTruthy(),
    );
  });

  it("普通失败回落到通用提示", async () => {
    mocks.checkForUpdate.mockRejectedValue(new ApiError("boom", 502));

    render(<AboutSettings />);

    await waitFor(() =>
      expect(screen.getByText("update.check_failed_hint")).toBeTruthy(),
    );
  });

  it("版本号统一取后端上报值，不与前端构建期版本打架", async () => {
    mocks.checkForUpdate.mockResolvedValue(
      result({ currentVersion: "1.3.0", hasUpdate: true }),
    );

    render(<AboutSettings />);

    // 「当前版本」与「应用信息」两处都应是后端上报的 1.3.0
    const occurrences = await screen.findAllByText("v1.3.0");
    expect(occurrences.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("1.3.0")).toBeTruthy();
    expect(screen.queryByText("v1.4.0")).toBeNull();
  });

  it("点「查看更新内容」只打开详情弹窗，不打开设置页", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());

    render(<AboutSettings />);
    await clickViewDetails();

    expect(useUpdateCheckStore.getState().detailOpen).toBe(true);
    expect(useSettingsModalStore.getState().open).toBe(false);
  });

  it("重新检查进行中横幅不消失（有更新是事实，不随 loading 变）", async () => {
    mocks.checkForUpdate.mockResolvedValueOnce(result());

    render(<AboutSettings />);
    expect(await screen.findByText("update.available")).toBeTruthy();

    // 第二次检查挂住不 resolve，模拟「正在检查」
    let release: (value: UpdateCheckResult) => void = () => {};
    mocks.checkForUpdate.mockReturnValueOnce(
      new Promise<UpdateCheckResult>((resolve) => {
        release = resolve;
      }),
    );

    fireEvent.click(screen.getByText("update.recheck"));

    // 期间反复采样，横幅必须一直在
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByText("update.available")).toBeTruthy();
    }

    release(result());
    await waitFor(() => expect(mocks.checkForUpdate).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("update.available")).toBeTruthy();
  });

  it("重新检查失败时保留上次结果，同时给出失败提示", async () => {
    // 这是 hasUpdate 与 status 解耦后的既定行为：横幅说的是「上次查到的结果」，
    // 版本行说的是「这次没查成」，两者并不矛盾。用测试把预期钉住。
    mocks.checkForUpdate.mockResolvedValueOnce(result());
    mocks.checkForUpdate.mockRejectedValueOnce(new ApiError("boom", 502));

    render(<AboutSettings />);
    expect(await screen.findByText("update.available")).toBeTruthy();

    fireEvent.click(screen.getByText("update.recheck"));

    await waitFor(() =>
      expect(screen.getByText("update.check_failed")).toBeTruthy(),
    );
    expect(screen.getByText("update.check_failed_hint")).toBeTruthy();
    expect(screen.queryByText("update.available")).toBeTruthy();
  });
});
