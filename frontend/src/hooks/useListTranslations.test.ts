/**
 * 列表主动翻译的纯逻辑单测（54-9 重做后的取数层）。
 *
 * 这里**不挂 React**（hook 本体只在 EntryList 里接一次），只钉三件最容易出错、
 * 又最要紧的语义：
 *   1. **谁该被翻**：自动翻译三态（条目级 > 订阅级 > 全局）、用户手动关掉、
 *      store 已有译文、没有正文 —— 任意一条不满足就不进候选（不发请求）；
 *   2. **不重复发**：本次会话已经 warm 过的条目不再进候选（滚出再滚回来不重翻）；
 *   3. **写回只补不覆盖**：正文页正在流式写的同一条译文不能被列表盖回去。
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyCachedTranslations,
  planListTranslationWarmTargets,
  pickTranslationCandidates,
} from "@/hooks/useListTranslations";
import { translationActions, useTranslationStore } from "@/stores/translation-store";
import type { Entry, Feed } from "@/types/api";

function entry(id: string, feedId = "f1", content = "<p>hello</p>"): Entry {
  return { id, feedId, content, title: `t${id}` } as Entry;
}

function feed(id: string, autoTranslate?: boolean | null): Feed {
  return { id, title: `feed-${id}`, autoTranslate } as Feed;
}

function plan(
  entries: Entry[],
  feeds: Map<string, Feed>,
  autoTranslate: boolean,
  alreadyWarmed: ReadonlySet<string> = new Set<string>(),
): string[] {
  return planListTranslationWarmTargets({
    entries,
    feedsById: feeds,
    autoTranslate,
    targetLanguage: "zh-CN",
    alreadyWarmed,
  }).map((target) => target.entry.id);
}

beforeEach(() => {
  useTranslationStore.setState({ data: {}, disabled: new Set<string>() });
});

describe("planListTranslationWarmTargets：谁该被列表主动翻", () => {
  it("全局关闭时不挑任何条目", () => {
    expect(plan([entry("1"), entry("2")], new Map(), false)).toEqual([]);
  });

  it("全局开启时按列表顺序挑出所有有正文的条目", () => {
    expect(plan([entry("1"), entry("2")], new Map(), true)).toEqual(["1", "2"]);
  });

  it("订阅级 false 覆盖全局 true（关掉的订阅不翻）", () => {
    const feeds = new Map([
      ["f1", feed("f1", false)],
      ["f2", feed("f2", true)],
    ]);
    expect(
      plan([entry("1", "f1"), entry("2", "f2")], feeds, true),
    ).toEqual(["2"]);
  });

  it("订阅级 true 覆盖全局 false（只配了翻译的订阅也要在列表里翻）", () => {
    const feeds = new Map([["f1", feed("f1", true)]]);
    expect(plan([entry("1", "f1"), entry("2", "f2")], feeds, false)).toEqual([
      "1",
    ]);
  });

  it("条目级 true 短路：订阅级/全局都关也翻", () => {
    const feeds = new Map([["f1", feed("f1", false)]]);
    expect(plan([{ ...entry("1"), autoTranslate: true }], feeds, false)).toEqual([
      "1",
    ]);
  });

  it("用户手动关掉翻译的条目不挑", () => {
    translationActions.disable("2");
    expect(plan([entry("1"), entry("2")], new Map(), true)).toEqual(["1"]);
  });

  it("store 里已有译文的条目不重复挑", () => {
    translationActions.set("1", "zh-CN", { content: "<p>译文</p>" });
    expect(plan([entry("1"), entry("2")], new Map(), true)).toEqual(["2"]);
  });

  it("本次会话已经 warm 过的条目不重复挑（滚出再滚回来不重翻）", () => {
    expect(plan([entry("1"), entry("2")], new Map(), true, new Set(["1"]))).toEqual([
      "2",
    ]);
  });

  it("没有正文的条目不挑（没东西可翻）", () => {
    expect(plan([{ ...entry("1"), content: "" }], new Map(), true)).toEqual([]);
  });

  it("挑出来的目标带**源正文**（卡片读的是 isReadability=false 这个槽）", () => {
    const targets = planListTranslationWarmTargets({
      entries: [entry("1", "f1", "<p>body</p>")],
      feedsById: new Map(),
      autoTranslate: true,
      targetLanguage: "zh-CN",
      alreadyWarmed: new Set<string>(),
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.content).toBe("<p>body</p>");
  });
});

describe("pickTranslationCandidates（兼容旧入口）", () => {
  it("与 planListTranslationWarmTargets 在 8 种三态组合上完全一致", () => {
    for (const feedAuto of [true, false, null, undefined] as const) {
      for (const globalAuto of [true, false]) {
        for (const entryAuto of [true, false, undefined] as const) {
          const e = entry("1", "f1");
          (e as { autoTranslate?: boolean }).autoTranslate = entryAuto;
          const feeds = new Map([["f1", feed("f1", feedAuto)]]);
          expect(
            pickTranslationCandidates([e], feeds, globalAuto, "zh-CN", false),
            `feed=${feedAuto} global=${globalAuto} entry=${entryAuto}`,
          ).toEqual(plan([e], feeds, globalAuto));
        }
      }
    }
  });
});

describe("applyCachedTranslations", () => {
  it("把译文写进 store，按 isReadability 分槽", () => {
    const applied = applyCachedTranslations(
      { "1": { content: "<p>译文一</p>" } },
      "zh-CN",
      false,
    );
    expect(applied).toBe(1);
    expect(translationActions.get("1", "zh-CN", false)?.content).toBe(
      "<p>译文一</p>",
    );
    // 可读模式是另一个槽，不该被写上
    expect(translationActions.get("1", "zh-CN", true)).toBeUndefined();
  });

  it("只补不覆盖：已有译文保持原样（正文页的流式结果不被列表盖掉）", () => {
    translationActions.set("1", "zh-CN", { content: "<p>正文页的译文</p>" });
    const applied = applyCachedTranslations(
      { "1": { content: "<p>列表批量拿到的旧译文</p>" } },
      "zh-CN",
      false,
    );
    expect(applied).toBe(0);
    expect(translationActions.get("1", "zh-CN", false)?.content).toBe(
      "<p>正文页的译文</p>",
    );
  });

  it("空 content 不写（免得用空串盖掉原文）", () => {
    const applied = applyCachedTranslations(
      { "1": { content: "" } },
      "zh-CN",
      false,
    );
    expect(applied).toBe(0);
    expect(translationActions.get("1", "zh-CN", false)).toBeUndefined();
  });
});
