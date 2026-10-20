/**
 * 54-2 的纯逻辑单测：候选挑选 + 写回 store。
 *
 * 这里**不挂 React**（hook 本体只在 EntryList 里接一次），只断言两条最容易
 * 出错、又最要紧的语义：
 *   1. 自动翻译关掉 / 订阅级关掉 / 用户手动关掉 ⇒ 不进候选（不发请求）
 *   2. 写回时**只补不覆盖** —— 正文页正在流式写的同一条译文不能被列表覆盖回去
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyCachedTranslations,
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

beforeEach(() => {
  useTranslationStore.setState({ data: {}, disabled: new Set<string>() });
});

describe("pickTranslationCandidates", () => {
  it("全局关闭时不挑任何条目", () => {
    const entries = [entry("1"), entry("2")];
    const ids = pickTranslationCandidates(entries, new Map(), false, "zh-CN", false);
    expect(ids).toEqual([]);
  });

  it("全局开启时按列表顺序挑出所有有正文的条目", () => {
    const entries = [entry("1"), entry("2")];
    const ids = pickTranslationCandidates(entries, new Map(), true, "zh-CN", false);
    expect(ids).toEqual(["1", "2"]);
  });

  it("订阅级 false 覆盖全局 true（关掉的订阅不翻）", () => {
    const entries = [entry("1", "f1"), entry("2", "f2")];
    const feeds = new Map([
      ["f1", feed("f1", false)],
      ["f2", feed("f2", true)],
    ]);
    const ids = pickTranslationCandidates(entries, feeds, true, "zh-CN", false);
    expect(ids).toEqual(["2"]);
  });

  it("订阅级 true 覆盖全局 false（只配了翻译的订阅也要在列表里翻）", () => {
    const entries = [entry("1", "f1"), entry("2", "f2")];
    const feeds = new Map([["f1", feed("f1", true)]]);
    const ids = pickTranslationCandidates(entries, feeds, false, "zh-CN", false);
    expect(ids).toEqual(["1"]);
  });

  it("用户手动关掉翻译的条目不挑", () => {
    translationActions.disable("2");
    const entries = [entry("1"), entry("2")];
    const ids = pickTranslationCandidates(entries, new Map(), true, "zh-CN", false);
    expect(ids).toEqual(["1"]);
  });

  it("store 里已有译文的条目不重复挑", () => {
    translationActions.set("1", "zh-CN", { content: "<p>译文</p>" });
    const entries = [entry("1"), entry("2")];
    const ids = pickTranslationCandidates(entries, new Map(), true, "zh-CN", false);
    expect(ids).toEqual(["2"]);
  });

  it("没有正文也没有可读正文的条目不挑（没东西可翻）", () => {
    const entries = [{ ...entry("1"), content: "" } as Entry];
    const ids = pickTranslationCandidates(entries, new Map(), true, "zh-CN", false);
    expect(ids).toEqual([]);
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
    expect(translationActions.get("1", "zh-CN", false)?.content).toBe("<p>译文一</p>");
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
    expect(translationActions.get("1", "zh-CN", false)?.content).toBe("<p>正文页的译文</p>");
  });

  it("空 content 不写（免得用空串盖掉原文）", () => {
    const applied = applyCachedTranslations({ "1": { content: "" } }, "zh-CN", false);
    expect(applied).toBe(0);
    expect(translationActions.get("1", "zh-CN", false)).toBeUndefined();
  });
});
