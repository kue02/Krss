/**
 * 「社交 / 通知视图的列表里**主动翻译并直接显示**」的唯一接入点（54-9）。
 *
 * ## 为什么是「主动」而不是「只读缓存」
 *
 * 54-2 的实现是**只读缓存**：列表批量调 `POST /ai/translations/batch` 把已经翻好的
 * 译文取回来显示。但缓存里有没有译文，取决于**订阅三态 + 滚动预载**恰好把这条翻过 ——
 * 用户滚动列表时绝大多数条目从来没被预载过，于是列表里一直是原文，
 * 表现就是「这个功能等于没做」（用户 2026-10-20 原话：
 * 「就是要列表主动翻译，只限社交媒体、通知视图……直接在列表就看了」）。
 *
 * ## 现在的口径：列表自己发起翻译
 *
 * 1. **决策**：`planListTranslationWarmTargets()` 挑出「三态生效 + 有正文 + 用户没关 +
 *    store 里还没译文 + 本次会话没发过」的条目，按列表顺序排队；
 * 2. **触发**：走**与预载同一套** `POST /ai/translate/warm`（202 立即返回，真正的翻译
 *    在后端后台跑）。**绝不**在列表里开 `/ai/translate` SSE —— 同源 HTTP/1.1 只有
 *    6 条并发，第 6 条一开设置页就卡 45 秒（§2.50 实测）；
 * 3. **有界在飞**：warm 是 fire-and-forget，并发池限不住后端压力 —— 一屏 50 条全发出去
 *    就是 50 个后台翻译任务同时跑（免费通道会直接被限流）。这里用**在飞上限**
 *    （并发档位 × 2）卡住；一条翻好被收回，**立刻**补下一条（不等固定节拍）；
 * 4. **回收**：每 `POLL_INTERVAL_MS` 把在飞的批量读一次缓存，读到就写进
 *    `translation-store`（卡片立刻换成译文）；超时仍未出译文就放弃（下次进列表重来）。
 *
 * ## 四条硬边界
 *
 * - **顺序优先**：按列表顺序翻，先看到的先出译文；
 * - **只补不覆盖**：写 store 时跳过已有译文（正文页可能正在流式写同一条）；
 * - **全程静默**：失败不弹 toast（打开路径那两条提示原样保留）；
 * - **可取消**：换列表 / 换视图 / 卸载 ⇒ 清账本、停轮询、旧回调自我作废。
 */

import { useEffect, useMemo, useRef } from "react";
import { fetchCachedTranslations, warmTranslate } from "@/api";
import { translationActions } from "@/stores/translation-store";
import { resolveEntryAutoTranslate } from "@/lib/auto-translate";
import { translateWorthPrefetching } from "@/services/entry-prefetch-plan";
import type { Entry, Feed } from "@/types/api";

/** 单批读上限：与后端 `aiTranslationBatchLimit`（200）对齐，列表一屏 50 够用 */
const BATCH_SIZE = 50;
/** 默认并发档位（沿用设置里的「预载并发」） */
export const DEFAULT_LIST_TRANSLATE_CONCURRENCY = 3;
export const MAX_LIST_TRANSLATE_CONCURRENCY = 5;
/** 每个并发档位允许几条同时在飞（warm 是 fire-and-forget，必须自己卡住后端压力） */
const INFLIGHT_PER_WORKER = 2;
/** 收译文轮询间隔：批量读是一次毫秒级往返，1.5s 让「一条条变译文」看起来是连续的 */
const POLL_INTERVAL_MS = 1500;
/** 单条等结果的上限：超过就放弃（不无限轮询；下次进列表/换页会重来） */
const RESULT_TIMEOUT_MS = 3 * 60 * 1000;
/** 空集合常量：当「没发过」的默认账本用（避免每次新建 Set） */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

interface UseListTranslationsOptions {
  /** 当前列表里的条目（顺序即优先级，靠前的先翻） */
  entries: Entry[];
  /** feedId → feed（订阅级 autoTranslate 覆盖） */
  feedsById: Map<string, Feed>;
  /** 全局 autoTranslate（AI 设置） */
  autoTranslate: boolean;
  /** 目标语言（= ai.summary_language） */
  targetLanguage: string;
  /** 总开关：关掉就完全不发请求 */
  enabled: boolean;
  /** 换列表 / 换视图时变，用来把本轮在跑的一切撤掉 */
  resetKey: string;
  /** 并发档位（沿用「预载并发」设置项，1~5） */
  concurrency?: number;
}

/** 一条「该由列表主动去翻」的条目（纯数据，便于单测直接断言） */
export interface ListTranslationWarmTarget {
  entry: Entry;
  /** 送进 warm 的正文（= 源正文；与卡片读数槽 `isReadability=false` 对齐） */
  content: string;
}

/**
 * 挑出本轮要主动翻译的条目（**纯函数**，不碰网络、不碰 store 的响应式）。
 *
 * 口径与卡片「读数门」共用 `resolveEntryAutoTranslate`（条目级 > 订阅级 > 全局），
 * 避免出现「列表翻了却不显示 / 显示了却没人翻」的错位。
 */
export function planListTranslationWarmTargets(options: {
  entries: Entry[];
  feedsById: Map<string, Feed>;
  autoTranslate: boolean;
  targetLanguage: string;
  /** 本次会话**已经发过** warm 的条目（滚出再滚回来不重复发） */
  alreadyWarmed: ReadonlySet<string>;
}): ListTranslationWarmTarget[] {
  const { entries, feedsById, autoTranslate, targetLanguage, alreadyWarmed } =
    options;
  const out: ListTranslationWarmTarget[] = [];
  for (const entry of entries) {
    if (alreadyWarmed.has(entry.id)) continue;
    const feed = feedsById.get(entry.feedId);
    if (
      !resolveEntryAutoTranslate({
        entry,
        feed,
        aiSettings: { autoTranslate },
      })
    ) {
      continue;
    }
    // 用户在这一条上手动关掉翻译（正文页那颗开关）⇒ 列表也不翻
    if (translationActions.isDisabled(entry.id)) continue;
    // store 里已经有译文（正文页流式写的 / 上一轮收回来的）⇒ 不重复发
    const cached = translationActions.get(entry.id, targetLanguage, false);
    if (cached?.content) continue;
    const content = entry.content ?? "";
    if (!content.trim()) continue;
    out.push({ entry, content });
  }
  return out;
}

/**
 * 写回 store：**只补不覆盖**。
 * 正文页（`useAITranslation`）可能正在流式写同一条，列表这轮读到的可能是更早的版本。
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
    translationActions.set(
      entryId,
      targetLanguage,
      { content: item.content },
      isReadability,
    );
    applied += 1;
  }
  return applied;
}

/**
 * 兼容旧名字（54-2 的候选挑选；54-9 起由 `planListTranslationWarmTargets` 取代）。
 * 保留它是因为 `list-translation-gate.test.ts` 用它在 8 种三态组合上钉「读数门 == 取数门」。
 */
export function pickTranslationCandidates(
  entries: Entry[],
  feedsById: Map<string, Feed>,
  autoTranslate: boolean,
  targetLanguage: string,
  isReadabilityActive: boolean,
): string[] {
  void isReadabilityActive;
  return planListTranslationWarmTargets({
    entries,
    feedsById,
    autoTranslate,
    targetLanguage,
    alreadyWarmed: EMPTY_ID_SET,
  }).map((target) => target.entry.id);
}

function clampConcurrency(value: number | undefined): number {
  const raw = value ?? DEFAULT_LIST_TRANSLATE_CONCURRENCY;
  if (!Number.isFinite(raw)) return DEFAULT_LIST_TRANSLATE_CONCURRENCY;
  return Math.min(
    MAX_LIST_TRANSLATE_CONCURRENCY,
    Math.max(1, Math.round(raw)),
  );
}

/** 在飞上限：并发档位 × 每档 2 条（3 档 ⇒ 6 条同时在后台翻） */
export function listTranslationInflightLimit(concurrency?: number): number {
  return clampConcurrency(concurrency) * INFLIGHT_PER_WORKER;
}

interface HookState {
  /** 本轮（同一次进列表）已经发过 warm 的条目 */
  warmed: Set<string>;
  /** 发了 warm、还没收到译文的条目 → 发起时间 */
  awaiting: Map<string, number>;
  /** 待发队列（按列表顺序；新条目追加在尾部） */
  queue: ListTranslationWarmTarget[];
  /** 换列表/换视图时自增：旧一轮的回调据此自我作废 */
  generation: number;
}

/**
 * 列表主动翻译钩子（社交视图 / 通知视图专用）。
 *
 * 与 `useEntryPrefetch` 的分工：预载仍然是**统一入口**（正文 / 摘要 / 翻译三件事都做，
 * 翻译按阅读模式走可读正文）；本钩子只补「列表这一层必须把译文显示出来」这一件事，
 * 并且**一定**用源正文（`isReadability=false`）—— 因为卡片读的就是这个槽。
 * 两边都调 warm 不会翻两遍：后端 `WarmTranslation` 有 single-flight。
 */
export function useListTranslations({
  entries,
  feedsById,
  autoTranslate,
  targetLanguage,
  enabled,
  resetKey,
  concurrency,
}: UseListTranslationsOptions): void {
  const stateRef = useRef<HookState>({
    warmed: new Set<string>(),
    awaiting: new Map<string, number>(),
    queue: [],
    generation: 0,
  });
  /** 收译文定时器（自调度，不是 setInterval —— 避免上一轮还没回来就叠下一轮） */
  const pollTimerRef = useRef<number | null>(null);
  /** 回调里要读**此刻**的语言/并发，不能拿 effect 闭包里那份快照 */
  const latestRef = useRef({ targetLanguage, concurrency });
  useEffect(() => {
    latestRef.current = { targetLanguage, concurrency };
  }, [targetLanguage, concurrency]);

  /**
   * 候选在**每次条目集合变化时**现算；「本次会话已发过」的去重交给 effect
   * （不在渲染期读 ref —— 那既是 `react-hooks/refs` 的违规，也会让 memo 依赖失真）。
   * 列表加载下一页 / 刷新带来新条目 ⇒ `entries` 变 ⇒ 这里重算 ⇒ effect 把新的一批推入队列。
   */
  const targets = useMemo(
    () =>
      enabled && targetLanguage
        ? planListTranslationWarmTargets({
            entries,
            feedsById,
            autoTranslate,
            targetLanguage,
            alreadyWarmed: EMPTY_ID_SET,
          })
        : [],
    [entries, feedsById, autoTranslate, targetLanguage, enabled],
  );

  // 换列表 / 换视图：清账本、停轮询（旧回调靠 generation 自我作废）
  useEffect(() => {
    const state = stateRef.current;
    state.generation += 1;
    state.warmed.clear();
    state.awaiting.clear();
    state.queue = [];
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, [resetKey]);

  // 卸载时收干净
  useEffect(
    () => () => {
      stateRef.current.generation += 1;
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !targetLanguage || targets.length === 0) return;
    const state = stateRef.current;
    const generation = state.generation;

    const alive = (): boolean =>
      stateRef.current.generation === generation &&
      latestRef.current.targetLanguage === targetLanguage;

    const clearTimer = (): void => {
      if (pollTimerRef.current === null) return;
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };

    /**
     * 调度核心：补满在飞槽位 → 还有活就预约下一轮回收，没活了就停。
     * 任何「槽位空出来了」的时刻都调它（warm 发完、检测判定不用翻、一轮回收结束），
     * 所以吞吐是按「翻好一条立刻补一条」走的，而不是被固定节拍拖住。
     */
    const pump = (): void => {
      if (!alive()) return;
      const limit = listTranslationInflightLimit(latestRef.current.concurrency);
      const current = stateRef.current;

      while (
        current.awaiting.size < limit &&
        current.queue.length > 0 &&
        alive()
      ) {
        const next = current.queue.shift();
        if (!next) break;
        // 入队到真正发之间可能已被别的路径写进 store（正文页流式翻译）
        if (
          translationActions.get(
            next.entry.id,
            latestRef.current.targetLanguage,
            false,
          )?.content
        ) {
          continue;
        }
        current.awaiting.set(next.entry.id, Date.now());
        void sendWarm(next);
      }

      // 有在飞的就继续按节拍回收；队列空了且没有在飞 ⇒ 收工
      if (current.awaiting.size === 0 && current.queue.length === 0) {
        clearTimer();
        return;
      }
      if (pollTimerRef.current !== null) return;
      pollTimerRef.current = window.setTimeout(() => {
        pollTimerRef.current = null;
        void collectOnce();
      }, POLL_INTERVAL_MS);
    };

    /**
     * 真正发一条 warm。语言检测判定「本来就不用翻」或请求发不出去 ⇒ 立刻释放槽位
     * 并 pump（不能干等下一个节拍，否则一屏里大量中文条目会把队列拖成龟速）。
     */
    const sendWarm = async (
      target: ListTranslationWarmTarget,
    ): Promise<void> => {
      const release = (): void => {
        stateRef.current.awaiting.delete(target.entry.id);
        pump();
      };
      let worth: boolean;
      try {
        // 异步检测（ELD 走动态 import，不能进主包）
        worth = await translateWorthPrefetching(
          target.entry,
          latestRef.current.targetLanguage,
        );
      } catch {
        worth = true; // 检测本身失败就别白丢一次机会，交给后端翻
      }
      if (!alive()) return;
      if (!worth) {
        release();
        return;
      }
      try {
        await warmTranslate({
          entryId: target.entry.id,
          content: target.content,
          title: target.entry.title ?? undefined,
          // isReadability=false：卡片读的就是这个槽（见文件头）
          isReadability: false,
        });
      } catch {
        release();
        return;
      }
      if (!alive()) return;
      // warm 只是「任务已起」，译文还没好 —— 留在在飞表里等回收
    };

    /** 一轮回收：把在飞条目里已经翻好的读回来，然后补槽位 */
    const collectOnce = async (): Promise<void> => {
      if (!alive()) return;
      const ids = [...stateRef.current.awaiting.keys()];
      const language = latestRef.current.targetLanguage;
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const slice = ids.slice(i, i + BATCH_SIZE);
        try {
          const response = await fetchCachedTranslations(slice, false);
          if (!alive()) return;
          applyCachedTranslations(response.translations, language, false);
          for (const entryId of Object.keys(response.translations)) {
            stateRef.current.awaiting.delete(entryId);
          }
        } catch {
          // 读失败不打扰用户：下一轮再试，卡片照旧显示原文
        }
      }
      // 等太久的丢掉，别无限占坑（后端翻失败 / 通道限流时会出现）
      const now = Date.now();
      for (const [entryId, requestedAt] of [...stateRef.current.awaiting]) {
        if (now - requestedAt > RESULT_TIMEOUT_MS) {
          stateRef.current.awaiting.delete(entryId);
        }
      }
      pump();
    };

    // 新条目追加到队尾；同一条不重复入队
    const queued = new Set(state.queue.map((target) => target.entry.id));
    for (const target of targets) {
      if (state.warmed.has(target.entry.id)) continue;
      if (queued.has(target.entry.id)) continue;
      state.warmed.add(target.entry.id);
      state.queue.push(target);
      queued.add(target.entry.id);
    }
    pump();
  }, [targets, enabled, targetLanguage]);
}
