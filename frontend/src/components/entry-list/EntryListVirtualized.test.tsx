/**
 * 标准文章列表虚拟化回归测试（perf 分支）。
 *
 * 覆盖语义：
 * 1. 50 条时首屏挂载的卡数 <= 15（可视区 600px / 估计行高 148px ≈ 4 行 + overscan 8*2 上限）。
 * 2. 滚动到底能加载出后面的卡（range 跟着 scrollTop 走）。
 * 3. 虚拟化作用于标准文章列表 + 社交列表（桌面 / 移动端同一份 EntryListItem）；
 *    通知时间线（吸附分组 + sticky 日期头）与 hover 浮层档走原路径。
 *
 * 手法：jsdom 里 offsetWidth/offsetHeight 全 0，虚拟库拿不到容器尺寸。
 * 这里给 viewport 打桩（offsetHeight/clientHeight/scrollTop 可写），让 range 真实算出来。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import type { Entry } from "@/types/api";
import { useFilterViewStore } from "@/stores/filter-view-store";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useFeedMenuActions", () => ({
  useFeedMenuActions: () => ({
    folders: [],
    onRefresh: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onMoveToFolder: vi.fn(),
    onChangeType: vi.fn(),
  }),
}));

vi.mock("@/hooks/useFilters", () => ({
  useUnmuteEntry: () => ({ mutate: vi.fn() }),
  useCreateFilterException: () => ({ mutate: vi.fn(), isPending: false }),
  useFilters: () => ({ data: [], isLoading: false, isError: false }),
}));

vi.mock("@/plugins/useContributions", () => ({
  useContributions: () => [],
}));

vi.mock("@/plugins/useInvokePluginAction", () => ({
  useInvokePluginAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useEntries", () => ({
  useEntriesInfinite: vi.fn(),
  useUnreadCounts: vi.fn(() => ({ data: undefined })),
  useMarkManyAsRead: vi.fn(() => ({ mutate: vi.fn() })),
  useRemoveFromUnreadList: vi.fn(() => vi.fn()),
  useRemoveReadEntriesFromUnreadList: vi.fn(() => vi.fn()),
  useMarkAsRead: vi.fn(() => ({ mutate: vi.fn() })),
  useMarkAsStarred: vi.fn(() => ({ mutate: vi.fn() })),
}));

vi.mock("@/hooks/useRefreshStatus", () => ({
  useRefreshStatus: () => undefined,
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/hooks/useFolders", () => ({
  useFolders: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/hooks/useAISettings", () => ({
  useAISettings: vi.fn(),
}));

vi.mock("@/hooks/useGeneralSettings", () => ({
  useGeneralSettings: vi.fn(() => ({ data: { markReadOnScroll: false } })),
}));

vi.mock("@/hooks/useSelection", () => ({
  selectionToParams: vi.fn(() => ({})),
}));

vi.mock("@/lib/html-utils", () => ({
  stripHtml: (html: string) => html,
}));

vi.mock("@/lib/language-detect-async", () => ({
  needsTranslation: vi.fn(() => Promise.resolve(false)),
  // 54-10：列表标题/摘要走逐字段判定
  needsListTranslation: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/services/translation-service", () => ({
  translateArticlesBatch: vi.fn(() => Promise.resolve()),
  cancelAllBatchTranslations: vi.fn(),
}));

vi.mock("@/stores/translation-store", () => ({
  translationActions: { get: vi.fn(() => undefined), isDisabled: () => false },
}));

vi.mock("./EntryListItem", async () => {
  const React = await import("react");

  return {
    // 高度 148px：与 VIRTUAL_ARTICLE_ESTIMATE_PX 对齐，避免估计/实测差引发补偿滚动
    EntryListItem: React.forwardRef<
      HTMLDivElement,
      { entry: Entry; "data-index"?: number; "data-entry-id"?: string }
    >(function MockEntryListItem(
      { "data-index": dataIndex, "data-entry-id": dataEntryId },
      ref,
    ) {
      return (
        <div
          ref={ref}
          data-index={dataIndex}
          data-entry-id={dataEntryId}
          style={{ height: 148 }}
        />
      );
    }),
    // 行内右键菜单内容（本文件不测菜单，只要存在即可；避免拉入真实 hook 依赖）
    EntryContextMenuContent: () => null,
  };
});

vi.mock("./EntryListHeader", () => ({
  EntryListHeader: () => null,
}));

vi.mock("./NotificationTimeline", () => ({
  NotificationTimeline: () => <div data-testid="notification-timeline" />,
}));
vi.mock("./NotificationCards", () => ({
  NotificationCards: () => <div data-testid="notification-timeline" />,
}));

// hover 档的浮块本体在这里只关心「有没有走到虚拟分支」，本体 mock 掉
vi.mock("./NotificationBodyPreview", () => ({
  NotificationBodyPreview: () => null,
}));

import { EntryList } from "./EntryList";
import { setUISetting } from "@/hooks/useUISettings";
import { entryListScrollPositions } from "./scroll-key";
import { useEntriesInfinite } from "@/hooks/useEntries";
import { useAISettings } from "@/hooks/useAISettings";

function makeEntry(id: string): Entry {
  return {
    id,
    feedId: "feed-1",
    title: `Title ${id}`,
    content: `<p>Content for entry ${id}</p>`,
    read: false,
    starred: false,
    muted: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

const manyEntries = Array.from({ length: 50 }, (_, i) =>
  makeEntry(`e-${i + 1}`),
);

const defaultProps = {
  selection: { type: "all" as const },
  selectedEntryId: null as string | null,
  onSelectEntry: vi.fn(),
  onMarkAllRead: vi.fn(),
  unreadOnly: false,
  onToggleUnreadOnly: vi.fn(),
  contentType: "article" as const,
};

const VIEWPORT_HEIGHT = 600;
const ROW_HEIGHT = 148;

/**
 * jsdom 里 offsetWidth/offsetHeight 全 0，虚拟库 mount 时读到的容器尺寸就是 0
 * （→ range 为空 → 全量回退）。这里在 render **之前**给原型打桩，让 mount 当时
 * 就读到真实尺寸：视口 400x600，行高 148（与 VIRTUAL_ARTICLE_ESTIMATE_PX 对齐，
 * 估计/实测一致，无补偿滚动）。
 */
let savedOffsetWidth: PropertyDescriptor | undefined;
let savedOffsetHeight: PropertyDescriptor | undefined;

function installLayoutStubs() {
  savedOffsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
  );
  savedOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {
      configurable: true,
      get() {
        return this instanceof HTMLElement &&
          this.dataset.testid === "entry-list-viewport"
          ? 400
          : 300;
      },
    },
    offsetHeight: {
      configurable: true,
      get() {
        return this instanceof HTMLElement &&
          this.dataset.testid === "entry-list-viewport"
          ? VIEWPORT_HEIGHT
          : ROW_HEIGHT;
      },
    },
  });
}

function restoreLayoutStubs() {
  if (savedOffsetWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetWidth",
      savedOffsetWidth,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  }
  if (savedOffsetHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      savedOffsetHeight,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  }
}

function stubViewportScroll(viewport: HTMLElement) {
  // clientHeight 读实例属性（offset 观察只读 scrollTop，这里把滚动位置做成可写）
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: VIEWPORT_HEIGHT },
    scrollHeight: { configurable: true, value: manyEntries.length * ROW_HEIGHT },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
}

function rowIds(): string[] {
  const viewport = screen.getByTestId("entry-list-viewport");
  return Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-entry-id]"),
  ).map((row) => row.dataset.entryId ?? "");
}

describe("EntryList · 标准文章列表虚拟化", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    entryListScrollPositions.clear();
    useFilterViewStore.getState().setMutedOnly(false);
    setUISetting("articleLayout", "list");
    setUISetting("articlePaneFrame", "subtle");
    installLayoutStubs();
    vi.mocked(useEntriesInfinite).mockReturnValue({
      data: { pages: [{ entries: manyEntries, hasMore: false }] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(useAISettings).mockReturnValue({
      data: { autoTranslate: false, summaryLanguage: "zh-CN" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  afterEach(() => {
    cleanup();
    restoreLayoutStubs();
    setUISetting("articleLayout", "list");
    setUISetting("articlePushDirection", "right");
  });

  it("50 条时首屏只挂载可视区 + overscan（<=15 张），不再 50 卡全挂 DOM", async () => {
    render(<EntryList {...defaultProps} />);
    const viewport = screen.getByTestId("entry-list-viewport");
    await act(async () => {
      stubViewportScroll(viewport);
      await Promise.resolve();
    });

    const ids = rowIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(15);
    // 首屏从第一条开始
    expect(ids[0]).toBe("e-1");
  });

  it("滚动到底部能加载出后面的卡（range 跟着 scrollTop 走）", async () => {
    render(<EntryList {...defaultProps} />);
    const viewport = screen.getByTestId("entry-list-viewport");
    await act(async () => {
      stubViewportScroll(viewport);
      await Promise.resolve();
    });

    const firstScreen = rowIds();
    expect(firstScreen).not.toContain("e-50");

    await act(async () => {
      (viewport as HTMLElement & { scrollTop: number }).scrollTop =
        50 * 148 - VIEWPORT_HEIGHT;
      fireEvent.scroll(viewport);
      await Promise.resolve();
    });

    const lastScreen = rowIds();
    expect(lastScreen).toContain("e-50");
    expect(lastScreen).not.toContain("e-1");
  });

  it("桌面社交视图接入虚拟容器：首屏只挂可视 + overscan，远少于 50 条", async () => {
    render(<EntryList {...defaultProps} contentType="social" />);
    const viewport = screen.getByTestId("entry-list-viewport");
    await act(async () => {
      stubViewportScroll(viewport);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("notification-timeline")).toBeNull();
    // 桌面社交与移动端共用同一虚拟容器，不再 50 条全挂 DOM
    expect(
      viewport.querySelector('[data-virtual-list="true"]'),
    ).not.toBeNull();
    const ids = rowIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(manyEntries.length);
    // 首屏从第一条开始
    expect(ids[0]).toBe("e-1");
  });

  it("移动端社交列表接入虚拟容器：首屏只挂可视 + overscan，远少于 50 条", async () => {
    render(<EntryList {...defaultProps} contentType="social" isMobile />);
    const viewport = screen.getByTestId("entry-list-viewport");
    await act(async () => {
      stubViewportScroll(viewport);
      await Promise.resolve();
    });

    // 走虚拟列表（data-virtual-list），不再整份 50 条全挂 DOM
    expect(
      viewport.querySelector('[data-virtual-list="true"]'),
    ).not.toBeNull();
    const ids = rowIds();
    expect(ids.length).toBeGreaterThan(0);
    // 社交卡片按 600px 估计行高，视口高度有限 + overscan，远小于 50
    expect(ids.length).toBeLessThan(manyEntries.length);
    expect(ids.length).toBeLessThanOrEqual(24);
    expect(ids[0]).toBe("e-1");
  });

  it("通知视图走时间线（不走虚拟列表）", () => {
    render(<EntryList {...defaultProps} contentType="notification" />);

    expect(screen.getByTestId("notification-timeline")).not.toBeNull();
    expect(
      screen
        .getByTestId("entry-list-viewport")
        .querySelector('[data-virtual-list="true"]'),
    ).toBeNull();
  });

  it("文章「列表」档（rows）走虚拟列表，渲染 ArticleRowsListRow 且只挂可视区", async () => {
    setUISetting("articleLayout", "rows");
    render(<EntryList {...defaultProps} />);
    const viewport = screen.getByTestId("entry-list-viewport");
    await act(async () => {
      stubViewportScroll(viewport);
      await Promise.resolve();
    });

    // rows 分支挂载了 ArticleRowsList 容器 + 虚拟列表
    expect(screen.getByTestId("article-rows-list")).toBeTruthy();
    expect(
      viewport.querySelector('[data-virtual-list="true"]'),
    ).not.toBeNull();

    const ids = rowIds();
    expect(ids[0]).toBe("e-1");
    expect(ids.length).toBeLessThanOrEqual(15);
    // 行内是紧凑行（缩略图 + 标题），不是卡片
    expect(screen.getByText("Title e-1")).toBeTruthy();
  });

  it("文章「Inoreader列表」档（inoreader）走虚拟列表，行是来源图标+标题+右侧元信息", async () => {
    setUISetting("articleLayout", "inoreader");
    render(<EntryList {...defaultProps} />);
    const viewport = screen.getByTestId("entry-list-viewport");
    await act(async () => {
      stubViewportScroll(viewport);
      await Promise.resolve();
    });

    expect(screen.getByTestId("article-plain-list")).toBeTruthy();
    expect(
      viewport.querySelector('[data-virtual-list="true"]'),
    ).not.toBeNull();

    const ids = rowIds();
    expect(ids[0]).toBe("e-1");
    expect(ids.length).toBeLessThanOrEqual(15);
    // 没有缩略图（64×64 那档是实验「缩略图列表」）
    expect(viewport.querySelector(".size-16")).toBeNull();
  });

  it("「正文推入方向 = 向下」合列：正文接在被点那一行后面，选中后才出现", async () => {
    setUISetting("articleLayout", "inoreader");
    setUISetting("articlePushDirection", "down");
    const renderInlineContent = vi.fn(() => (
      <div data-testid="inline-body">正文</div>
    ));
    const { rerender } = render(
      <EntryList
        {...defaultProps}
        renderInlineContent={renderInlineContent}
      />,
    );
    const viewport = screen.getByTestId("entry-list-viewport");
    await act(async () => {
      stubViewportScroll(viewport);
      await Promise.resolve();
    });

    // 未选中：没有正文 pane，底部「全部标记为已读」照常在
    expect(screen.queryByTestId("inline-article-pane")).toBeNull();
    expect(screen.getByTestId("mark-all-read-footer")).toBeTruthy();
    // 桌面「向下」合列现在也走虚拟列表（pane 作为被点行的一部分渲染，行用 top 定位
    // 以免 transform 祖先破坏 pane 里 sticky 标题栏）。jsdom 测不到尺寸时按 12 行回退。
    expect(
      viewport.querySelector('[data-virtual-list="true"]'),
    ).not.toBeNull();
    expect(rowIds().length).toBeLessThan(manyEntries.length);

    rerender(
      <EntryList
        {...defaultProps}
        selectedEntryId="e-1"
        renderInlineContent={renderInlineContent}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // 选中后仍保持虚拟化：pane 渲染在被点行（e-1 在首屏窗口内）内部，后续条目照常
    // 由虚拟容器管理。sticky 靠行改用 top 定位保证（不靠关掉虚拟化）。
    expect(
      viewport.querySelector('[data-virtual-list="true"]'),
    ).not.toBeNull();
    expect(rowIds().length).toBeLessThan(manyEntries.length);

    expect(renderInlineContent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paneAtTop: false }),
    );
    const pane = screen.getByTestId("inline-article-pane");
    expect(pane.contains(screen.getByTestId("inline-body"))).toBe(true);
    // 正文接在被点的那一行后面：e-1 行在前、pane 在后，随后的 e-2 行还在 pane 之后
    const row1 = viewport.querySelector('[data-entry-id="e-1"]') as HTMLElement;
    expect(
      row1.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const row2 = viewport.querySelector('[data-entry-id="e-2"]') as HTMLElement;
    if (row2) {
      expect(
        pane.compareDocumentPosition(row2) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // 正文已内联在行间，不再夹在列表末尾与正文之间，底部按钮不再让位
    expect(screen.getByTestId("mark-all-read-footer")).toBeTruthy();
  });

  it("合列插正文把被点行推下去几千像素：自动对回原位（视口不会落到正文底部）", async () => {
    setUISetting("articleLayout", "inoreader");
    setUISetting("articlePushDirection", "down");
    const renderInlineContent = vi.fn(() => (
      <div data-testid="inline-body">正文</div>
    ));
    const { rerender } = render(
      <EntryList {...defaultProps} renderInlineContent={renderInlineContent} />,
    );
    const viewport = screen.getByTestId("entry-list-viewport");
    await act(async () => {
      stubViewportScroll(viewport);
      await Promise.resolve();
    });

    const row = viewport.querySelector('[data-entry-id="e-3"]') as HTMLElement;
    // 点击前：这一行在视口里的位置
    row.getBoundingClientRect = () =>
      ({ top: 120, bottom: 268, height: 148, left: 0, right: 400, width: 400 }) as DOMRect;
    fireEvent.click(row);

    // 正文 pane 插到它下面，把它整体推下去 3000px（实测 3462~11149px 那个量级）。
    // top 跟着 scrollTop 走，模拟真实滚动：补偿完第二次量到的是原位、不会再补。
    row.getBoundingClientRect = () => {
      const top = 3120 - viewport.scrollTop;
      return {
        top,
        bottom: top + 148,
        height: 148,
        left: 0,
        right: 400,
        width: 400,
      } as DOMRect;
    };
    rerender(
      <EntryList
        {...defaultProps}
        selectedEntryId="e-3"
        renderInlineContent={renderInlineContent}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // 补回 3000px：视口仍停在被点行上，而不是落到正文底部
    expect(viewport.scrollTop).toBe(3000);
  });

  it("手机档「向下」合列：正文同样接在被点行后面、与列表共用文档滚动", async () => {
    setUISetting("articleLayout", "inoreader");
    setUISetting("articlePushDirection", "down");
    const renderInlineContent = vi.fn(() => (
      <div data-testid="inline-body">正文</div>
    ));
    render(
      <EntryList
        {...defaultProps}
        isMobile
        selectedEntryId="e-1"
        renderInlineContent={renderInlineContent}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const viewport = screen.getByTestId("entry-list-viewport");
    // 手机档本来就是文档滚动、不虚拟化；合列时正文照样插在被点行后面
    expect(
      viewport.querySelector('[data-virtual-list="true"]'),
    ).toBeNull();
    expect(rowIds()).toHaveLength(50);
    expect(renderInlineContent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paneAtTop: false }),
    );
    const pane = screen.getByTestId("inline-article-pane");
    expect(pane.contains(screen.getByTestId("inline-body"))).toBe(true);
    const row1 = viewport.querySelector('[data-entry-id="e-1"]') as HTMLElement;
    expect(
      row1.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // 手机档同样把正文接在行间、不再让底部按钮让位
    expect(screen.getByTestId("mark-all-read-footer")).toBeTruthy();
  });

  it("合列正文贴顶铺满时裁剪圆角跟着边框走，滚回顶部会复位（2026-11-24 缺口）", async () => {
    setUISetting("articleLayout", "inoreader");
    setUISetting("articlePushDirection", "down");
    const renderInlineContent = vi.fn(() => (
      <div data-testid="inline-body">正文</div>
    ));
    render(
      <EntryList
        {...defaultProps}
        isMobile
        selectedEntryId="e-1"
        renderInlineContent={renderInlineContent}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    /* 手机档读 window.scrollY 判方向；选中后 300ms 内是程序化滚动抑制期，先等过去 */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    const scrollYDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "scrollY",
    );
    const setScrollY = (value: number) => {
      Object.defineProperty(window, "scrollY", {
        configurable: true,
        writable: true,
        value,
      });
    };

    const pane = screen.getByTestId("inline-article-pane");
    /* 卡片档用 overflow:clip 让裁剪边缘跟随 border-radius，不再用 clip-path
       （clip-path 圆角与 border-radius 过渡不同步会在角上裁掉一块，见用户 2026-11-24 报缺角） */
    expect(pane.className).toContain("rounded-[12px]");
    expect(pane.className).toContain("[overflow:clip]");
    expect(pane.className).not.toContain("clip-path");

    try {
      /* 滚到正文贴顶（jsdom 里 getBoundingClientRect 全 0 ⇒ paneTop=0） */
      await act(async () => {
        setScrollY(400);
        fireEvent.scroll(window);
      });
      /* 贴顶档是直角边框，overflow:clip 跟随 border-radius=0 也就是直角，不会露出圆角缺口 */
      expect(pane.className).toContain("rounded-none");
      expect(pane.className).toContain("[overflow:clip]");
      expect(pane.className).not.toContain("clip-path");
      // 接线断言：贴顶时 renderInlineContent 的第二个参数必须带 paneAtTop=true，
      // App 据此把 headerBackgroundRoundedTopFor 算成 false（不加顶部圆角）。
      expect((renderInlineContent.mock.lastCall as unknown[] | undefined)?.[1]).toMatchObject({
        paneAtTop: true,
      });

      /* 滚回列表最顶：正文已不在视口顶，必须复位成卡片档，不能保持铺满直角 */
      await act(async () => {
        setScrollY(0);
        fireEvent.scroll(window);
      });
      expect(pane.className).toContain("rounded-[12px]");
      expect(pane.className).toContain("[overflow:clip]");
      expect((renderInlineContent.mock.lastCall as unknown[] | undefined)?.[1]).toMatchObject({
        paneAtTop: false,
      });
    } finally {
      if (scrollYDescriptor) {
        Object.defineProperty(window, "scrollY", scrollYDescriptor);
      } else {
        Reflect.deleteProperty(window, "scrollY");
      }
    }
  });

  it.each([
    ["subtle", "border-border/40", "shadow-[0_1px_2px_rgba(0,0,0,0.04)]"],
    ["none", "border-0", "shadow-none"],
  ] as const)(
    "卡片档正文栏外框按设置映射（%s）",
    async (frame, expectedBorder, expectedShadow) => {
      setUISetting("articleLayout", "inoreader");
      setUISetting("articlePushDirection", "down");
      setUISetting("articlePaneFrame", frame);
      const renderInlineContent = vi.fn(() => (
        <div data-testid="inline-body">正文</div>
      ));
      render(
        <EntryList
          {...defaultProps}
          isMobile
          selectedEntryId="e-1"
          renderInlineContent={renderInlineContent}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      const pane = screen.getByTestId("inline-article-pane");
      expect(pane.className).toContain("mx-2");
      expect(pane.className).toContain("rounded-[12px]");
      expect(pane.className).toContain(expectedBorder);
      expect(pane.className).toContain(expectedShadow);
      expect(pane.className).not.toContain("border-border/60");
      expect(pane.className).not.toContain("shadow-nf");
    },
  );

  it("正文栏外框选「全宽」时无边框、无顶部分隔线并铺满整栏", async () => {
    setUISetting("articleLayout", "inoreader");
    setUISetting("articlePushDirection", "down");
    setUISetting("articlePaneFrame", "full");
    const renderInlineContent = vi.fn(() => (
      <div data-testid="inline-body">正文</div>
    ));
    render(
      <EntryList
        {...defaultProps}
        isMobile
        selectedEntryId="e-1"
        renderInlineContent={renderInlineContent}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const pane = screen.getByTestId("inline-article-pane");
    expect(pane.className).toContain("w-full");
    expect(pane.className).toContain("rounded-[12px]");
    expect(pane.className).not.toContain("border-t");
    expect(pane.className).not.toContain("border-border");
    expect(pane.className).toContain("[clip-path:inset(0_round_12px)]");
    expect(pane.className).not.toContain("mx-2");
    expect(pane.className).not.toContain("border-border/40");
    expect(pane.className).not.toContain("shadow-");
  });

  it("文章「Inoreader列表」在手机档包一层左滑动作（与其它列表一致）", async () => {
    setUISetting("articleLayout", "inoreader");
    render(<EntryList {...defaultProps} isMobile />);

    const viewport = screen.getByTestId("entry-list-viewport");
    // 手机档不虚拟化（走 document 滚动），但每行都要包一层左滑动作
    expect(screen.getByTestId("article-plain-list")).toBeTruthy();
    const rows = viewport.querySelectorAll("[data-swipe-row]");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.querySelector("[data-entry-id]")).not.toBeNull();
  });

  it("文章 hover 档不虚拟化（悬停浮层认行的委托不受影响）", () => {
    setUISetting("articleLayout", "hover");
    render(<EntryList {...defaultProps} />);

    expect(
      screen
        .getByTestId("entry-list-viewport")
        .querySelector('[data-virtual-list="true"]'),
    ).toBeNull();
    expect(rowIds()).toHaveLength(50);
  });
});
