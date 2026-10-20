/**
 * 「列表里的条目直接显示译文」的取数层（54-2）。
 *
 * 三条硬边界（改这个文件前先读一遍）：
 *
 * 1. **只读缓存，绝不发翻译请求**。列表里出现几十条条目，绝不能对每条开一条
 *    `/ai/translate` SSE —— 浏览器对同源 HTTP/1.1 只给 6 条并发，第 6 条一开
 *    整个界面就堵死（§2.50 实测 `/api/settings/ai` 卡 45.6 秒）。译文本来就由
 *    滚动预载 `POST /ai/translate/warm` 在后台算好落库，这里只把结果批量取回来。
 *
 * 2. **没缓存就显示原文**。后端不返回没翻过的条目，前端不做任何「等它翻好」的
 *    占位 —— 卡片立刻可读，等下一次批量拉取时自然补上。
 *
 * 3. **只补不覆盖**。写回 `translation-store` 时跳过已有译文的条目：正文页
 *    （`useAITranslation`）可能正在流式写同一份缓存，列表这次批量拉到的可能是
 *    更早的版本，别把它覆盖回去。
 */

import { useEffect, useMemo, useRef } from "react";
import { fetchCachedTranslations } from "@/api";
import { translationActions } from "@/stores/translation-store";
import type { Entry, Feed } from "@/types/api";

/** 单批上限：与后端 `aiTranslationBatchLimit`（200）对齐，前端取 50 —— 一屏够用，
 *  且不会让列表刚打开就发一个巨大的请求。 */
const BATCH_SIZE = 50;
/** 同一批 id 在这么长时间内不重复请求（预载落库需要时间，几分钟后的重拉才有意义） */
const REFETCH_AFTER_MS = 3 * 60 * 1000;

interface UseListTranslationsOptions {
  /** 当前列表里的条目（顺序即优先级，靠前的先取） */
  entries: Entry[];
  /** feedId → feed（订阅级 autoTranslate 覆盖） */
  feedsById: Map<string, Feed>;
  /** 全局 autoTranslate（AI 设置） */
  autoTranslate: boolean;
  /** 目标语言（= ai.summary_language） */
  targetLanguage: string;
  /** 总开关：关掉就完全不发请求 */
  enabled: boolean;
  /** 换列表 / 换视图时变，用来把在飞的请求撤掉 */
  resetKey: string;
}

/** 一批 id 的指纹，用于「这批已经取过」的账本 */
function batchKey(ids: string[], isReadability: boolean): string {
  return `${isReadability ? "r" : "n"}:${ids.join(",")}`;
}

/**
 * 把译文写进 store。
 * 只补不覆盖 —— 已有 content 的条目跳过（见文件头第 3 条）。
 */
export function applyCachedTranslations(
  translations: Record<string, { content: string }>,
  targetLanguage: string,
  isReadability: boolean,
): number {
  let applied = 0;
  for (const [entryId, item] of Object.entries(translations)) {
    if (!item?.content) continue;
    const existing = translationActions.get(entryId, targetLanguage, isReadability);
    if (existing?.content) continue;
    translationActions.set(entryId, targetLanguage, { content: item.content }, isReadability);
    applied += 1;
  }
  return applied;
}

/**
 * 挑出「这一批该取译文」的条目 id：
 *   - 自动翻译三态生效（条目级 > 订阅级 > 全局，走与预载同一份解析器）
 *   - 用户没有对这条手动关掉翻译
 *   - store 里还没有译文
 *   - 这条有多媒体之外的正文可翻（社交短贴也要翻，所以只要求有 content）
 */
export function pickTranslationCandidates(
  entries: Entry[],
  feedsById: Map<string, Feed>,
  autoTranslate: boolean,
  targetLanguage: string,
  isReadabilityActive: boolean,
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const feed = feedsById.get(entry.feedId);
    // 与 entry-prefetch-plan 同一口径：订阅级覆盖 > 全局（条目级标记由正文页处理，这里先不短路）
    const enabled = feed?.autoTranslate ?? autoTranslate;
    if (!enabled) continue;
    if (!entry.content && !entry.readableContent) continue;
    if (translationActions.isDisabled(entry.id)) continue;
    const cached = translationActions.get(entry.id, targetLanguage, isReadabilityActive);
    if (cached?.content) continue;
    out.push(entry.id);
  }
  return out;
}

/**
 * 列表译文取数钩子。
 *
 * 行为和 `useEntryPrefetch` 是**协作**关系而不是替代：
 *   - 预载负责「把译文算出来」（warm，后台）；
 *   - 本钩子负责「已经算好的取回来显示」。
 * 所以本钩子在列表打开后、以及条目集合变化后各跑一次，几秒后可能落库的新译文
 * 由下一轮触发（换页 / 刷新 / 重新进列表）。
 */
export function useListTranslations({
  entries,
  feedsById,
  autoTranslate,
  targetLanguage,
  enabled,
  resetKey,
}: UseListTranslationsOptions): void {
  /** 已经取过的批次指纹 → 取的时间（毫秒） */
  const fetchedRef = useRef(new Map<string, number>());
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 候选条目在**每次渲染时现算**（不订阅 store）。
   *
   * 曾经订阅过 `useTranslationStore(state => state.data)` 想在写回后重算，
   * 但那会逼所有用到 `EntryList` 的测试都去补 store mock，而收益是零：
   * 「同一批不重复请求」由下面的 `fetchedRef` 指纹账本管着，写回与否都一样。
   */
  const candidates = useMemo(() => {
    if (!enabled || !targetLanguage) return [];
    return pickTranslationCandidates(
      entries,
      feedsById,
      autoTranslate,
      targetLanguage,
      false,
    );
  }, [entries, feedsById, autoTranslate, targetLanguage, enabled]);

  useEffect(() => {
    if (!enabled || !targetLanguage || candidates.length === 0) return;

    // 按批切分，跳过「最近已经取过」的批次
    const now = Date.now();
    const batches: string[][] = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const slice = candidates.slice(i, i + BATCH_SIZE);
      const key = batchKey(slice, false);
      const last = fetchedRef.current.get(key);
      if (last && now - last < REFETCH_AFTER_MS) continue;
      batches.push(slice);
    }
    if (batches.length === 0) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    void (async () => {
      for (const batch of batches) {
        if (controller.signal.aborted) return;
        try {
          const resp = await fetchCachedTranslations(batch, false, controller.signal);
          if (controller.signal.aborted) return;
          fetchedRef.current.set(batchKey(batch, false), Date.now());
          applyCachedTranslations(resp.translations, targetLanguage, false);
        } catch (error) {
          // 批量读失败不打扰用户（卡片照旧显示原文，下一轮再试），但**必须留痕**：
          // 这条静默 catch 曾经吃掉过一个「路由少写 /api 前缀 → 404」的真 bug，
          // 表现为「功能完全不生效、控制台一片安静」（54-6 实测踩到）。
          if (import.meta.env.DEV) {
            console.warn("[54] batch cached translations failed", error);
          }
        }
      }
    })();

    return () => controller.abort();
  }, [candidates, enabled, targetLanguage]);

  // 换列表时把账本清掉：新列表里的条目是另一批，旧指纹没意义
  useEffect(() => {
    fetchedRef.current.clear();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [resetKey]);
}
