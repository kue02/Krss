/**
 * 标准文章列表虚拟化回归测试（perf 分支）。
 *
 * 覆盖语义：
 * 1. 50 条时首屏挂载的卡数 <= 15（可视区 600px / 估计行高 148px ≈ 4 行 + overscan 8*2 上限）。
 * 2. 滚动到底能加载出后面的卡（range 跟着 scrollTop 走）。
 * 3. 虚拟化只作用于标准文章列表：社交 / 通知时间线 / hover 档走原路径。
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

vi.mock("@/hooks/useEntries", () => ({
  useEntriesInfinite: vi.fn(),
  useUnreadCounts: vi.fn(() => ({ data: undefined })),
  useMarkManyAsRead: vi.fn(() => ({ mutate: vi.fn() })),
  useRemoveFromUnreadList: vi.fn(() => vi.fn()),
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
  };
});

vi.mock("./EntryListHeader", () => ({
  EntryListHeader: () => null,
}));

vi.mock("./NotificationTimeline", () => ({
  NotificationTimeline: () => <div data-testid="notification-timeline" />,
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

  it("社交视图不虚拟化（50 条全渲染，走原路径）", () => {
    render(<EntryList {...defaultProps} contentType="social" />);

    expect(screen.queryByTestId("notification-timeline")).toBeNull();
    expect(
      screen
        .getByTestId("entry-list-viewport")
        .querySelector('[data-virtual-list="true"]'),
    ).toBeNull();
    expect(rowIds()).toHaveLength(50);
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
