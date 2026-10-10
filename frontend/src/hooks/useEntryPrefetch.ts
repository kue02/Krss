/**
 * 「条目进视口就后台预载」的接入层：视口观测 → 入队 → 跑请求 → 写回缓存。
 *
 * 与正文页（`useReadability` / `useAISummary` / `useAITranslation`）的分工：
 * 本 hook 只负责**提前**把活干完，并把结果放到正文页会读的地方：
 *   - 正文 → 后端 `readableContent` 落库 + 写进 react-query 的 `["entry", id]` 与
 *     `["entries"]` 缓存（打开时 `useEntry` 直接命中 ⇒ 零等待）
 *   - 摘要 → 后端 AI 缓存（打开时 `streamSummary` 直接回 `{cached:true}` 秒出）
 *   - 翻译 → 后端 AI 缓存 + `translation-store`（`useAITranslation` 打开时读后者）
 *
 * 全程静默：失败不弹 toast。打开路径上那两条「已自动开启阅读模式 / 正在翻译」
 * 的提示**原样保留** —— 那是「打开」这个动作的交代，不是预载的。
 */

import { useEffect, useRef, type RefObject } from "react";
import { queryClient } from "@/lib/queryClient";
import {
  fetchReadableContent,
  streamSummary,
  streamTranslateBlocks,
  isTranslateInit,
  isTranslateBlockResult,
} from "@/api";
import { PrefetchQueue } from "@/services/prefetch-queue";
import {
  buildPrefetchTask,
  summaryWorthPrefetching,
  translateWorthPrefetching,
  type PrefetchContext,
  type PrefetchPlan,
} from "@/services/entry-prefetch-plan";
import { translationActions } from "@/stores/translation-store";
import type { Entry, Feed } from "@/types/api";

/** 默认并发：正文抓取是网络往返，摘要/翻译是模型往返，都不适合一屏几十条齐发 */
export const DEFAULT_PREFETCH_CONCURRENCY = 2;
/** 上限（设置项档到 5 就不再加了 —— 再高对模型通道没有意义） */
export const MAX_PREFETCH_CONCURRENCY = 5;

/** 视口预热距离：比 `useScrollMarkRead` 的判定带更远，让请求在用户点到之前就跑完 */
const PREFETCH_ROOT_MARGIN = "400px 0px";

interface UseEntryPrefetchOptions {
  /** 列表里已加载的条目（按列表顺序，顺序即优先级） */
  entries: Entry[];
  /** feedId → feed（订阅级三态覆盖） */
  feedsById: Map<string, Feed>;
  context: PrefetchContext;
  /** 滚动容器（null = 文档滚动，与 `scroll-surface` 的口径一致） */
  intersectionRoot: HTMLElement | null;
  /** 列表视口节点（观察它里面的 `[data-entry-id]` 行） */
  contentRootRef: RefObject<HTMLElement | null>;
  /** 总开关（设置项）；关掉 = 回到「点开才抓」的行为 */
  enabled: boolean;
  /** 换列表 / 换视图时变，用来把在跑的预载整个撤掉 */
  resetKey: string;
  concurrency?: number;
}

/**
 * 把一条条目的预载真跑起来。
 * 抽成独立函数是为了能在单测里直接断言「请求顺序 / 缓存回写」，
 * 而不必挂 React 与 IntersectionObserver。
 */
export async function runEntryPrefetch(args: {
  entry: Entry;
  plan: PrefetchPlan;
  context: PrefetchContext;
  signal: AbortSignal;
  onReadable: (entryId: string, html: string) => void;
}): Promise<void> {
  const { entry, plan, context, signal, onReadable } = args;

  // 1) 阅读模式：先把正文抓回来（后端落库），并写进缓存 ⇒ 打开时零等待
  let readableContent = entry.readableContent;
  if (plan.readerMode && !readableContent && entry.url) {
    readableContent = await fetchReadableContent(entry.id, signal);
    if (readableContent) onReadable(entry.id, readableContent);
  }

  // 与正文页一致：阅读模式生效时摘要/翻译都基于 readableContent，否则基于源内容
  const useReadable = plan.readerMode && Boolean(readableContent);
  const content = useReadable ? readableContent : entry.content;
  if (!content) return;

  // 2) 摘要：结果只落进后端缓存（打开时 streamSummary 会回 {cached:true}）
  if (plan.autoSummary && summaryWorthPrefetching(entry)) {
    const stream = streamSummary(
      {
        entryId: entry.id,
        content,
        title: entry.title ?? undefined,
        isReadability: useReadable,
      },
      signal,
    );
    // 必须把流读完：只取首块就退出会把连接挂在半路，后端那次生成也就白跑了
    for await (const _chunk of stream) void _chunk;
  }

  // 3) 翻译：后端缓存 + 前端 translation-store（useAITranslation 打开时读后者）
  if (
    plan.autoTranslate &&
    translateWorthPrefetching(entry, context.targetLanguage)
  ) {
    let translated: string | null = null;
    /** index → html；与 useAITranslation 的 `translatedBlocks` 同一套拼接口径 */
    const blockIndexByPos: number[] = [];
    const htmlByIndex = new Map<number, string>();

    const stream = streamTranslateBlocks(
      {
        entryId: entry.id,
        content,
        title: entry.title ?? undefined,
        isReadability: useReadable,
      },
      signal,
    );
    for await (const event of stream) {
      if ("cached" in event) {
        translated = event.content;
        break;
      }
      if (isTranslateInit(event)) {
        blockIndexByPos.length = 0;
        htmlByIndex.clear();
        for (const block of event.blocks) {
          blockIndexByPos.push(block.index);
          htmlByIndex.set(block.index, block.html);
        }
        continue;
      }
      if (isTranslateBlockResult(event)) {
        htmlByIndex.set(event.index, event.html);
      }
    }
    if (!translated && blockIndexByPos.length > 0) {
      translated = blockIndexByPos
        .map((index) => htmlByIndex.get(index) ?? "")
        .join("");
    }
    if (translated) {
      translationActions.set(
        entry.id,
        context.targetLanguage,
        { content: translated },
        useReadable,
      );
    }
  }
}

export function useEntryPrefetch({
  entries,
  feedsById,
  context,
  intersectionRoot,
  contentRootRef,
  enabled,
  resetKey,
  concurrency = DEFAULT_PREFETCH_CONCURRENCY,
}: UseEntryPrefetchOptions): void {
  const queueRef = useRef<PrefetchQueue | null>(null);
  if (queueRef.current === null) {
    queueRef.current = new PrefetchQueue({
      concurrency: clampConcurrency(concurrency),
    });
  }

  // 设置里调并发时不必重挂观察器，只改运行中的队列
  useEffect(() => {
    queueRef.current?.setConcurrency(clampConcurrency(concurrency));
  }, [concurrency]);

  const contextRef = useRef(context);
  const feedsByIdRef = useRef(feedsById);
  const entriesRef = useRef(entries);

  // 「latest ref」：观察器回调要用**此刻**最新的三态/订阅/列表，
  // 但它只在挂载与换列表时重建，不能把这些塞进依赖数组（那会让观察器反复重挂）。
  // 同步放进 effect 而不是渲染期写 ref（`react-hooks/refs` 规则）。
  useEffect(() => {
    contextRef.current = context;
    feedsByIdRef.current = feedsById;
    entriesRef.current = entries;
  }, [context, feedsById, entries]);

  /**
   * 把抓回来的正文写进两处缓存。定义在组件里但**不放进任何依赖数组** ——
   * 观察器那个 effect 本来就没有依赖，靠 observedRef 比对决定要不要重挂。
   */
  const onReadable = (entryId: string, html: string): void => {
    // 单条缓存 + 列表缓存都补上 readableContent：
    // 打开时 `useEntry` 直接命中；列表里那张卡若也走阅读模式，不必再等一次 GET
    queryClient.setQueryData(["entry", entryId], (old: Entry | undefined) =>
      old ? { ...old, readableContent: html } : old,
    );
    queryClient.setQueriesData<{ pages: { entries: Entry[] }[] }>(
      { queryKey: ["entries"] },
      (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                entries: page.entries.map((entry) =>
                  entry.id === entryId
                    ? { ...entry, readableContent: html }
                    : entry,
                ),
              })),
            }
          : old,
    );
  };

  /**
   * 观察器：没有依赖数组 —— ref 的 `current` 变化不会触发重渲，靠这里每次渲染比对
   * 「节点 / 开关 / 列表作用域 / root」是否变化，变了才重挂。
   *
   * 目标没变时**只补挂新行、不重建观察器**：条目是异步到的（首屏 query 回来才渲染），
   * 挂载那一刻列表里一行都没有，只扫一次的话后面所有行都不会被观测到 ——
   * 补扫必须按 DOM 节点去重（`observedNodes`），而「这条已经预载过」按 entryId 记
   * （`enqueued`），两者分开才不会因为补扫而重复预载。
   */
  const observedRef = useRef<{
    node: HTMLElement | null;
    root: HTMLElement | null;
    key: string;
    observer?: IntersectionObserver;
    observedNodes: WeakSet<Element>;
  } | null>(null);

  useEffect(() => {
    const queue = queueRef.current;
    if (!queue) return;

    const node = contentRootRef.current;
    const current = observedRef.current;
    const sameTarget =
      current !== null &&
      current.node === node &&
      current.root === intersectionRoot &&
      current.key === `${resetKey}\u0000${enabled ? "1" : "0"}`;

    if (!enabled || !node || typeof IntersectionObserver === "undefined") {
      if (current) {
        current.observer?.disconnect();
        observedRef.current = null;
      }
      queue.cancelAll();
      return;
    }

    // 目标没变 = 只补挂新渲染出来的行。分岔在这里而不是下面：
    // 下面的重建会把 `enqueued`（本次观察期已预载过）清空，等于让旧行再预载一次。
    if (sameTarget && current) {
      const observer = current.observer;
      if (observer) {
        for (const row of node.querySelectorAll<HTMLElement>("[data-entry-id]")) {
          if (current.observedNodes.has(row)) continue;
          current.observedNodes.add(row);
          observer.observe(row);
        }
      }
      return;
    }

    // 换列表 / 换视图 / 换 root：在跑的一律撤掉（已完成的仍留在后端缓存里，不亏）
    queue.cancelAll();
    current?.observer?.disconnect();

    /** 本次观察期里已经入过队的（滚出再滚回来不重复预载同一条） */
    const enqueued = new Set<string>();
    /** 已挂上观察器的 DOM 节点（同一个 entryId 的新行仍要挂 —— 新行是新节点） */
    const observedNodes = new WeakSet<Element>();

    const observer = new IntersectionObserver(
      (items) => {
        for (const item of items) {
          if (!item.isIntersecting) continue;
          const id = (item.target as HTMLElement).dataset.entryId;
          if (!id || enqueued.has(id)) continue;
          enqueued.add(id);

          const currentEntries = entriesRef.current;
          const entry = currentEntries.find((candidate) => candidate.id === id);
          if (!entry) continue;
          const task = buildPrefetchTask({
            entry,
            feed: feedsByIdRef.current.get(entry.feedId),
            context: contextRef.current,
            run: ({ entry: target, plan, signal }) =>
              runEntryPrefetch({
                entry: target,
                plan,
                context: contextRef.current,
                signal,
                onReadable,
              }),
          });
          if (!task) continue;
          // 优先级取**此刻**列表里的位置（而不是挂载时那份快照 —— 那时列表还是空的）：
          // 按视口顺序先进先出，先看到的条目先预载。
          const index = currentEntries.findIndex(
            (candidate) => candidate.id === id,
          );
          queue.enqueue([task], index >= 0 ? index : Number.MAX_SAFE_INTEGER);
        }
      },
      {
        root: intersectionRoot,
        rootMargin: PREFETCH_ROOT_MARGIN,
        threshold: 0,
      },
    );

    for (const row of node.querySelectorAll<HTMLElement>("[data-entry-id]")) {
      observedNodes.add(row);
      observer.observe(row);
    }

    observedRef.current = {
      node,
      root: intersectionRoot,
      key: `${resetKey}\u00001`,
      observer,
      observedNodes,
    };
  });

  // 卸载时把在跑的撤掉（退避重试的定时器也随之作废）
  useEffect(
    () => () => {
      observedRef.current?.observer?.disconnect();
      observedRef.current = null;
      queueRef.current?.cancelAll();
    },
    [],
  );
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PREFETCH_CONCURRENCY;
  return Math.min(MAX_PREFETCH_CONCURRENCY, Math.max(1, Math.round(value)));
}