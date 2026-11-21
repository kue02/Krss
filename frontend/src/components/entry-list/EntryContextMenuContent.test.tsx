import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { EntryContextMenuContent } from "./EntryListItem";
import type { PluginContribution } from "@/plugins/types";
import type { Entry } from "@/types/api";

/**
 * 56-11：条目右键菜单接入插件插槽（`surface="entry.contextmenu"`）。
 *
 * 插槽**只插在 `EntryContextMenuContent` 这一处**：条目卡片（列表档 / 社交档两套渲染都在
 * 同一个组件里）与通知视图的时间线卡片（`NotificationTimeline` 直接复用这个导出）因此一起生效，
 * 不许在别处再插一份。
 *
 * 菜单内容靠 Radix 的 `ContextMenu` 上下文才渲染得出来，所以照 `PluginSlot.test.tsx` 的写法：
 * 自己搭一个 `ContextMenu + ContextMenuTrigger`，右键触发打开菜单。
 */
const { contributions } = vi.hoisted(() => ({
  contributions: { current: [] as PluginContribution[] },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** 这个挂点上的插件贡献由本文件按用例给（真实 hook 要 react-query Provider，这里不关心） */
vi.mock("@/plugins/useContributions", () => ({
  useContributions: () => contributions.current,
}));

/** 只打桩「调用动作」那一层：本文件断言的是菜单项在不在，不点它 */
vi.mock("@/plugins/useInvokePluginAction", () => ({
  useInvokePluginAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useEntries", () => ({
  useMarkAsRead: () => ({ mutate: vi.fn() }),
  useMarkAsStarred: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/hooks/useFilters", () => ({
  useUnmuteEntry: () => ({ mutate: vi.fn() }),
  useCreateFilterException: () => ({ mutate: vi.fn(), isPending: false }),
  useFilters: () => ({ data: [], isLoading: false, isError: false }),
}));

const entry: Entry = {
  id: "entry-1",
  feedId: "feed-1",
  title: "Entry title",
  content: "<p>Entry summary</p>",
  read: false,
  starred: false,
  muted: false,
  publishedAt: "2024-01-01T09:00:00.000Z",
  createdAt: "2024-01-01T09:00:00.000Z",
  updatedAt: "2024-01-01T09:00:00.000Z",
};

function barkContribution(
  overrides: Partial<PluginContribution> = {},
): PluginContribution {
  return {
    plugin: "bark",
    pluginName: "Bark 推送",
    id: "push-entry",
    surface: "entry.contextmenu",
    action: "notify",
    label: "推送到手机（Bark）",
    selection: "single",
    ...overrides,
  };
}

/** 打开条目右键菜单（内容由 `EntryContextMenuContent` 自己渲染） */
function renderMenu() {
  render(
    <ContextMenu>
      <ContextMenuTrigger>
        <span>trigger</span>
      </ContextMenuTrigger>
      <EntryContextMenuContent entry={entry} />
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("trigger"));
}

afterEach(() => {
  cleanup();
  contributions.current = [];
});

describe("EntryContextMenuContent 的插件插槽（56-11）", () => {
  it("① 挂点上有贡献 → 菜单里多出那一项（单条选中，selection:\"single\" 生效）", () => {
    contributions.current = [barkContribution()];
    renderMenu();

    // 插件项按插件给的 label 原样显示（宿主不翻译）
    expect(screen.getByText("推送到手机（Bark）")).toBeTruthy();
    // 条目自有的三项照旧（标为已读 / 豁免这类内容 / 按此条新建规则），再加插件那一项
    expect(screen.getByText("automation.exception_entry")).toBeTruthy();
    expect(screen.getByText("automation.rule_from_entry")).toBeTruthy();
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });

  it("② 挂点上没有贡献 → 菜单照常渲染，一个多余项都不加（不崩）", () => {
    contributions.current = [];
    renderMenu();

    // 条目自己的三项都在
    expect(screen.getByText("automation.exception_entry")).toBeTruthy();
    expect(screen.getByText("automation.rule_from_entry")).toBeTruthy();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(screen.queryByText("推送到手机（Bark）")).toBeNull();
  });
});
