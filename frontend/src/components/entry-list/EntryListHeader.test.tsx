import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryListHeader } from "./EntryListHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/useScrollToTop", () => ({
  dispatchScrollToTop: vi.fn(),
}));

/** 56-15：工具栏插槽要 react-query Provider；本文件不关心插件，按「无贡献」打桩 */
vi.mock("@/plugins/useContributions", () => ({
  useContributions: () => [],
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

function refreshButton() {
  return screen.getByTitle("entry.refresh_view");
}

describe("EntryListHeader 刷新按钮", () => {
  it("非刷新态：普通刷新图标，没有进度数字", () => {
    render(<EntryListHeader {...baseProps} onRefresh={vi.fn()} />);

    const button = refreshButton();
    expect(button.querySelector(".animate-spin")).toBeNull();
    expect(button.textContent).toBe("");
  });

  it("刷新中：图标持续转圈，圈内显示「还剩几个源」", () => {
    render(
      <EntryListHeader
        {...baseProps}
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={23}
        refreshCompleted={8}
      />,
    );

    const button = refreshButton();
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("15");
  });

  it("刷新中：每完成一个源，圈内数字减一", () => {
    const { rerender } = render(
      <EntryListHeader
        {...baseProps}
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={3}
        refreshCompleted={0}
      />,
    );
    expect(refreshButton().textContent).toBe("3");

    rerender(
      <EntryListHeader
        {...baseProps}
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={3}
        refreshCompleted={1}
      />,
    );
    expect(refreshButton().textContent).toBe("2");

    rerender(
      <EntryListHeader
        {...baseProps}
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={3}
        refreshCompleted={3}
      />,
    );
    expect(refreshButton().textContent).toBe("0");
  });

  it("刷新中：进度取不到（total 为 0）时不显示负数", () => {
    render(
      <EntryListHeader
        {...baseProps}
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={0}
        refreshCompleted={5}
      />,
    );
    expect(refreshButton().textContent).toBe("0");
  });

  it("点击刷新按钮会触发 onRefresh", () => {
    const onRefresh = vi.fn();
    render(<EntryListHeader {...baseProps} onRefresh={onRefresh} />);

    fireEvent.click(refreshButton());
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("不传 onRefresh 时不渲染刷新按钮", () => {
    render(<EntryListHeader {...baseProps} />);
    expect(screen.queryByTitle("entry.refresh_view")).toBeNull();
  });
});

describe("EntryListHeader 标题行", () => {
  it("默认显示标题与未读计数", () => {
    render(<EntryListHeader {...baseProps} />);

    expect(screen.getByText("全部文章")).toBeTruthy();
    expect(screen.getByText("entry.unread_count")).toBeTruthy();
  });

  it("给了 subtitle 时用它替换未读计数（「已静音」回看视图用）", () => {
    render(
      <EntryListHeader
        {...baseProps}
        title="已静音"
        subtitle="被规则静音 · 仍可阅读与取消"
      />,
    );

    expect(screen.getByText("已静音")).toBeTruthy();
    expect(screen.getByText("被规则静音 · 仍可阅读与取消")).toBeTruthy();
    expect(screen.queryByText("entry.unread_count")).toBeNull();
  });
});

describe("EntryListHeader 星标视图去掉已读/未读切换（58-1）", () => {
  it("默认视图仍然显示「只看未读 / 全部」切换", () => {
    render(<EntryListHeader {...baseProps} />);
    expect(screen.getByTitle("entry.show_unread_only")).toBeTruthy();
  });

  it("showUnreadToggle=false（星标视图）时这颗按钮整颗不渲染，刷新/全读不受影响", () => {
    render(<EntryListHeader {...baseProps} showUnreadToggle={false} />);

    expect(screen.queryByTitle("entry.show_unread_only")).toBeNull();
    expect(screen.queryByTitle("entry.show_all")).toBeNull();
    expect(screen.getByTitle("entry.mark_all_read")).toBeTruthy();
  });
});

describe("EntryListHeader 移动端顶栏与 Web 图标统一", () => {
  /** 项目自定义 RefreshIcon 的首段 path，用来和 lucide 的 RefreshCw 区分 */
  const REFRESH_ICON_PATH = "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8";
  /** 项目自定义 CheckCircleIcon 的首段 path，用来和 lucide 的 CheckCheck 区分 */
  const CHECK_CIRCLE_ICON_PATH = "M22 11.08V12a10 10 0 1 1-5.93-9.14";

  function mobileButton(label: string) {
    return screen.getByLabelText(label);
  }

  it("刷新/全部已读改用 Web 同款图标（统一 18px），按钮盒仍是 44px", () => {
    render(<EntryListHeader {...baseProps} isMobile onRefresh={vi.fn()} />);

    const refresh = mobileButton("entry.refresh_view");
    expect(refresh.className).toContain("size-11");
    const refreshSvg = refresh.querySelector("svg");
    expect(refreshSvg?.getAttribute("class")).toBe("size-[18px]");
    expect(refreshSvg?.querySelector("path")?.getAttribute("d")).toBe(
      REFRESH_ICON_PATH,
    );

    const markAllRead = mobileButton("entry.mark_all_read");
    expect(markAllRead.className).toContain("size-11");
    const checkSvg = markAllRead.querySelector("svg");
    expect(checkSvg?.getAttribute("class")).toBe("size-[18px]");
    expect(checkSvg?.querySelector("path")?.getAttribute("d")).toBe(
      CHECK_CIRCLE_ICON_PATH,
    );
  });

  it("未读切换沿用 Web 的实心/描边圆点（统一 18px），按钮盒仍是 44px", () => {
    const { rerender } = render(
      <EntryListHeader {...baseProps} isMobile unreadOnly={false} />,
    );

    const outlineButton = mobileButton("entry.show_unread_only");
    expect(outlineButton.className).toContain("size-11");
    expect(outlineButton.querySelector("circle")).toBeTruthy();
    expect(outlineButton.querySelector("svg")?.getAttribute("class")).toBe(
      "size-[18px]",
    );

    rerender(<EntryListHeader {...baseProps} isMobile unreadOnly />);
    const filledButton = mobileButton("entry.show_all");
    expect(filledButton.className).toContain("size-11");
    expect(filledButton.querySelector("path")).toBeNull();
    expect(filledButton.querySelector("circle")).toBeTruthy();
    expect(filledButton.querySelector("svg")?.getAttribute("class")).toBe(
      "size-[18px]",
    );
  });

  it("顶栏四颗动作图标（刷新/未读切换/全部已读/更多）共用同一个 18px 字号类", () => {
    render(<EntryListHeader {...baseProps} isMobile onRefresh={vi.fn()} />);

    const labels = [
      "entry.refresh_view",
      "entry.show_unread_only",
      "entry.mark_all_read",
      "actions.more",
    ];
    for (const label of labels) {
      const svg = mobileButton(label).querySelector("svg");
      expect(svg?.getAttribute("class")).toContain("size-[18px]");
    }
  });

  it("刷新中仍显示 RefreshSpinner（保留进度数字，不改尺寸）", () => {
    render(
      <EntryListHeader
        {...baseProps}
        isMobile
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={9}
        refreshCompleted={4}
      />,
    );

    const refresh = mobileButton("entry.refreshing");
    expect(refresh.querySelector(".animate-spin")).not.toBeNull();
    expect(refresh.textContent).toBe("5");
  });

  it("「更多」面板不再出现刷新/只看未读/全部已读，保留其余动作", () => {
    const onSearchClick = vi.fn();
    const onForceRefresh = vi.fn();
    const onToggleStarredViewOnly = vi.fn();
    const onToggleArticleLayout = vi.fn();

    render(
      <EntryListHeader
        {...baseProps}
        isMobile
        onRefresh={vi.fn()}
        onForceRefresh={onForceRefresh}
        onSearchClick={onSearchClick}
        onToggleStarredViewOnly={onToggleStarredViewOnly}
        articleLayout="list"
        onToggleArticleLayout={onToggleArticleLayout}
      />,
    );

    fireEvent.click(mobileButton("actions.more"));
    const panel = screen.getByRole("dialog");

    /* 已移到顶栏的三项，面板里不能再有 */
    expect(within(panel).queryByText("entry.refresh_view")).toBeNull();
    expect(within(panel).queryByText("entry.show_unread_only")).toBeNull();
    expect(within(panel).queryByText("entry.show_all")).toBeNull();
    expect(within(panel).queryByText("entry.mark_all_read")).toBeNull();

    /* 面板保留的动作 */
    expect(within(panel).getByText("search.title")).toBeTruthy();
    const forceRefresh = within(panel).getByText("entry.force_refresh");
    expect(forceRefresh).toBeTruthy();
    expect(within(panel).getByText("sidebar.starred_view")).toBeTruthy();
    expect(
      within(panel).getByText("appearance_view.article_layout_hover"),
    ).toBeTruthy();

    /* 强制刷新与 Web 右键菜单同一颗 RefreshIcon；面板内图标统一 20px(size-5) */
    const forceRefreshRow = forceRefresh.closest("button");
    const forceRefreshSvg = forceRefreshRow?.querySelector("svg");
    expect(forceRefreshSvg?.getAttribute("class")).toBe("size-5");
    expect(forceRefreshSvg?.querySelector("path")?.getAttribute("d")).toBe(
      REFRESH_ICON_PATH,
    );

    fireEvent.click(forceRefreshRow as HTMLElement);
    expect(onForceRefresh).toHaveBeenCalledTimes(1);
  });
});
