/**
 * 54-7：**卡片读译文的门必须与取数/预载同一口径**（条目级 > 订阅级 > 全局）。
 *
 * 用户 2026-10-20 报的原话：「没有自动翻译」—— 截图里 Twitter @DeepSeek 的卡片
 * 正文是英文，而库里那条的译文（`🚀 隆重推出 DeepInfer…`）明明存在，且该订阅
 * `auto_translate=1`。根因：`useListTranslations` 按**订阅级覆盖**挑候选、把译文
 * 写进了 store，而 `EntryListItem` / `NotificationTimeline` 读的是**全局**
 * `autoTranslate`（当时为 false）⇒ 译文本在 store 里却读不出来。
 *
 * 这组测试钉的就是「三处判定必须是同一份解析器」这件事：
 * 只看全局会红，只看订阅级会红，必须走 `resolveEntryAutoTranslate`。
 */

import { describe, expect, it } from "vitest";
import { resolveEntryAutoTranslate } from "@/lib/auto-translate";
import { pickTranslationCandidates } from "@/hooks/useListTranslations";
import type { Entry, Feed } from "@/types/api";

function entry(id: string, feedId = "f1", autoTranslate?: boolean | null): Entry {
  return {
    id,
    feedId,
    content: "<p>hello</p>",
    title: `t${id}`,
    autoTranslate,
  } as Entry;
}

function feed(id: string, autoTranslate?: boolean | null): Feed {
  return { id, title: `feed-${id}`, autoTranslate } as Feed;
}

describe("54-7 读数门与取数门同一口径", () => {
  it("全局关 + 订阅级开 ⇒ 要显示译文（用户遇到的那条路径）", () => {
    const e = entry("1", "f1");
    const f = feed("f1", true);
    // 卡片侧的门
    expect(resolveEntryAutoTranslate({ entry: e, feed: f, aiSettings: { autoTranslate: false } })).toBe(true);
    // 取数侧的候选（同一订阅）
    const candidates = pickTranslationCandidates(
      [e],
      new Map([["f1", f]]),
      false,
      "zh-CN",
      false,
    );
    expect(candidates).toEqual(["1"]);
  });

  it("全局开 + 订阅级关 ⇒ 两处都不翻（订阅级覆盖全局）", () => {
    const e = entry("1", "f1");
    const f = feed("f1", false);
    expect(resolveEntryAutoTranslate({ entry: e, feed: f, aiSettings: { autoTranslate: true } })).toBe(false);
    expect(
      pickTranslationCandidates([e], new Map([["f1", f]]), true, "zh-CN", false),
    ).toEqual([]);
  });

  it("条目级 true 短路（规则动作打的标记），订阅级/全局都关也翻", () => {
    const e = entry("1", "f1", true);
    const f = feed("f1", false);
    expect(resolveEntryAutoTranslate({ entry: e, feed: f, aiSettings: { autoTranslate: false } })).toBe(true);
  });

  it("条目级 false 不短路（落回订阅级/全局，与 autoSummary 同口径）", () => {
    const e = entry("1", "f1", false);
    const f = feed("f1", true);
    expect(resolveEntryAutoTranslate({ entry: e, feed: f, aiSettings: { autoTranslate: false } })).toBe(true);
  });

  it("三处全无配置 ⇒ 不翻（默认关闭）", () => {
    const e = entry("1", "f1");
    expect(
      resolveEntryAutoTranslate({ entry: e, feed: undefined, aiSettings: { autoTranslate: false } }),
    ).toBe(false);
    expect(
      pickTranslationCandidates([e], new Map(), false, "zh-CN", false),
    ).toEqual([]);
  });

  it("读数门与取数门在 8 种组合上完全一致（防止将来改回只看全局）", () => {
    for (const feedAuto of [true, false, null, undefined] as const) {
      for (const globalAuto of [true, false]) {
        for (const entryAuto of [true, false, undefined] as const) {
          const e = entry("1", "f1", entryAuto);
          const f = feed("f1", feedAuto);
          const gate = resolveEntryAutoTranslate({
            entry: e,
            feed: f,
            aiSettings: { autoTranslate: globalAuto },
          });
          const candidates = pickTranslationCandidates(
            [e],
            new Map([["f1", f]]),
            globalAuto,
            "zh-CN",
            false,
          );
          expect(
            candidates.length > 0,
            `feed=${feedAuto} global=${globalAuto} entry=${entryAuto}`,
          ).toBe(gate);
        }
      }
    }
  });
});
