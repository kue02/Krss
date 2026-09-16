import { renderHook } from "@testing-library/react";
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
      entries: [makeEntry("e1")],
      enabled: true,
      unreadOnly: false,
      hasNextPage: true,
      resetKey: "k",
      timing: options.timing,
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

    const observer = FakeObserver.instances.at(-1);
    expect(observer).toBeTruthy();

    observer!.emit([{ target: card, isIntersecting: true, bottom: 200 }]);
    vi.advanceTimersByTime(3000);
    expect(markManyAsRead).not.toHaveBeenCalled();

    // 滚出顶部（bottom 在根顶部之上）
    observer!.emit([{ target: card, isIntersecting: false, bottom: -20 }]);
    vi.advanceTimersByTime(3000);
    expect(markManyAsRead).toHaveBeenCalledTimes(1);
    expect(markManyAsRead.mock.calls[0][0]).toMatchObject({ ids: ["e1"], read: true });
  });

  it("onVisible（Folo 语义）：进入视口并停留后即标记已读", () => {
    const container = document.createElement("div");
    const { contentRoot, card, surface } = makeHarness(container);
    renderScrollMarkRead({ contentRoot, surface, timing: "onVisible" });

    const observer = FakeObserver.instances.at(-1)!;
    observer!.emit([{ target: card, isIntersecting: true, bottom: 200 }]);

    // 停留时间未到：不标记
    vi.advanceTimersByTime(300);
    expect(markManyAsRead).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(markManyAsRead).toHaveBeenCalledTimes(1);
    expect(markManyAsRead.mock.calls[0][0].ids).toEqual(["e1"]);
  });

  it("onVisible：还没到停留时间就划走，不标记", () => {
    const container = document.createElement("div");
    const { contentRoot, card, surface } = makeHarness(container);
    renderScrollMarkRead({ contentRoot, surface, timing: "onVisible" });

    const observer = FakeObserver.instances.at(-1)!;
    observer!.emit([{ target: card, isIntersecting: true, bottom: 200 }]);
    vi.advanceTimersByTime(200);
    observer!.emit([{ target: card, isIntersecting: false, bottom: 900 }]);
    vi.advanceTimersByTime(3000);

    expect(markManyAsRead).not.toHaveBeenCalled();
  });

  it("enabled=false 时不观察也不标记", () => {
    const container = document.createElement("div");
    const { contentRoot, card, surface } = makeHarness(container);
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
});
