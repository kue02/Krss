import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { FeedCategory } from "./FeedCategory";

// 只测「三角/名称=展开」「行内空白=选中」这条交互，重依赖一律替换为轻量替身
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useContextMenu", () => ({
  useContextMenu: () => ({}),
}));

vi.mock("./sidebar-dnd", () => ({
  useSidebarDndOptional: () => undefined,
}));

vi.mock("m3-ripple", () => ({
  Ripple: () => null,
}));

vi.mock("@/stores/filter-editor-store", () => ({
  openFilterEditorForFolder: vi.fn(),
}));

// 用真实 setState 复刻 useCategoryState 的展开开关（跳过 localStorage / 服务端同步）
vi.mock("@/hooks/useCategoryState", async () => {
  const React = await import("react");
  return {
    useCategoryState: (_key: string, defaultOpen = false) => {
      const [open, setOpen] = React.useState(defaultOpen);
      return [open, setOpen, () => setOpen((o: boolean) => !o)] as const;
    },
  };
});

// context-menu 只做包裹，避免在 jsdom 里拉起 Radix 的 portal / 菜单内容
vi.mock("@/components/ui/context-menu", () => {
  const Fragment = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    ContextMenu: Fragment,
    ContextMenuTrigger: Fragment,
    ContextMenuContent: Fragment,
    ContextMenuSub: Fragment,
    ContextMenuSubContent: Fragment,
    ContextMenuItem: Fragment,
    ContextMenuLabel: Fragment,
    ContextMenuSubTrigger: Fragment,
    ContextMenuSeparator: () => null,
  };
});

function renderCategory(
  opts: { onSelect?: () => void; name?: string; defaultOpen?: boolean } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onSelect = opts.onSelect ?? vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(
    <FeedCategory
      name={opts.name ?? "周刊"}
      folderId="folder-1"
      unreadCount={35}
      defaultOpen={opts.defaultOpen}
      onSelect={onSelect}
    >
      <div data-testid="folder-child">child</div>
    </FeedCategory>,
    { wrapper },
  );
  return { onSelect };
}

afterEach(() => {
  cleanup();
});

describe("FeedCategory", () => {
  it("每行只有 1 个 button（toggle 开关），点击它展开下拉", async () => {
    renderCategory();

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByTestId("folder-child")).toBeNull();

    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByTestId("folder-child")).toBeTruthy();
  });

  it("点名称/三角只展开下拉，不触发 onSelect（不切换选中）", async () => {
    const { onSelect } = renderCategory();

    // 名称与三角同在 toggle button 内：点名称 = 点开关 → 只展开、不选中
    const toggleBtn = screen.getByRole("button");
    fireEvent.click(within(toggleBtn).getByText("周刊"));

    expect(onSelect).not.toHaveBeenCalled();
    expect(await screen.findByTestId("folder-child")).toBeTruthy();
  });

  it("点行内空白处（外层行）切换选中，触发 onSelect 且不展开", () => {
    const { onSelect } = renderCategory();

    // toggle button 的父节点就是整行；点它 = 点行内空白 → 选中文件夹
    const row = screen.getByRole("button").parentElement as HTMLElement;
    fireEvent.click(row);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("folder-child")).toBeNull();
  });
});
