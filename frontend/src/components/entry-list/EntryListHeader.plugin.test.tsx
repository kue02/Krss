import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryListHeader } from "./EntryListHeader";
import type { PluginContribution } from "@/plugins/types";

/**
 * 56-15：列表顶部工具栏接插件插槽（`surface="entry.list.toolbar"`）。
 *
 * 工具栏里没有「已选条目」这个概念（列表的选中在 `EntryList` 里，单条由详情栏承接），
 * 所以选中态由调用方按现有 `selectedEntryId` 传进来，默认空数组 —— `selection:"multi"`
 * 的项因此不渲染（那是「对选中的若干条做事」，工具栏没有选中就没有可做的事）。
 */
const { contributions } = vi.hoisted(() => ({
  contributions: { current: [] as PluginContribution[] },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useScrollToTop", () => ({
  dispatchScrollToTop: vi.fn(),
}));

vi.mock("@/plugins/useContributions", () => ({
  useContributions: () => contributions.current,
}));

vi.mock("@/plugins/useInvokePluginAction", () => ({
  useInvokePluginAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

const baseProps = {
  title: "全部文章",
  unreadCount: 12,
  unreadOnly: false,
  onToggleUnreadOnly: vi.fn(),
  onMarkAllRead: vi.fn(),
};

function toolbarContribution(
  overrides: Partial<PluginContribution> = {},
): PluginContribution {
  return {
    plugin: "bark",
    pluginName: "Bark 推送",
    id: "push-all",
    surface: "entry.list.toolbar",
    action: "notify",
    label: "推送未读（Bark）",
    selection: "none",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  contributions.current = [];
});

describe("EntryListHeader 的插件插槽（56-15）", () => {
  it("① 挂点上有贡献 → 工具栏多出一个按钮，文案原样（不翻译）", () => {
    contributions.current = [toolbarContribution()];
    render(<EntryListHeader {...baseProps} />);

    expect(screen.getByText("推送未读（Bark）")).toBeTruthy();
    // 宿主既有按钮不受影响
    expect(screen.getByTitle("entry.mark_all_read")).toBeTruthy();
  });

  it("② 挂点上没有贡献 → 不渲染、不崩（工具栏照旧）", () => {
    contributions.current = [];
    const { container } = render(<EntryListHeader {...baseProps} />);

    expect(screen.queryByText("推送未读（Bark）")).toBeNull();
    expect(screen.getByTitle("entry.mark_all_read")).toBeTruthy();
    expect(container.textContent).toContain("全部文章");
  });
});
