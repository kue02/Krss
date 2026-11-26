import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SettingsModal } from "./SettingsModal";
import { useSettingsModalStore } from "@/stores/settings-modal-store";
import { useUpdateCheckStore } from "@/stores/update-check-store";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "zh" },
  }),
}));

/**
 * 只测「打开时落在哪个页」这条路径 —— 各 tab 的内容由它们自己的测试覆盖。
 * 所有 tab 组件都打桩成带 id 的空节点，避免把整个设置面板的依赖拖进来。
 */
vi.mock("./tabs/GeneralSettings", () => ({ GeneralSettings: () => <div>tab-general</div> }));
vi.mock("./tabs/AboutSettings", () => ({ AboutSettings: () => <div>tab-about</div> }));
vi.mock("./tabs/AppearanceSettings", () => ({ AppearanceSettings: () => <div>tab-appearance</div> }));
vi.mock("./tabs/NetworkSettings", () => ({ NetworkSettings: () => <div>tab-network</div> }));
vi.mock("./tabs/AISettings", () => ({ AISettings: () => <div>tab-ai</div> }));
vi.mock("./tabs/PluginsSettings", () => ({ PluginsSettings: () => <div>tab-plugins</div> }));
vi.mock("./tabs/DataSettings", () => ({ DataSettings: () => <div>tab-data</div> }));
vi.mock("./tabs/FeedsSettings", () => ({ FeedsSettings: () => <div>tab-feeds</div> }));
vi.mock("./tabs/FoldersSettings", () => ({ FoldersSettings: () => <div>tab-folders</div> }));
vi.mock("./tabs/AutomationSettings", () => ({ AutomationSettings: () => <div>tab-automation</div> }));
vi.mock("./tabs/AdvancedSettings", () => ({ AdvancedSettings: () => <div>tab-advanced</div> }));

describe("SettingsModal 打开时落在哪个 tab", () => {
  beforeEach(() => {
    useSettingsModalStore.setState({ open: false, initialTab: null });
    useUpdateCheckStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useSettingsModalStore.setState({ open: false, initialTab: null });
    useUpdateCheckStore.getState().reset();
  });

  it("默认打开「通用」", async () => {
    render(<SettingsModal open onOpenChange={() => {}} />);
    expect(await screen.findByText("tab-general")).toBeTruthy();
  });

  it("openWithTab 让弹窗直接落在指定页（右下角提示点一次就到位）", async () => {
    useSettingsModalStore.getState().openWithTab("about");

    render(<SettingsModal open onOpenChange={() => {}} />);

    expect(await screen.findByText("tab-about")).toBeTruthy();
    expect(screen.queryByText("tab-general")).toBeNull();
  });

  it("预置的 tab 是一次性的：消费掉之后再次打开回到「通用」", async () => {
    useSettingsModalStore.getState().openWithTab("about");
    const view = render(<SettingsModal open onOpenChange={() => {}} />);
    await screen.findByText("tab-about");
    expect(useSettingsModalStore.getState().initialTab).toBeNull();

    view.rerender(<SettingsModal open={false} onOpenChange={() => {}} />);
    view.rerender(<SettingsModal open onOpenChange={() => {}} />);

    expect(await screen.findByText("tab-general")).toBeTruthy();
  });

  it("弹窗已经开着时再请求切页，也会切过去（点提示前用户可能正开着设置）", async () => {
    const view = render(<SettingsModal open onOpenChange={() => {}} />);
    await screen.findByText("tab-general");

    // 模拟 toast 的 onPress：open 已经是 true，只有 initialTab 变化
    useSettingsModalStore.getState().openWithTab("about");
    view.rerender(<SettingsModal open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText("tab-about")).toBeTruthy());
  });

  it("关闭时顺手收掉更新详情弹窗（否则下次进关于页会自己弹出来）", async () => {
    useUpdateCheckStore.getState().setDetailOpen(true);
    const view = render(<SettingsModal open onOpenChange={() => {}} />);

    view.rerender(<SettingsModal open={false} onOpenChange={() => {}} />);

    await waitFor(() => expect(useUpdateCheckStore.getState().detailOpen).toBe(false));
  });

  it("点侧栏切页仍然有效（预置逻辑不能盖掉手动切换）", async () => {
    render(<SettingsModal open onOpenChange={() => {}} />);
    await screen.findByText("tab-general");

    const aboutTab = screen.getAllByText("settings.about")[0];
    expect(aboutTab).toBeTruthy();
    if (aboutTab) fireEvent.click(aboutTab);

    await waitFor(() => expect(screen.getByText("tab-about")).toBeTruthy());
  });
});
