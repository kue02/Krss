import { useEffect, useRef } from "react";
import { fetchCachedTranslations } from "@/api";
import { translationActions, useTranslationStore } from "@/stores/translation-store";
import type { Entry } from "@/types/api";

interface UseListSummaryStatusesOptions {
  entries: Entry[];
  targetLanguage: string;
  enabled: boolean;
  /** 视图 / 列表切换时重置轮询 */
  resetKey?: string | number;
}

const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 60_000;

/**
 * 列表卡片 AI 摘要徽章的数据来源。
 *
 * 后端 `/api/ai/translations/batch` 现在同时返回 `summaryStatuses`：哪些条目正在生成摘要、
 * 已生成、或失败了（含所用模型提供商 / 模型名）。这里只做**只读轮询**，不发任何翻译请求，
 * 把状态写进 translation-store 的 `aiSummaryStatuses`，卡片据此显示摘要徽章。
 *
 * 只在社交媒体 / 通知视图启用；条目变化后先立即取一次，再短轮询一段时间，
 * 以捕捉「滚动预载刚生成摘要」的状态变化，之后自动停止，避免长期空转。
 */
export function useListSummaryStatuses({
  entries,
  targetLanguage,
  enabled,
  resetKey,
}: UseListSummaryStatusesOptions): void {
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // 条目列表异步加载：首帧 entries 为空时立即返回，等列表到达后必须重新跑一次，
  // 否则摘要徽章要等到下一次视图切换才出现。
  const entriesKey = entries.map((entry) => entry.id).join(",");

  useEffect(() => {
    if (!enabled || !targetLanguage) return;
    let alive = true;

    const run = async (): Promise<void> => {
      const list = entriesRef.current;
      if (list.length === 0) return;
      const ids = Array.from(new Set(list.map((entry) => entry.id)));
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const slice = ids.slice(i, i + BATCH_SIZE);
        try {
          const response = await fetchCachedTranslations(slice, false);
          if (!alive) return;
          // 正文翻译状态也一并水合：正文页手动翻译完、刷新列表时没有 warm 轮询，
          // 但卡片的 translation 已进 store，这里补上服务信息，悬浮才会显示「机器翻译 · 服务 · 提供商」。
          if (response.statuses) {
            const store = useTranslationStore.getState();
            for (const [entryId, info] of Object.entries(response.statuses)) {
              const hasContent = Boolean(store.getTranslation(entryId, targetLanguage));
              if (info.status === "done" && !hasContent) continue;
              const state =
                info.status === "translating"
                  ? "translating"
                  : info.status === "failed"
                    ? "failed"
                    : "done";
              translationActions.setStatus(entryId, targetLanguage, {
                content: {
                  state,
                  error: info.error,
                  service: info.service,
                  provider: info.provider,
                  model: info.model,
                },
              });
            }
          }
          const statuses = response.summaryStatuses;
          if (!statuses) continue;
          for (const [entryId, info] of Object.entries(statuses)) {
            const state =
              info.status === "translating"
                ? "translating"
                : info.status === "failed"
                  ? "failed"
                  : "done";
            translationActions.setSummaryStatus(entryId, targetLanguage, {
              state,
              error: info.error,
              provider: info.provider,
              model: info.model,
            });
          }
        } catch {
          // 读失败静默：下一轮再试，卡片维持现状
        }
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, POLL_INTERVAL_MS);
    const stop = window.setTimeout(() => {
      window.clearInterval(interval);
    }, MAX_POLL_MS);

    return () => {
      alive = false;
      window.clearInterval(interval);
      window.clearTimeout(stop);
    };
  }, [enabled, targetLanguage, resetKey, entriesKey]);
}
