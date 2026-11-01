import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "@/types/api";
import type { ScrollSurface } from "./scroll-surface";
import { useScrollMarkRead } from "./useScrollMarkRead";

const markManyAsRead = vi.fn();
const removeFromUnreadList = vi.fn();

vi.mock("@/hooks/useEntries", () => ({
  useMarkManyAsRead: () => ({ mutate: markManyAsRead }),
  useRemoveFromUnreadList: () => removeFromUnreadList,
}));

function makeEntry(id: string): Entry {
  return {
    id,
    feedId: "f1",
    title: `entry ${id}`,
    url: `https://example.com/${id}`,
    content: "content",
    read: false,
    starred: false,
    publishedAt: "2026-09-16T00:00:00Z",
  } as unknown as Entry;
}

/** 可控的 IntersectionObserver 替身：记录回调，便于手动触发 */
class FakeObserver {
  static instances: FakeObserver[] = [];
  callback: IntersectionObserverCallback;
  elements: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeObserver.instances.push(this);
  }

  observe(el: Element) {
    this.elements.push(el);
  }

  disconnect() {
    this.elements = [];
  }

  unobserve() {}

  takeRecords() {
    return [];
  }

  emit(entries: Array<{ target: Element; isIntersecting: boolean; bottom: number }>) {
    const rootBounds = { top: 0, bottom: 800, left: 0, right: 1000 } as DOMRect;
    this.callback(
      entries.map((item) => ({
        target: item.target,
        isIntersecting: item.isIntersecting,
        boundingClientRect: {
          bottom: item.bottom,
          top: item.bottom - 100,
          height: 100,
        } as DOMRect,
        intersectionRatio: item.isIntersecting ? 1 : 0,
        intersectionRect: {} as DOMRect,
        rootBounds,
        time: 0,
      })) as unknown as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

function makeHarness(container: HTMLElement) {
  const contentRoot = document.createElement("div");
  const card = document.createElement("div");
  card.dataset.entryId = "e1";
  card.getBoundingClientRect = () =>
    ({ top: 100, bottom: 200, height: 100, left: 0, right: 600, width: 600 }) as DOMRect;
  contentRoot.appendChild(card);
  container.appendChild(contentRoot);

  const surface: ScrollSurface = {
    kind: "element",
    getViewportRect: () => ({ top: 0, bottom: 800, left: 0, right: 600, height: 800, width: 600 }),
    getIntersectionRoot: () => contentRoot,
    getScrollElement: () => contentRoot,
    scrollBy: vi.fn(),
    getScrollTop: () => 0,
    getScrollHeight: () => 2000,
  } as unknown as ScrollSurface;

  return { contentRoot, card, surface };
}

function renderScrollMarkRead(
  options: Partial<Parameters<typeof useScrollMarkRead>[0]> & {
    contentRoot: HTMLDivElement;
    surface: ScrollSurface;
  },
) {
  const contentRootRef = { current: options.contentRoot };
  return renderHook(() =>
    useScrollMarkRead({
      surface: options.surface,
      contentRootRef,
      entries: options.entries ?? [makeEntry("e1")],
      enabled: true,
      unreadOnly: options.unreadOnly ?? false,
      hasNextPage: true,
      resetKey: "k",
      timing: options.timing,
      deferRemoval: options.deferRemoval,
    }),
  );
}

describe("useScrollMarkRead 的已读判定时机", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeObserver.instances = [];
    markManyAsRead.mockClear();
    removeFromUnreadList.mockClear();
    vi.stubGlobal("IntersectionObserver", FakeObserver as unknown as typeof IntersectionObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("scrollPast（默认）：条目滚出顶部才标记已读", () => {
    const container = document.createElement("div");
    const { contentRoot, card, surface } = makeHarness(container);
    renderScrollMarkRead({ contentRoot, surface });

    const observer = FakeObserver.instances.at(-1) as FakeObserver;
    expect(observer).toBeTruthy();

    observer.emit([{ target: card, isIntersecting: true, bottom: 200 }]);
    vi.advanceTimersByTime(3000);
    expect(markManyAsRead).not.toHaveBeenCalled();

    // 滚出顶部（bottom 在根顶部之上）
    observer.emit([{ target: card, isIntersecting: false, bottom: -20 }]);
    vi.advanceTimersByTime(3000);
    expect(markManyAsRead).toHaveBeenCalledTimes(1);
    const [firstCall] = markManyAsRead.mock.calls;
    expect(firstCall?.[0]).toMatchObject({ ids: ["e1"], read: true });
  });

  it("onVisible（Folo 语义）：进入视口并停留后即标记已读", () => {
    const container = document.createElement("div");
    const { contentRoot, card, surface } = makeHarness(container);
    renderScrollMarkRead({ contentRoot, surface, timing: "onVisible" });

    const observer = FakeObserver.instances.at(-1) as FakeObserver;
    observer.emit([{ target: card, isIntersecting: true, bottom: 200 }]);

    // 停留时间未到：不标记
    vi.advanceTimersByTime(300);
    expect(markManyAsRead).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(markManyAsRead).toHaveBeenCalledTimes(1);
    const [visibleCall] = markManyAsRead.mock.calls;
    expect(visibleCall?.[0]?.ids).toEqual(["e1"]);
  });

  it("只看未读 + onVisible：标完一批后不再自动继续，等用户滚动才接着判", () => {
    const container = document.createElement("div");
    const { contentRoot, card, surface } = makeHarness(container);
    // 让 surface 支持订阅滚动（真实实现里有，桩里补上）
    const listeners: Array<() => void> = [];
    (surface as unknown as { subscribe: (fn: () => void) => () => void }).subscribe = (
      fn,
    ) => {
      listeners.push(fn);
      return () => undefined;
    };
    // 让标记成功后真的走 onSuccess（真实实现里那里会移除未读项、进入「等用户滚动」）
    markManyAsRead.mockImplementation(
      (_payload: unknown, opts?: { onSuccess?: () => void }) =>
        opts?.onSuccess?.(),
    );

    // 第二张卡片：模拟「上一批被移除后顶上来」的下一批
    const card2 = document.createElement("div");
    card2.dataset.entryId = "e2";
    card2.getBoundingClientRect = () =>
      ({ top: 100, bottom: 200, height: 100, left: 0, right: 600, width: 600 }) as DOMRect;
    contentRoot.appendChild(card2);

    renderScrollMarkRead({
      contentRoot,
      surface,
      timing: "onVisible",
      unreadOnly: true,
      // 这一条测的是**旧的即时摘除**路径（摘掉了才会「顶上来」，才需要「等用户再滚」的自锁）；
      // 默认档（延迟摘除）见下面那条 20-3 用例。
      deferRemoval: false,
      entries: [makeEntry("e1"), makeEntry("e2")],
    });

    const observer = FakeObserver.instances.at(-1) as FakeObserver;
    observer.emit([{ target: card, isIntersecting: true, bottom: 200 }]);
    vi.advanceTimersByTime(3000);
    expect(markManyAsRead).toHaveBeenCalledTimes(1);

    // 用户没滚动：被顶上来的一批不该继续标（否则整列表会自己读完消失）
    observer.emit([{ target: card2, isIntersecting: true, bottom: 200 }]);
    vi.advanceTimersByTime(3000);
    expect(markManyAsRead).toHaveBeenCalledTimes(1);

    // 用户滚一次之后可以继续
    listeners.forEach((fn) => fn());
    const next = FakeObserver.instances.at(-1) as FakeObserver;
    next.emit([{ target: card2, isIntersecting: true, bottom: 200 }]);
    vi.advanceTimersByTime(3000);
    expect(markManyAsRead).toHaveBeenCalledTimes(2);
  });

  it("onVisible：还没到停留时间就划走，不标记", () => {
    const container = document.createElement("div");
    const { contentRoot, card, surface } = makeHarness(container);
    renderScrollMarkRead({ contentRoot, surface, timing: "onVisible" });

    const observer = FakeObserver.instances.at(-1) as FakeObserver;
    observer.emit([{ target: card, isIntersecting: true, bottom: 200 }]);
    vi.advanceTimersByTime(200);
    observer.emit([{ target: card, isIntersecting: false, bottom: 900 }]);
    vi.advanceTimersByTime(3000);

    expect(markManyAsRead).not.toHaveBeenCalled();
  });

  it("enabled=false 时不观察也不标记", () => {
    const container = document.createElement("div");
    const { contentRoot, surface } = makeHarness(container);
    const contentRootRef = { current: contentRoot };
    renderHook(() =>
      useScrollMarkRead({
        surface,
        contentRootRef,
        entries: [makeEntry("e1")],
        enabled: false,
        unreadOnly: false,
        hasNextPage: true,
        resetKey: "k",
      }),
    );

    expect(FakeObserver.instances).toHaveLength(0);
    expect(markManyAsRead).not.toHaveBeenCalled();
  });

  it("20-3 默认档：标成已读不实时摘掉，离开列表（resetKey 变）时才摘", async () => {
    const container = document.createElement("div");
    const { contentRoot, card, surface } = makeHarness(container);
    // 让标记成功后真的走 onSuccess（真实实现里那里会决定「摘 / 先不摘」）
    markManyAsRead.mockImplementation(
      (_payload: unknown, opts?: { onSuccess?: () => void }) =>
        opts?.onSuccess?.(),
    );

    const contentRootRef = { current: contentRoot };
    const { rerender } = renderHook(
      ({ resetKey }: { resetKey: string }) =>
        useScrollMarkRead({
          surface,
          contentRootRef,
          entries: [makeEntry("e1")],
          enabled: true,
          unreadOnly: true,
          hasNextPage: true,
          resetKey,
        }),
      { initialProps: { resetKey: "k1" } },
    );

    const observer = FakeObserver.instances.at(-1) as FakeObserver;
    observer.emit([{ target: card, isIntersecting: true, bottom: 200 }]);
    observer.emit([{ target: card, isIntersecting: false, bottom: -20 }]);
    vi.advanceTimersByTime(3000);

    expect(markManyAsRead).toHaveBeenCalledTimes(1);
    // 关键：不实时摘（否则条目被往上顶）
    expect(removeFromUnreadList).not.toHaveBeenCalled();

    // 离开这个列表（换订阅 / 换视图 / 换已读态都会让 resetKey 变）→ 这时才摘
    // 用 act 包住，确保 resetKey 那个 effect 真的跑完
    await act(async () => {
      rerender({ resetKey: "k2" });
    });
    expect(removeFromUnreadList).toHaveBeenCalledTimes(1);
    const [removed] = removeFromUnreadList.mock.calls;
    expect(Array.from(removed?.[0] as Set<string>)).toEqual(["e1"]);
  });
});

/**
 * 58-2（用户 2026-10-29「通知视图滚出顶部失效」）：
 * 通知时间线把同一时间桶里太密集的条目吸成「小节点 + N 条」的簇 —— 那些条目
 * 没有自己的 DOM 节点，旧实现（只认 `[data-entry-id]`）永远观察不到，滚过去也不标已读。
 */
describe("useScrollMarkRead · 通知时间线折叠簇（58-2）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeObserver.instances = [];
    markManyAsRead.mockClear();
    removeFromUnreadList.mockClear();
    vi.stubGlobal("IntersectionObserver", FakeObserver as unknown as typeof IntersectionObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("簇节点（data-cluster-entry-ids）滚出顶部后，整簇条目一次标为已读", () => {
    const container = document.createElement("div");
    const contentRoot = document.createElement("div");
    const cluster = document.createElement("div");
    cluster.dataset.clusterEntryIds = "c1,c2,c3";
    cluster.getBoundingClientRect = () =>
      ({ top: 100, bottom: 200, height: 100, left: 0, right: 600, width: 600 }) as DOMRect;
    contentRoot.appendChild(cluster);
    container.appendChild(contentRoot);

    const surface = {
      kind: "element",
      getViewportRect: () => ({ top: 0, bottom: 800, left: 0, right: 600, height: 800, width: 600 }),
      getIntersectionRoot: () => contentRoot,
      scrollBy: vi.fn(),
      getScrollTop: () => 0,
      getScrollHeight: () => 2000,
    } as unknown as ScrollSurface;

    renderHook(() =>
      useScrollMarkRead({
        surface,
        contentRootRef: { current: contentRoot },
        entries: [makeEntry("c1"), makeEntry("c2"), makeEntry("c3")],
        enabled: true,
        unreadOnly: false,
        hasNextPage: true,
        resetKey: "k",
      }),
    );

    const observer = FakeObserver.instances.at(-1) as FakeObserver;
    expect(observer).toBeTruthy();
    // 看到簇（还没滚出去）
    observer.emit([{ target: cluster, isIntersecting: true, bottom: 200 }]);
    vi.advanceTimersByTime(3000);
    expect(markManyAsRead).not.toHaveBeenCalled();

    // 簇整体滚出顶部
    observer.emit([{ target: cluster, isIntersecting: false, bottom: -20 }]);
    vi.advanceTimersByTime(3000);

    expect(markManyAsRead).toHaveBeenCalledTimes(1);
    const [call] = markManyAsRead.mock.calls;
    expect((call?.[0] as { ids: string[] }).ids.sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("簇里没被看到的条目不标（必须先进入过视口）", () => {
    const container = document.createElement("div");
    const contentRoot = document.createElement("div");
    const cluster = document.createElement("div");
    cluster.dataset.clusterEntryIds = "c1,c2";
    cluster.getBoundingClientRect = () =>
      ({ top: 1000, bottom: 1100, height: 100, left: 0, right: 600, width: 600 }) as DOMRect;
    contentRoot.appendChild(cluster);
    container.appendChild(contentRoot);

    const surface = {
      kind: "element",
      getViewportRect: () => ({ top: 0, bottom: 800, left: 0, right: 600, height: 800, width: 600 }),
      getIntersectionRoot: () => contentRoot,
      scrollBy: vi.fn(),
      getScrollTop: () => 0,
      getScrollHeight: () => 2000,
    } as unknown as ScrollSurface;

    renderHook(() =>
      useScrollMarkRead({
        surface,
        contentRootRef: { current: contentRoot },
        entries: [makeEntry("c1"), makeEntry("c2")],
        enabled: true,
        unreadOnly: false,
        hasNextPage: true,
        resetKey: "k",
      }),
    );

    const observer = FakeObserver.instances.at(-1) as FakeObserver;
    // 从未 intersect，直接非相交 → 不能标
    observer.emit([{ target: cluster, isIntersecting: false, bottom: -20 }]);
    vi.advanceTimersByTime(3000);

    expect(markManyAsRead).not.toHaveBeenCalled();
  });
});
