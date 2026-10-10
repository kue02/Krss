/**
 * `runEntryPrefetch` 的单测：断言「进视口就把活干完，并把结果放到打开路径会读的地方」。
 * 这里 mock 掉 `@/api` 与 translation-store，只验接线与顺序。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runEntryPrefetch } from "@/hooks/useEntryPrefetch";
import type { PrefetchContext, PrefetchPlan } from "@/services/entry-prefetch-plan";
import type { Entry } from "@/types/api";

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
});