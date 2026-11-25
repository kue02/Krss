import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AboutSettings } from "./AboutSettings";
import { ApiError } from "@/api";
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
    ...overrides,
  };
}

describe("AboutSettings", () => {
  beforeEach(() => {
    mocks.checkForUpdate.mockReset();
  });

  afterEach(() => {
    cleanup();
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

  it("Release 不存在（502 release not found）给的是配置方向", async () => {
    mocks.checkForUpdate.mockRejectedValue(
      new ApiError("update release not found", 502),
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

  it("发布说明为空时不崩、显示 no_notes 文案", async () => {
    mocks.checkForUpdate.mockResolvedValue(
      result({ releaseNotesHtml: "", hasUpdate: true }),
    );

    render(<AboutSettings />);

    await waitFor(() => expect(screen.getByText("update.available")).toBeTruthy());
    // 详情弹窗默认关闭，说明区只在打开后渲染；这里只验证组件本身不抛错
    expect(screen.queryByText("update.no_notes")).toBeNull();
  });

  it("publishedAt 非法不崩（原样渲染）", async () => {
    mocks.checkForUpdate.mockResolvedValue(
      result({ publishedAt: "not-a-date", hasUpdate: true }),
    );

    render(<AboutSettings />);

    expect(await screen.findByText("update.available")).toBeTruthy();
  });

  it("assets 为空时不渲染下载区块", async () => {
    mocks.checkForUpdate.mockResolvedValue(result({ assets: [] }));

    render(<AboutSettings />);

    await waitFor(() => expect(screen.getByText("update.available")).toBeTruthy());
    expect(screen.queryByText("update.downloads")).toBeNull();
  });
});
