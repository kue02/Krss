import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { QueryClientProvider } from "@tanstack/react-query";
import { FeedContextMenuItems } from "./FeedContextMenuItems";
import { queryClient } from "@/lib/queryClient";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import type { Feed } from "@/types/api";
import type { PluginContribution } from "@/plugins/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/**
 * 56-13：订阅右键接插件插槽。这里只打桩「某个挂点上有哪些贡献」这一层，
 * 插槽本身走真实实现（菜单项形态、文案、无贡献不占位都由它决定）。
 */
const { pluginContributions } = vi.hoisted(() => ({
  pluginContributions: { current: [] as PluginContribution[] },
}));

vi.mock("@/plugins/useContributions", () => ({
  useContributions: (surface: string) =>
    pluginContributions.current.filter((item) => item.surface === surface),
}));

const feed: Feed = {
  id: "feed-1",
  title: "Example Feed",
  url: "https://example.com/feed.xml",
  siteUrl: "https://example.com",
  type: "article",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function renderMenu(feedOverride: Feed = feed) {
  // 插槽里要调插件动作（useInvokePluginAction → useQueryClient），线上有 Provider，
  // 这里补上同一个 queryClient 单例，测试走的仍是线上结构
  return render(
    <QueryClientProvider client={queryClient}>
      <ContextMenu>
        <ContextMenuTrigger>
          <span>trigger</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <FeedContextMenuItems
            feed={feedOverride}
            folders={[]}
            label={feedOverride.title}
            onRefresh={vi.fn()}
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onMoveToFolder={vi.fn()}
            onChangeType={vi.fn()}
          />
        </ContextMenuContent>
      </ContextMenu>
    </QueryClientProvider>,
  );
}

describe("FeedContextMenuItems（卡 B：第一栏与第二栏共用的订阅组）", () => {
  afterEach(() => {
    cleanup();
    useFilterEditorStore.getState().close();
    queryClient.clear();
    pluginContributions.current = [];
  });

  it("渲染第一栏原有的全部订阅项（顺序与文案一字不动）", () => {
    queryClient.setQueryData(["feeds"], [feed]);
    renderMenu();

    fireEvent.contextMenu(screen.getByText("trigger"));

    // 标题行 + 第一栏 rowMenu 原有的每一项（按 i18n key 断言）
    expect(screen.getByText(feed.title)).toBeTruthy();
    expect(screen.getByText("actions.refresh")).toBeTruthy();
    expect(screen.getByText("actions.edit")).toBeTruthy();
    expect(screen.getByText("actions.copy_feed_url")).toBeTruthy();
    expect(screen.getByText("actions.open_site")).toBeTruthy();
    expect(screen.getByText("actions.copy_site_url")).toBeTruthy();
    expect(screen.getByText("automation.rule_from_feed")).toBeTruthy();
    expect(screen.getByText("actions.delete")).toBeTruthy();

    // 顺序与原来第一栏一致：刷新 → 编辑 → 复制地址 → 主站 → 新建规则 → 删除（最后）
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    const order = [
      "actions.refresh",
      "actions.edit",
      "actions.copy_feed_url",
      "actions.open_site",
      "actions.copy_site_url",
      "automation.rule_from_feed",
      "actions.delete",
    ];
    // 「移动到文件夹 / 更改类型」是子菜单触发器（role 不同），只断直接项的相对顺序
    let lastIndex = -1;
    for (const key of order) {
      const index = items.findIndex((text) => text?.includes(key));
      expect(index, key).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("siteUrl 拿不到时「前往主站 / 复制主站地址」隐藏", () => {
    queryClient.setQueryData(["feeds"], [feed]);
    // siteUrl 为空 + 纯 feed 文件地址反解不出主站（见 lib/feed-site）
    renderMenu({ ...feed, siteUrl: undefined });

    fireEvent.contextMenu(screen.getByText("trigger"));

    expect(screen.queryByText("actions.open_site")).toBeNull();
    expect(screen.queryByText("actions.copy_site_url")).toBeNull();
    // 其余项不受影响
    expect(screen.getByText("actions.refresh")).toBeTruthy();
  });

  it("删除是破坏性项：text-destructive、独立分组、压在最后", () => {
    queryClient.setQueryData(["feeds"], [feed]);
    renderMenu();

    fireEvent.contextMenu(screen.getByText("trigger"));

    const deleteItem = screen.getByText("actions.delete");
    expect(deleteItem.className).toContain("text-destructive");
    // 同一菜单里排在「为此订阅新建规则」之后（最后）
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items[items.length - 1]).toContain("actions.delete");
    expect(items.indexOf("automation.rule_from_feed")).toBeLessThan(
      items.indexOf("actions.delete"),
    );
  });

  it("「为此订阅新建规则」按该订阅打开规则编辑器", () => {
    queryClient.setQueryData(["feeds"], [feed]);
    renderMenu();

    fireEvent.contextMenu(screen.getByText("trigger"));
    fireEvent.click(screen.getByText("automation.rule_from_feed"));

    const state = useFilterEditorStore.getState();
    expect(state.open).toBe(true);
    expect(state.draft?.scopeType).toBe("feed");
    expect(state.draft?.scopeId).toBe(feed.id);
  });

  it("56-13：这个挂点有插件贡献 → 菜单末尾多出插件项", () => {
    queryClient.setQueryData(["feeds"], [feed]);
    pluginContributions.current = [
      {
        plugin: "bark",
        pluginName: "Bark 推送",
        id: "notify",
        surface: "feed.contextmenu",
        action: "notify",
        label: "推送到手机（Bark）",
        icon: "bell",
        selection: "none",
      },
    ];
    renderMenu();

    fireEvent.contextMenu(screen.getByText("trigger"));

    expect(screen.getByText("推送到手机（Bark）")).toBeTruthy();
    // 宿主原有 9 项（7 个直接项 + 2 个子菜单触发器）一个不少，插件项排在菜单内容末尾
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toHaveLength(10);
    expect(items[items.length - 1]).toContain("推送到手机（Bark）");
  });

  it("56-13：这个挂点没有插件贡献 → 不崩、也不多出任何项", () => {
    queryClient.setQueryData(["feeds"], [feed]);
    pluginContributions.current = [];
    renderMenu();

    fireEvent.contextMenu(screen.getByText("trigger"));

    expect(screen.queryByText("推送到手机（Bark）")).toBeNull();
    // 仍是原来那 9 项（插槽没有贡献时不占位）
    expect(screen.getAllByRole("menuitem")).toHaveLength(9);
  });

  it("第一栏与第二栏渲染同一组件（源码断言，防照抄第二份）", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sidebarItem = readFileSync(
      resolve(here, "..", "sidebar", "FeedItem.tsx"),
      "utf-8",
    );
    const entryItem = readFileSync(
      resolve(here, "..", "entry-list", "EntryListItem.tsx"),
      "utf-8",
    );
    // 两处都 import 同一路径
    expect(sidebarItem).toContain(
      "@/components/feed/FeedContextMenuItems",
    );
    expect(entryItem).toContain("@/components/feed/FeedContextMenuItems");
    // 两处都实际渲染它（不是只 import 不用）
    expect(sidebarItem).toContain("<FeedContextMenuItems");
    expect(entryItem).toContain("<FeedContextMenuItems");
    // 第一栏不再有自己的菜单项实现（搬空了）
    expect(sidebarItem).not.toContain("actions.move_to_folder");
    expect(sidebarItem).not.toContain("handleNewRuleFromFeed");
  });
});
