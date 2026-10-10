/**
 * `runEntryPrefetch` 的单测：断言「进视口就把活干完，并把结果放到打开路径会读的地方」。
 * 这里 mock 掉 `@/api` 与 translation-store，只验接线与顺序。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEntryPrefetch, runEntryPrefetch } from "@/hooks/useEntryPrefetch";
import {
  attachContentTranslation,
  claimContentTranslation,
  resetContentTranslationInFlight,
} from "@/services/content-translation-inflight";
import type { PrefetchContext, PrefetchPlan } from "@/services/entry-prefetch-plan";
import type { Entry, Feed } from "@/types/api";

const {
  mockFetchReadable,
  mockStreamSummary,
  mockStreamTranslateBlocks,
  mockTranslationSet,
  mockNeedsTranslation,
} = vi.hoisted(() => ({
  mockFetchReadable: vi.fn(),
  mockStreamSummary: vi.fn(),
  mockStreamTranslateBlocks: vi.fn(),
  mockTranslationSet: vi.fn(),
  mockNeedsTranslation: vi.fn(() => true),
}));

vi.mock("@/api", () => ({
  fetchReadableContent: mockFetchReadable,
  streamSummary: mockStreamSummary,
  streamTranslateBlocks: mockStreamTranslateBlocks,
  isTranslateInit: (event: unknown) =>
    typeof event === "object" && event !== null && "blocks" in event,
  isTranslateBlockResult: (event: unknown) =>
    typeof event === "object" &&
    event !== null &&
    "index" in event &&
    "html" in event &&
    !("blocks" in event),
}));

vi.mock("@/stores/translation-store", () => ({
  translationActions: { set: mockTranslationSet },
}));

vi.mock("@/lib/language-detect", () => ({
  needsTranslation: mockNeedsTranslation,
}));

async function* summaryStream(chunks: string[]) {
  for (const chunk of chunks) yield chunk;
}

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: "1",
  feedId: "f1",
  title: "Hello",
  url: "https://example.com/a",
  content: "<p>body</p>",
  read: false,
  starred: false,
  muted: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  ...over,
});

const context: PrefetchContext = {
  autoReadability: false,
  autoSummary: false,
  autoTranslate: false,
  targetLanguage: "zh-CN",
};

const plan = (over: Partial<PrefetchPlan> = {}): PrefetchPlan => ({
  readerMode: false,
  autoSummary: false,
  autoTranslate: false,
  ...over,
});

const feed = (over: Partial<Feed> = {}): Feed =>
  ({ id: "f1", title: "Feed", ...over }) as Feed;

/** 造一个 contentRootRef（hook 只读 .current） */
const refOf = (node: HTMLElement | null) => ({ current: node });

const run = (entryValue: Entry, planValue: PrefetchPlan, onReadable = vi.fn()) =>
  runEntryPrefetch({
    entry: entryValue,
    plan: planValue,
    context,
    signal: new AbortController().signal,
    onReadable,
  });

describe("runEntryPrefetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNeedsTranslation.mockReturnValue(true);
    resetContentTranslationInFlight();
  });

  it("三态全关：一个请求都不发", async () => {
    await run(entry(), plan());
    expect(mockFetchReadable).not.toHaveBeenCalled();
    expect(mockStreamSummary).not.toHaveBeenCalled();
    expect(mockStreamTranslateBlocks).not.toHaveBeenCalled();
  });

  it("阅读模式：抓正文 → 回写缓存 → 摘要/翻译用抓回来的正文", async () => {
    mockFetchReadable.mockResolvedValue("<p>full</p>");
    mockStreamSummary.mockImplementation(() => summaryStream(["s"]));
    const onReadable = vi.fn();

    await run(
      entry(),
      plan({ readerMode: true, autoSummary: true }),
      onReadable,
    );

    expect(mockFetchReadable).toHaveBeenCalledTimes(1);
    expect(mockFetchReadable.mock.calls[0]![0]).toBe("1");
    expect(onReadable).toHaveBeenCalledWith("1", "<p>full</p>");
    // 摘要基于 readableContent，且带上 isReadability（与打开路径同一口径 ⇒ 命中后端缓存）
    expect(mockStreamSummary.mock.calls[0]![0]).toMatchObject({
      entryId: "1",
      content: "<p>full</p>",
      isReadability: true,
    });
  });

  it("已经有 readableContent 就不重复抓（打开路径也是这个逻辑）", async () => {
    const onReadable = vi.fn();
    await run(entry({ readableContent: "<p>cached</p>" }), plan({ readerMode: true }), onReadable);
    expect(mockFetchReadable).not.toHaveBeenCalled();
    expect(onReadable).not.toHaveBeenCalled();
  });

  it("没有 url 时跳过抓正文，直接用源内容做摘要", async () => {
    mockStreamSummary.mockImplementation(() => summaryStream(["s"]));
    await run(entry({ url: undefined }), plan({ readerMode: true, autoSummary: true }));
    expect(mockFetchReadable).not.toHaveBeenCalled();
    expect(mockStreamSummary.mock.calls[0]![0]).toMatchObject({
      content: "<p>body</p>",
      isReadability: false,
    });
  });

  it("翻译命中后端缓存：直接写 translation-store（isReadability 与正文页一致）", async () => {
    mockStreamTranslateBlocks.mockImplementation(async function* () {
      yield { cached: true, content: "<p>译好的</p>" };
    });

    await run(
      entry({ readableContent: "<p>full</p>" }),
      plan({ autoTranslate: true }),
    );

    expect(mockTranslationSet).toHaveBeenCalledWith(
      "1",
      "zh-CN",
      { content: "<p>译好的</p>" },
      false,
    );
  });

  it("翻译走分块流：按块序拼回整篇再写 store", async () => {
    mockStreamTranslateBlocks.mockImplementation(async function* () {
      yield {
        blocks: [
          { index: 0, html: "<p>一</p>", needTranslate: true },
          { index: 1, html: "<p>二</p>", needTranslate: true },
        ],
      };
      yield { index: 1, html: "<p>贰</p>" };
      yield { index: 0, html: "<p>壹</p>" };
      yield { done: true };
    });

    await run(entry(), plan({ autoTranslate: true }));
    expect(mockTranslationSet).toHaveBeenCalledWith(
      "1",
      "zh-CN",
      { content: "<p>壹</p><p>贰</p>" },
      false,
    );
  });

  it("翻译请求失败向上抛（交给队列退避重试），不写脏数据", async () => {
    mockStreamTranslateBlocks.mockImplementation(async function* () {
      yield { done: true };
      throw new Error("network down");
    });
    await expect(run(entry(), plan({ autoTranslate: true }))).rejects.toThrow(
      "network down",
    );
    expect(mockTranslationSet).not.toHaveBeenCalled();
  });

  it("原文已是目标语言 → 不发翻译请求", async () => {
    mockNeedsTranslation.mockReturnValue(false);
    await run(entry(), plan({ autoTranslate: true }));
    expect(mockStreamTranslateBlocks).not.toHaveBeenCalled();
    expect(mockTranslationSet).not.toHaveBeenCalled();
  });

  it("把 AbortSignal 透传给三个请求（滚出视口能掐掉）", async () => {
    const controller = new AbortController();
    mockFetchReadable.mockResolvedValue("<p>full</p>");
    mockStreamSummary.mockImplementation(() => summaryStream(["s"]));
    mockStreamTranslateBlocks.mockImplementation(async function* () {
      yield { cached: true, content: "<p>t</p>" };
    });

    await runEntryPrefetch({
      entry: entry(),
      plan: plan({ readerMode: true, autoSummary: true, autoTranslate: true }),
      context,
      signal: controller.signal,
      onReadable: vi.fn(),
    });

    expect(mockFetchReadable.mock.calls[0]![1]).toBe(controller.signal);
    expect(mockStreamSummary.mock.calls[0]![1]).toBe(controller.signal);
    expect(mockStreamTranslateBlocks.mock.calls[0]![1]).toBe(controller.signal);
  });

  it("打开路径正在翻同一条 ⇒ 预载不再发翻译请求（不重复跑模型）", async () => {
    // 模拟「用户点得比预载快」：打开路径先 claim 了这条
    const claim = claimContentTranslation("1", false, "zh-CN");
    expect(claim).not.toBeNull();

    await run(entry(), plan({ autoTranslate: true }));

    expect(mockStreamTranslateBlocks).not.toHaveBeenCalled();
    expect(mockTranslationSet).not.toHaveBeenCalled();

    // 它收尾之后，同一个 key 可以重新 claim ⇒ 预载恢复正常
    claim!.finish();
    mockStreamTranslateBlocks.mockImplementation(async function* () {
      yield { cached: true, content: "<p>译好的</p>" };
    });
    await run(entry(), plan({ autoTranslate: true }));
    expect(mockStreamTranslateBlocks).toHaveBeenCalledTimes(1);
  });

  it("预载当发起方时把流事件转发给订阅方（打开路径照样逐块出）", async () => {
    mockStreamTranslateBlocks.mockImplementation(async function* () {
      yield { blocks: [{ index: 0, html: "<p>一</p>", needTranslate: true }] };
      yield { index: 0, html: "<p>壹</p>" };
      yield { done: true };
    });

    const seen: Array<Record<string, unknown>> = [];
    // 预载在翻译这一步是**同步** claim 的，所以这里「边跑边订阅」等价于
    // 「用户此刻点开了这条」
    const running = run(entry(), plan({ autoTranslate: true }));
    const attached = attachContentTranslation("1", false, "zh-CN", (event) =>
      seen.push(event as Record<string, unknown>),
    );
    expect(attached).not.toBeNull();

    await running;
    await attached;

    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ blocks: expect.any(Array) });
    expect(seen[1]).toMatchObject({ index: 0, html: "<p>壹</p>" });
  });
});

/**
 * 视口触发判定（jsdom + 假 IntersectionObserver）。
 *
 * 补这个是因为真机实测踩到过：条目是**异步**渲染的，观察器挂载那一刻列表里
 * 一行都没有，只在挂载时扫一次的话后面所有行永远不会被观测到（预载静默不发生）。
 * 这里把「行在挂载之后才出现」钉成回归。
 */
describe("useEntryPrefetch 视口触发", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchReadable.mockResolvedValue("<p>full</p>");
  });

  /** 可手动触发回调的假 IntersectionObserver */
  function installFakeIO() {
    const instances: {
      targets: Set<Element>;
      cb: IntersectionObserverCallback;
      opts: IntersectionObserverInit | undefined;
      observed: Element[];
    }[] = [];
    const OrigIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      targets = new Set<Element>();
      observed: Element[] = [];
      constructor(
        cb: IntersectionObserverCallback,
        opts?: IntersectionObserverInit,
      ) {
        instances.push({
          targets: this.targets,
          cb,
          opts,
          observed: this.observed,
        });
      }
      observe(el: Element) {
        this.targets.add(el);
        this.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.targets.clear();
      }
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;

    return {
      instances,
      restore: () => {
        globalThis.IntersectionObserver = OrigIO;
      },
      /** 触发某实例的回调（模拟目标进入视口） */
      fire: (index: number, ids: string[]) => {
        const inst = instances[index]!;
        const entries = ids.map((id) => {
          const el = document.createElement("div");
          el.dataset.entryId = id;
          return {
            target: el,
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: {} as DOMRectReadOnly,
            intersectionRect: {} as DOMRectReadOnly,
            rootBounds: null,
            time: 0,
          } as unknown as IntersectionObserverEntry;
        });
        inst.cb(entries, {} as IntersectionObserver);
      },
    };
  }

  it("条目在挂载之后才渲染进列表 → 补挂观察器并预载", async () => {
    const io = installFakeIO();
    try {
      const root = document.createElement("div");
      document.body.append(root);
      const ref = { current: root };
      const loaded = [entry({ id: "a1" }), entry({ id: "a2" })];

      // 第一次渲染：列表还是空的（query 没回来）
      const view = renderHook(
        ({ items }: { items: Entry[] }) =>
          useEntryPrefetch({
            entries: items,
            feedsById: new Map([["f1", feed({ readerMode: true })]]),
            context: { ...context, autoReadability: false },
            intersectionRoot: null,
            contentRootRef: ref,
            enabled: true,
            resetKey: "all",
            concurrency: 2,
          }),
        { initialProps: { items: [] as Entry[] } },
      );

      // 第二次渲染：条目到了，行也渲染进 DOM 了
      root.innerHTML =
        '<div data-entry-id="a1"></div><div data-entry-id="a2"></div>';
      view.rerender({ items: loaded });
      view.unmount();

      const observedIds = io.instances.flatMap((inst) =>
        inst.observed.map((el) => (el as HTMLElement).dataset.entryId),
      );
      expect(observedIds).toContain("a1");
      expect(observedIds).toContain("a2");
    } finally {
      io.restore();
    }
  });

  it("行是后补进来的也不会被重复 observe（补扫按 DOM 节点去重）", async () => {
    const io = installFakeIO();
    try {
      const root = document.createElement("div");
      document.body.append(root);
      root.innerHTML = '<div data-entry-id="a1"></div>';

      const view = renderHook(
        () =>
          useEntryPrefetch({
            entries: [entry({ id: "a1" })],
            feedsById: new Map([["f1", feed({ readerMode: true })]]),
            context,
            intersectionRoot: null,
            contentRootRef: refOf(root),
            enabled: true,
            resetKey: "all",
          }),
      );
      view.rerender();
      view.rerender();
      view.unmount();

      const a1Observed = io.instances.flatMap((inst) =>
        inst.observed.map((el) => (el as HTMLElement).dataset.entryId),
      ).filter((id) => id === "a1");
      expect(a1Observed).toHaveLength(1);
    } finally {
      io.restore();
    }
  });

  it("enabled=false：一个都不观察（在跑的全撤）", async () => {
    const io = installFakeIO();
    try {
      const root = document.createElement("div");
      document.body.append(root);
      root.innerHTML = '<div data-entry-id="a1"></div>';

      const view = renderHook(
        () =>
          useEntryPrefetch({
            entries: [entry({ id: "a1" })],
            feedsById: new Map(),
            context,
            intersectionRoot: null,
            contentRootRef: refOf(root),
            enabled: false,
            resetKey: "all",
          }),
      );
      view.unmount();

      const observedCount = io.instances.reduce(
        (n, inst) => n + inst.observed.length,
        0,
      );
      expect(observedCount).toBe(0);
    } finally {
      io.restore();
    }
  });
});