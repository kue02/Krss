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
 * 56-16：受控 patch 落到条目右键菜单上 —— 「标为已读 / 标为未读」是宿主登记为
 * **可隐藏**的控件（`PLUGIN_TARGETS["entry.mark_read"].hideable`），插件 `op:"hide"`
 * 就能把它从菜单里去掉；没登记的 target 写了也不生效。
 */
const { contributions } = vi.hoisted(() => ({
  contributions: { current: [] as PluginContribution[] },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/plugins/useContributions", () => ({
  useContributions: () => contributions.current,
}));

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

function contribution(
  overrides: Partial<PluginContribution> = {},
): PluginContribution {
  return {
    plugin: "bark",
    pluginName: "Bark 推送",
    id: "hide-mark-read",
    surface: "entry.contextmenu",
    action: "notify",
    label: "推送到手机（Bark）",
    selection: "single",
    ...overrides,
  };
}

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

describe("条目右键菜单的受控 patch（56-16）", () => {
  it("① op:\"hide\" + entry.mark_read → 「标为已读」项消失，其余项照旧", () => {
    contributions.current = [
      contribution({ op: "hide", target: "entry.mark_read" }),
    ];
    renderMenu();

    expect(screen.queryByText("entry.mark_read")).toBeNull();
    expect(screen.getByText("automation.exception_entry")).toBeTruthy();
    expect(screen.getByText("automation.rule_from_entry")).toBeTruthy();
    // hide 项本身不该变成菜单里的一项（它没有 label 可言）
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("② op:\"hide\" 指向未登记的目标 → 什么都没被藏（菜单项数不变）", () => {
    contributions.current = [
      contribution({ op: "hide", target: "entry.not_a_real_control" }),
    ];
    renderMenu();

    expect(screen.getByText("entry.mark_read")).toBeTruthy();
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });

  it("③ 没有 hide 贡献 → 「标为已读」照旧在（默认行为不变）", () => {
    contributions.current = [];
    renderMenu();

    expect(screen.getByText("entry.mark_read")).toBeTruthy();
  });
});
