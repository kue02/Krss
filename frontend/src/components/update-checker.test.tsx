import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import { UpdateChecker } from "./update-checker";
import { useUpdateCheckStore } from "@/stores/update-check-store";
import { useSettingsModalStore } from "@/stores/settings-modal-store";
import type { UpdateCheckResult } from "@/types/settings";

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  toast: vi.fn<(message: string, options?: Record<string, unknown>) => string>(
    () => "toast-key",
  ),
  toastClose: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")})` : key,
  }),
}));

vi.mock("@/api", async () => {
  const actual = await vi.importActual<typeof import("@/api")>("@/api");
  return { ...actual, checkForUpdate: mocks.checkForUpdate };
});

// 只替换掉真正碰 DOM 的两处：toast() 的调用与 Toast.Provider 的渲染。
// 其余导出保持原样，免得把 HeroUI 的组件树整个打桩。
vi.mock("@heroui/react", async () => {
  const actual = await vi.importActual<typeof import("@heroui/react")>("@heroui/react");
  const toast = Object.assign(mocks.toast, { close: mocks.toastClose });
  return {
    ...actual,
    toast,
    Toast: Object.assign(() => null, actual.Toast, {
      Provider: () => null,
    }),
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

describe("UpdateChecker", () => {
  beforeEach(() => {
    mocks.checkForUpdate.mockReset();
    mocks.toast.mockClear();
    mocks.toastClose.mockClear();
    useUpdateCheckStore.getState().reset();
    useSettingsModalStore.setState({ open: false, initialTab: null });
  });

  afterEach(() => {
    cleanup();
    useUpdateCheckStore.getState().reset();
  });

  it("挂载即检查一次（主页也要能发现新版本）", async () => {
    mocks.checkForUpdate.mockResolvedValue(result({ hasUpdate: false }));

    render(<UpdateChecker />);

    await waitFor(() => expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1));
  });

  it("有更新时弹一条常驻提示（timeout 0），并带上「查看更新内容」", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());

    render(<UpdateChecker />);

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    const [title, options = {}] = mocks.toast.mock.calls[0] ?? [];
    expect(title).toBe("update.available");
    expect(options.timeout).toBe(0);
    expect(options.description).toBe("update.banner_desc(version=v1.5.0)");
    const actionProps = options.actionProps as { children: string };
    expect(actionProps.children).toBe("update.view_details");
    expect(useUpdateCheckStore.getState().toastVisible).toBe(true);
  });

  it("已是最新时不打扰（不弹提示）", async () => {
    mocks.checkForUpdate.mockResolvedValue(result({ hasUpdate: false }));

    render(<UpdateChecker />);

    await waitFor(() => expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(useUpdateCheckStore.getState().toastVisible).toBe(false);
  });

  it("检查失败也不弹（失败原因留给关于页说明）", async () => {
    mocks.checkForUpdate.mockRejectedValue(new Error("boom"));

    render(<UpdateChecker />);

    await waitFor(() => expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("同一个版本只弹一次（重渲染/StrictMode 不重复打扰）", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());

    const view = render(<UpdateChecker />);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));

    view.rerender(<UpdateChecker />);
    await waitFor(() => expect(useUpdateCheckStore.getState().announcedVersion).toBe("v1.5.0"));
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("点「查看更新内容」只弹出详情，不打开设置页", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());

    render(<UpdateChecker />);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));

    const options = mocks.toast.mock.calls[0]?.[1] as {
      actionProps: { onPress: () => void };
    };
    options.actionProps.onPress();

    // 弹窗挂在 App 层，开关就是 store 里的 detailOpen；
    // 设置页不该被顺带打开 —— 「看更新内容」是读文档，不是改设置。
    expect(useUpdateCheckStore.getState().detailOpen).toBe(true);
    const settings = useSettingsModalStore.getState();
    expect(settings.open).toBe(false);
    expect(settings.initialTab).toBeNull();
  });

  it("详情弹窗打开时收起提示，关掉后再放回来", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());

    render(<UpdateChecker />);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));

    // 弹窗层级低于 toast，手机上常驻提示会盖住弹窗底部按钮。
    act(() => useUpdateCheckStore.getState().setDetailOpen(true));
    await waitFor(() => expect(mocks.toastClose).toHaveBeenCalledWith("toast-key"));
    expect(useUpdateCheckStore.getState().toastVisible).toBe(false);

    act(() => useUpdateCheckStore.getState().setDetailOpen(false));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(2));
    expect(useUpdateCheckStore.getState().toastVisible).toBe(true);
  });

  it("卸载时收掉提示并清空状态（登出后下一位登录者不该看到上一位的提示）", async () => {
    mocks.checkForUpdate.mockResolvedValue(result());

    const view = render(<UpdateChecker />);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));

    view.unmount();

    expect(mocks.toastClose).toHaveBeenCalledWith("toast-key");
    const state = useUpdateCheckStore.getState();
    expect(state.toastVisible).toBe(false);
    expect(state.result).toBeNull();
    expect(state.announcedVersion).toBeNull();
  });
});
