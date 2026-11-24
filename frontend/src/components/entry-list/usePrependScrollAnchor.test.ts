import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "@/types/api";
import type { ScrollSurface } from "./scroll-surface";
import {
  findHeadAdditionIds,
  isStabilizeDeltaTooLarge,
  usePrependScrollAnchor,
} from "./usePrependScrollAnchor";

function makeEntry(id: string): Entry {
  return {
    id,
    feedId: "f1",
    title: `entry ${id}`,
    url: `https://example.com/${id}`,
    content: "content",
    read: false,
    starred: false,
    publishedAt: "2026-10-29T00:00:00Z",
  } as unknown as Entry;
}

interface Harness {
  contentRoot: HTMLDivElement;
  surface: ScrollSurface;
  scrollBy: ReturnType<typeof vi.fn>;
  setScrollTop: (value: number) => void;
  nodes: Map<string, HTMLDivElement>;
}

/** 一个最小 DOM：若干 `[data-entry-id]` 行，行高 100、位置由 `tops` 控制 */
function makeHarness(tops: Record<string, number>): Harness {
  const contentRoot = document.createElement("div");
  const nodes = new Map<string, HTMLDivElement>();
  for (const [id, top] of Object.entries(tops)) {
    const node = document.createElement("div");
    node.dataset.entryId = id;
    node.getBoundingClientRect = () =>
      ({ top, bottom: top + 100, height: 100, left: 0, right: 600, width: 600 }) as DOMRect;
    contentRoot.appendChild(node);
    nodes.set(id, node);
  }

  let scrollTop = 50;
  const scrollBy = vi.fn((delta: number) => {
    scrollTop = Math.max(0, scrollTop + delta);
  });

  const surface = {
    kind: "element",
    subscribe: () => () => undefined,
    getViewportRect: () => ({ top: 0, bottom: 800, left: 0, right: 600, height: 800, width: 600 }),
    getIntersectionRoot: () => contentRoot,
    getScrollTop: () => scrollTop,
    getScrollHeight: () => 4000,
    scrollTo: (top: number) => {
      scrollTop = top;
    },
    scrollBy,
  } as unknown as ScrollSurface;

  return {
    contentRoot,
    surface,
    scrollBy,
    setScrollTop: (value: number) => {
      scrollTop = value;
    },
    nodes,
  };
}

describe("isStabilizeDeltaTooLarge（合列插正文后别把视口甩走）", () => {
  it("一屏半以内算正常抖动，照补", () => {
    expect(isStabilizeDeltaTooLarge(120, 800)).toBe(false);
    expect(isStabilizeDeltaTooLarge(-1199, 800)).toBe(false);
  });

  it("超过一屏半就丢弃（正文 pane 插进来是几千像素）", () => {
    expect(isStabilizeDeltaTooLarge(1201, 800)).toBe(true);
    expect(isStabilizeDeltaTooLarge(-3462, 800)).toBe(true);
  });

  it("视口很矮时仍有 240px 的下限，避免正常补位移被误杀", () => {
    expect(isStabilizeDeltaTooLarge(200, 100)).toBe(false);
    expect(isStabilizeDeltaTooLarge(241, 100)).toBe(true);
  });
});

describe("findHeadAdditionIds（58-3）", () => {
  it("只取「插在第一个旧条目之前」的新 id，翻页追加不算", () => {
    const prev = new Set(["b", "c"]);
    const entries = [makeEntry("n1"), makeEntry("n2"), makeEntry("b"), makeEntry("c"), makeEntry("d")];
    expect(findHeadAdditionIds(prev, entries)).toEqual(["n1", "n2"]);
  });

  it("完全没变化时为空", () => {
    expect(findHeadAdditionIds(new Set(["b"]), [makeEntry("b")])).toEqual([]);
  });
});

describe("usePrependScrollAnchor（58-3 无感叠加）", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  it("在列表中部：新条目 prefend 后按锚点补偿 scrollTop，并回报新增 id", () => {
    const harness = makeHarness({ a: 100, b: 200 });
    const onHeadAdditions = vi.fn();

    const { rerender } = renderHook(
      ({ entries }) =>
        usePrependScrollAnchor({
          surface: harness.surface,
          contentRootRef: { current: harness.contentRoot },
          entries,
          resetKey: "k",
          enabled: true,
          onHeadAdditions,
        }),
      { initialProps: { entries: [makeEntry("a"), makeEntry("b")] } },
    );

    // 新条目 n 插到最前面 → 原来的 a 被推下 100px
    harness.nodes.get("a")!.getBoundingClientRect = () =>
      ({ top: 200, bottom: 300, height: 100, left: 0, right: 600, width: 600 }) as DOMRect;
    const newNode = document.createElement("div");
    newNode.dataset.entryId = "n";
    newNode.getBoundingClientRect = () =>
      ({ top: 100, bottom: 200, height: 100, left: 0, right: 600, width: 600 }) as DOMRect;
    harness.contentRoot.insertBefore(newNode, harness.contentRoot.firstChild);

    act(() => {
      rerender({ entries: [makeEntry("n"), makeEntry("a"), makeEntry("b")] });
    });

    expect(harness.scrollBy).toHaveBeenCalledWith(100);
    expect(onHeadAdditions).toHaveBeenCalledWith(["n"], ["n"], false);
  });

  it("在列表最顶端：不补偿、直接插，并回报 atTop=true（不弹条数提示）", () => {
    const harness = makeHarness({ a: 100, b: 200 });
    harness.setScrollTop(0);
    const onHeadAdditions = vi.fn();

    const { rerender } = renderHook(
      ({ entries }) =>
        usePrependScrollAnchor({
          surface: harness.surface,
          contentRootRef: { current: harness.contentRoot },
          entries,
          resetKey: "k",
          enabled: true,
          onHeadAdditions,
        }),
      { initialProps: { entries: [makeEntry("a"), makeEntry("b")] } },
    );

    act(() => {
      rerender({ entries: [makeEntry("n"), makeEntry("a"), makeEntry("b")] });
    });

    expect(harness.scrollBy).not.toHaveBeenCalled();
    expect(onHeadAdditions).toHaveBeenCalledWith(["n"], ["n"], true);
  });

  it("翻下一页（尾部追加）不补偿、不回报新增", () => {
    const harness = makeHarness({ a: 100, b: 200 });
    const onHeadAdditions = vi.fn();

    const { rerender } = renderHook(
      ({ entries }) =>
        usePrependScrollAnchor({
          surface: harness.surface,
          contentRootRef: { current: harness.contentRoot },
          entries,
          resetKey: "k",
          enabled: true,
          onHeadAdditions,
        }),
      { initialProps: { entries: [makeEntry("a"), makeEntry("b")] } },
    );

    act(() => {
      rerender({ entries: [makeEntry("a"), makeEntry("b"), makeEntry("c")] });
    });

    expect(harness.scrollBy).not.toHaveBeenCalled();
    expect(onHeadAdditions).not.toHaveBeenCalled();
  });
  it("新条目夹在两条旧条目之间：headIds 为空但 newIds 要报全（Toast 数字不能漏）", () => {
    const harness = makeHarness({ old1: 100, old2: 200, old3: 300 });
    const onHeadAdditions = vi.fn();

    const { rerender } = renderHook(
      ({ entries }) =>
        usePrependScrollAnchor({
          surface: harness.surface,
          contentRootRef: { current: harness.contentRoot },
          entries,
          resetKey: "k",
          enabled: true,
          onHeadAdditions,
        }),
      { initialProps: { entries: [makeEntry("old1"), makeEntry("old2"), makeEntry("old3")] } },
    );

    act(() => {
      rerender({
        entries: [
          makeEntry("old1"),
          makeEntry("interleaved"),
          makeEntry("old2"),
          makeEntry("old3"),
        ],
      });
    });

    expect(harness.scrollBy).not.toHaveBeenCalled();
    expect(onHeadAdditions).toHaveBeenCalledWith([], ["interleaved"], false);
  });

  it("头部新条目把锚点推走几千像素（正文 pane 那种）：不补、只重测锚点", () => {
    const harness = makeHarness({ a: 100, b: 200 });
    const onHeadAdditions = vi.fn();

    const { rerender } = renderHook(
      ({ entries }) =>
        usePrependScrollAnchor({
          surface: harness.surface,
          contentRootRef: { current: harness.contentRoot },
          entries,
          resetKey: "k",
          enabled: true,
          onHeadAdditions,
        }),
      { initialProps: { entries: [makeEntry("a"), makeEntry("b")] } },
    );

    // 视口高 800 ⇒ 上限 1200；这里 a 被推下 2900（正文 pane 插进列表的量级）
    harness.nodes.get("a")!.getBoundingClientRect = () =>
      ({ top: 3000, bottom: 3100, height: 100, left: 0, right: 600, width: 600 }) as DOMRect;
    const newNode = document.createElement("div");
    newNode.dataset.entryId = "n";
    newNode.getBoundingClientRect = () =>
      ({ top: 100, bottom: 200, height: 100, left: 0, right: 600, width: 600 }) as DOMRect;
    harness.contentRoot.insertBefore(newNode, harness.contentRoot.firstChild);

    act(() => {
      rerender({ entries: [makeEntry("n"), makeEntry("a"), makeEntry("b")] });
    });

    expect(harness.scrollBy).not.toHaveBeenCalled();
    // 仍然要回报新增（Toast 的数字不能因为不补偿就丢）
    expect(onHeadAdditions).toHaveBeenCalledWith(["n"], ["n"], false);
  });
});
