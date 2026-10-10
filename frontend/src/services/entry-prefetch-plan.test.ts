/**
 * 三态生效口径的单测。判定的权威是正文页（`EntryContent.tsx:91-107`），
 * 这里把每条分支钉住 —— 预载判错 = 打开时要用还得再跑一趟。
 */

import { describe, it, expect, vi } from "vitest";
import {
  resolvePrefetchPlan,
  hasAnyPrefetch,
  buildPrefetchTask,
  prefetchKey,
  summaryWorthPrefetching,
  translateWorthPrefetching,
  type PrefetchContext,
} from "@/services/entry-prefetch-plan";
import type { Entry, Feed } from "@/types/api";

const mockNeedsTranslation = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/language-detect-async", () => ({
  needsTranslation: mockNeedsTranslation,
}));

const ctx = (over: Partial<PrefetchContext> = {}): PrefetchContext => ({
  autoReadability: false,
  autoSummary: false,
  autoTranslate: false,
  targetLanguage: "zh-CN",
  ...over,
});

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

const feed = (over: Partial<Feed> = {}): Feed => ({
  id: "f1",
  title: "Feed",
  url: "https://example.com",
  type: "article",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  ...over,
});

describe("resolvePrefetchPlan", () => {
  it("全关（没配过的订阅）", () => {
    expect(resolvePrefetchPlan(entry(), undefined, ctx())).toEqual({
      readerMode: false,
      autoSummary: false,
      autoTranslate: false,
    });
  });

  it("订阅级 readerMode 覆盖全局", () => {
    const context = ctx({ autoReadability: true });
    expect(resolvePrefetchPlan(entry(), feed({ readerMode: false }), context).readerMode).toBe(false);
    expect(resolvePrefetchPlan(entry(), feed({ readerMode: true }), ctx()).readerMode).toBe(true);
    // 没有订阅级设置就跟随全局
    expect(resolvePrefetchPlan(entry(), feed(), context).readerMode).toBe(true);
  });

  it("摘要：条目级规则标记最大，订阅级次之，全局垫底", () => {
    const context = ctx({ autoSummary: true });
    // 条目级开着，其他全关
    expect(
      resolvePrefetchPlan(entry({ autoSummary: true }), undefined, ctx()).autoSummary,
    ).toBe(true);
    // 条目级显式 false 不压过全局 true（正文页就是这个口径：`entry.autoSummary ? true : ...`，
    // false 落回订阅级/全局那一支）
    expect(
      resolvePrefetchPlan(
        entry({ autoSummary: false }),
        undefined,
        ctx({ autoSummary: true }),
      ).autoSummary,
    ).toBe(true);
    expect(
      resolvePrefetchPlan(entry(), feed({ autoSummary: true }), ctx()).autoSummary,
    ).toBe(true);
    expect(
      resolvePrefetchPlan(entry(), feed({ autoSummary: false }), context).autoSummary,
    ).toBe(false);
  });

  it("翻译：条目级 > 订阅级 > AI 全局（与摘要同一口径）", () => {
    expect(
      resolvePrefetchPlan(entry({ autoTranslate: true }), undefined, ctx()).autoTranslate,
    ).toBe(true);
    expect(
      resolvePrefetchPlan(entry(), undefined, ctx({ autoTranslate: true })).autoTranslate,
    ).toBe(true);
    // 订阅级 true：正文页现在也翻（用户 2026-10-10 拍板），预载必须跟着翻
    expect(
      resolvePrefetchPlan(entry(), feed({ autoTranslate: true }), ctx()).autoTranslate,
    ).toBe(true);
    // 订阅级 false 压过全局 true
    expect(
      resolvePrefetchPlan(
        entry(),
        feed({ autoTranslate: false }),
        ctx({ autoTranslate: true }),
      ).autoTranslate,
    ).toBe(false);
  });

  it("hasAnyPrefetch 三态全关才为 false", () => {
    expect(hasAnyPrefetch({ readerMode: false, autoSummary: false, autoTranslate: false })).toBe(false);
    expect(hasAnyPrefetch({ readerMode: true, autoSummary: false, autoTranslate: false })).toBe(true);
  });
});

describe("buildPrefetchTask", () => {
  it("三态全关 → 不产出任务（绝大多数条目走这条）", () => {
    const task = buildPrefetchTask({
      entry: entry(),
      feed: undefined,
      context: ctx(),
      run: async () => undefined,
    });
    expect(task).toBeNull();
  });

  it("三态里任一为真 → 产出任务，key 按条目且不重复", () => {
    const first = buildPrefetchTask({
      entry: entry(),
      feed: undefined,
      context: ctx({ autoReadability: true }),
      run: async () => undefined,
    });
    const second = buildPrefetchTask({
      entry: entry(),
      feed: undefined,
      context: ctx({ autoReadability: true }),
      run: async () => undefined,
    });
    expect(first?.key).toBe(prefetchKey("1"));
    expect(first?.entryId).toBe("1");
    expect(first?.key).toBe(second?.key);
  });

  it("没有 url 也没有内容 → 不产出任务（抓不到也摘要不了）", () => {
    const task = buildPrefetchTask({
      entry: entry({ url: undefined, content: undefined }),
      feed: feed({ readerMode: true }),
      context: ctx(),
      run: async () => undefined,
    });
    expect(task).toBeNull();
  });

  it("任务 run 把 plan 原样传下去", async () => {
    const seen: unknown[] = [];
    const task = buildPrefetchTask({
      entry: entry(),
      feed: undefined,
      context: ctx({ autoSummary: true }),
      run: async (args) => {
        seen.push(args);
      },
    });
    const controller = new AbortController();
    await task!.run(controller.signal);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      plan: { readerMode: false, autoSummary: true, autoTranslate: false },
    });
  });
});

describe("摘要 / 翻译的可行性判断", () => {
  it("没有内容就不预载摘要", () => {
    expect(summaryWorthPrefetching(entry())).toBe(true);
    expect(
      summaryWorthPrefetching(entry({ content: undefined, readableContent: undefined })),
    ).toBe(false);
  });

  it("原文已是目标语言就不预载翻译（省一次白跑的模型请求）", async () => {
    mockNeedsTranslation.mockResolvedValue(false);
    await expect(translateWorthPrefetching(entry(), "zh-CN")).resolves.toBe(
      false,
    );
    mockNeedsTranslation.mockResolvedValue(true);
    await expect(translateWorthPrefetching(entry(), "zh-CN")).resolves.toBe(
      true,
    );
    // 没有任何正文 → 跳过
    await expect(
      translateWorthPrefetching(
        entry({ content: undefined, readableContent: undefined }),
        "zh-CN",
      ),
    ).resolves.toBe(false);
  });
});