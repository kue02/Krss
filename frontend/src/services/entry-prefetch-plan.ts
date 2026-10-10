/**
 * 「这条要不要预载、按什么顺序预载」的纯判定层。
 *
 * 三态的生效口径**照抄** `components/entry-content/EntryContent.tsx` 里正文页用的那套
 * （订阅级覆盖 > 全局；条目级规则标记最大），不在这里另立一套 —— 预载算错了，
 * 打开时的行为就得跟着变，那不是本卡该碰的。
 */

import type { Entry, Feed } from "@/types/api";
import { needsTranslation } from "@/lib/language-detect";
import { stripHtml } from "@/lib/html-utils";
import type { PrefetchTask } from "@/services/prefetch-queue";

/** 三态的生效上下文（取自 useGeneralSettings / useAISettings） */
export interface PrefetchContext {
  /** 通用设置里的「正文打开方式」（对应 generalSettings.autoReadability） */
  autoReadability: boolean;
  /** AI 设置里的自动摘要（aiSettings.autoSummary） */
  autoSummary: boolean;
  /** AI 设置里的自动翻译（aiSettings.autoTranslate） */
  autoTranslate: boolean;
  /** 翻译目标语言（aiSettings.summaryLanguage） */
  targetLanguage: string;
}

export interface PrefetchPlan {
  readerMode: boolean;
  autoSummary: boolean;
  autoTranslate: boolean;
}

/**
 * 一条条目最终生效的三态。**口径照抄正文页**（`EntryContent.tsx:91-107`）：
 * - 阅读模式：订阅级 `readerMode` 覆盖 > 全局 `autoReadability`
 * - 摘要：条目级 `autoSummary`（规则动作 summarize 打的）最大 > 订阅级 > AI 全局
 * - 翻译：条目级 `autoTranslate` > AI 全局
 *   （注意正文页这一支没看订阅级 —— 订阅级的 autoTranslate 服务于**列表**的标题/摘要
 *   批量翻译（`EntryList.tsx` 的 `isAutoTranslateEnabled`），不是正文。
 *   预载必须跟正文页一致，否则会出现「预载了正文页却不用」的错位。）
 */
export function resolvePrefetchPlan(
  entry: Pick<Entry, "autoSummary" | "autoTranslate">,
  feed: Pick<Feed, "readerMode" | "autoSummary" | "autoTranslate"> | undefined,
  context: PrefetchContext,
): PrefetchPlan {
  return {
    readerMode: feed?.readerMode ?? context.autoReadability,
    autoSummary: entry.autoSummary
      ? true
      : (feed?.autoSummary ?? context.autoSummary),
    autoTranslate: entry.autoTranslate ?? context.autoTranslate,
  };
}

/** 三态全关 → 这条没什么可预载的（没配过的订阅占绝大多数，先在这里短路） */
export function hasAnyPrefetch(plan: PrefetchPlan): boolean {
  return plan.readerMode || plan.autoSummary || plan.autoTranslate;
}

/**
 * 给一条条目造出预载任务（没开的项不出任务）。
 *
 * 三个请求是**有先后**的：阅读模式先抓正文，后面两件事都用抓回来的正文
 * （与打开路径一致 —— 打开时正文也是先抓完才摘要/翻译）；任一步失败就整条放弃
 * （交给队列的退避重试，重试时后端缓存已经命中过的步骤是秒回）。
 */
export function buildPrefetchTask(options: {
  entry: Entry;
  feed: Pick<Feed, "readerMode" | "autoSummary" | "autoTranslate"> | undefined;
  context: PrefetchContext;
  run: (args: {
    entry: Entry;
    plan: PrefetchPlan;
    signal: AbortSignal;
  }) => Promise<void>;
}): PrefetchTask | null {
  const { entry, feed, context, run } = options;
  const plan = resolvePrefetchPlan(entry, feed, context);
  if (!hasAnyPrefetch(plan)) return null;
  // 三态全关之外，正文/摘要/翻译都至少要有一段内容才谈得上预载
  if (!entry.url && !entry.content && !entry.readableContent) return null;

  return {
    key: prefetchKey(entry.id),
    entryId: entry.id,
    kind: "chain",
    run: (signal) => run({ entry, plan, signal }),
  };
}

/** 任务 key —— 只按条目（同一会话内不重复预载同一条） */
export function prefetchKey(entryId: string): string {
  return `entry-prefetch:${entryId}`;
}

/**
 * 摘要预载的可行性判断：目标语言就是原文语言时没必要跑一趟（对齐 useAITranslation
 * 打开路径里的 `needsTranslation` 判断，少一次白跑的模型请求）。
 */
export function summaryWorthPrefetching(entry: Entry): boolean {
  return Boolean(entry.content || entry.readableContent);
}

export function translateWorthPrefetching(
  entry: Entry,
  targetLanguage: string,
): boolean {
  if (!entry.content && !entry.readableContent) return false;
  const summary = entry.content ? stripHtml(entry.content).slice(0, 200) : null;
  return needsTranslation(entry.title || "", summary, targetLanguage);
}