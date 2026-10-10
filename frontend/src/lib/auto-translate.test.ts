/**
 * 自动翻译三态口径的单测。权威就是这段口诀：
 *   条目级 > 订阅级 > AI 全局（与 autoSummary 对齐）
 * 错了就是「订阅开着却不翻」或「没配却白翻一趟」。
 */

import { describe, it, expect } from "vitest";
import { resolveEntryAutoTranslate } from "@/lib/auto-translate";

describe("resolveEntryAutoTranslate", () => {
  it("条目级 true 压过订阅级 false / 全局 false", () => {
    expect(
      resolveEntryAutoTranslate({
        entry: { autoTranslate: true },
        feed: { autoTranslate: false },
        aiSettings: { autoTranslate: false },
      }),
    ).toBe(true);
  });

  it("订阅级 true 压过全局 false", () => {
    expect(
      resolveEntryAutoTranslate({
        entry: {},
        feed: { autoTranslate: true },
        aiSettings: { autoTranslate: false },
      }),
    ).toBe(true);
  });

  it("订阅级 false 压过全局 true", () => {
    expect(
      resolveEntryAutoTranslate({
        entry: {},
        feed: { autoTranslate: false },
        aiSettings: { autoTranslate: true },
      }),
    ).toBe(false);
  });

  it("两边都没有就跟随全局", () => {
    expect(
      resolveEntryAutoTranslate({
        entry: {},
        feed: { autoTranslate: null },
        aiSettings: { autoTranslate: true },
      }),
    ).toBe(true);
    expect(
      resolveEntryAutoTranslate({
        entry: {},
        feed: null,
        aiSettings: { autoTranslate: false },
      }),
    ).toBe(false);
  });

  it("条目级 false 不压过订阅级/全局（与 autoSummary 同一口径）", () => {
    expect(
      resolveEntryAutoTranslate({
        entry: { autoTranslate: false },
        feed: { autoTranslate: true },
        aiSettings: { autoTranslate: false },
      }),
    ).toBe(true);
  });

  it("全都没有 → false", () => {
    expect(
      resolveEntryAutoTranslate({ entry: null, feed: null, aiSettings: null }),
    ).toBe(false);
  });
});