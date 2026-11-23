import { useState, useCallback, useEffect, useRef } from "react";
import { fetchCachedTranslations, getCachedSummary, streamSummary } from "@/api";
import { translationActions } from "@/stores/translation-store";
import type { Entry } from "@/types/api";

interface UseAISummaryOptions {
  entry: Entry | undefined;
  isReadableActive: boolean;
  readableContent: string | null | undefined;
  autoSummary: boolean;
  /** 目标语言（与翻译共用 ai.summary_language），用于写摘要状态供顶栏 Tooltip 显示。 */
  targetLanguage?: string;
}

interface UseAISummaryReturn {
  aiSummary: string | null;
  isLoadingSummary: boolean;
  summaryError: string | null;
  handleToggleSummary: () => Promise<void>;
}

export function useAISummary({
  entry,
  isReadableActive,
  readableContent,
  autoSummary,
  targetLanguage = "zh-CN",
}: UseAISummaryOptions): UseAISummaryReturn {
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // 是否已经为当前 (entry, 可读模式) 查过后端缓存：自动生成要等它出结果，
  // 否则「有缓存」时会在预取返回之前先打一次模型（问题④要避免）。
  const [cacheChecked, setCacheChecked] = useState(false);

  const summaryAbortRef = useRef<AbortController | null>(null);
  const summaryRequestedRef = useRef(false);
  const prevReadableActiveRef = useRef(false);
  const summaryManuallyDisabledRef = useRef(false);
  // 同步标记缓存检查是否完成（effect 里靠它判断能否动手，避免用旧 state 抢跑）。
  const cacheReadyRef = useRef(false);
  // 当前模式是否命中缓存（命中就不必为切换可读模式再生成）。
  const cacheHitRef = useRef(false);

  const entryId = entry?.id;

  // Reset state when entry changes
  useEffect(() => {
    setAiSummary(null);
    setSummaryError(null);
    setIsLoadingSummary(false);
    if (summaryAbortRef.current) {
      summaryAbortRef.current.abort();
      summaryAbortRef.current = null;
    }
    summaryRequestedRef.current = false;
    prevReadableActiveRef.current = false;
    summaryManuallyDisabledRef.current = false;
    cacheReadyRef.current = false;
    cacheHitRef.current = false;
    setCacheChecked(false);
  }, [entryId]);

  // 先读后端缓存：命中则恢复摘要态（按钮显示已选中），未命中保持原逻辑。
  // 只读，绝不触发生成；有缓存时「退出再进」不会重新生成。
  useEffect(() => {
    if (!entryId) {
      cacheReadyRef.current = true;
      setCacheChecked(true);
      return;
    }
    let cancelled = false;
    cacheReadyRef.current = false;
    cacheHitRef.current = false;
    setCacheChecked(false);
    void (async () => {
      let cached: string | null = null;
      try {
        cached = await getCachedSummary(entryId, isReadableActive);
      } catch {
        cached = null;
      }
      if (cancelled) return;
      if (cached) {
        cacheHitRef.current = true;
        setAiSummary(cached);
        setSummaryError(null);
        summaryRequestedRef.current = true;
        summaryManuallyDisabledRef.current = false;
      }
      cacheReadyRef.current = true;
      setCacheChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [entryId, isReadableActive]);

  const generateSummary = useCallback(
    async (forReadability: boolean) => {
      if (!entry) return;

      if (summaryAbortRef.current) {
        summaryAbortRef.current.abort();
      }

      const content = forReadability ? readableContent : entry.content;
      if (!content) {
        setSummaryError("No content to summarize");
        return;
      }

      setIsLoadingSummary(true);
      setSummaryError(null);
      setAiSummary(null);
      summaryRequestedRef.current = true;

      const abortController = new AbortController();
      summaryAbortRef.current = abortController;

      try {
        const stream = streamSummary(
          {
            entryId: entry.id,
            content,
            title: entry.title ?? undefined,
            isReadability: forReadability,
          },
          abortController.signal,
        );

        for await (const chunk of stream) {
          if (typeof chunk === "object" && "cached" in chunk) {
            setAiSummary(chunk.summary);
          } else {
            setAiSummary((prev) => (prev ?? "") + chunk);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        const message =
          err instanceof Error ? err.message : "Failed to generate summary";
        setSummaryError(message);
        setIsLoadingSummary(false);
        summaryAbortRef.current = null;
        return;
      }

      setIsLoadingSummary(false);
      summaryAbortRef.current = null;

      // 问题③：回填摘要状态（含 provider/model），供正文顶栏按钮 Tooltip 显示。
      void (async () => {
        let usage: { provider?: string; model?: string } = {};
        try {
          const resp = await fetchCachedTranslations([entry.id], forReadability);
          const status = resp.summaryStatuses?.[entry.id];
          if (status) {
            usage = { provider: status.provider, model: status.model };
          }
        } catch {
          usage = {};
        }
        translationActions.setSummaryStatus(entry.id, targetLanguage, {
          state: "done",
          ...usage,
        });
      })();
    },
    [entry, readableContent, targetLanguage],
  );

  const handleToggleSummary = useCallback(async () => {
    if (!entry) return;

    if (aiSummary && !isLoadingSummary) {
      setAiSummary(null);
      summaryRequestedRef.current = false;
      summaryManuallyDisabledRef.current = true;
      return;
    }

    if (isLoadingSummary && summaryAbortRef.current) {
      summaryAbortRef.current.abort();
      summaryAbortRef.current = null;
      setIsLoadingSummary(false);
      summaryRequestedRef.current = false;
      summaryManuallyDisabledRef.current = true;
      return;
    }

    summaryManuallyDisabledRef.current = false;
    await generateSummary(isReadableActive);
  }, [entry, aiSummary, isLoadingSummary, isReadableActive, generateSummary]);

  // Auto-regenerate when readability mode changes
  useEffect(() => {
    // 缓存检查未完成（含刚切换模式）时先不动手，等它出结果。
    if (!cacheReadyRef.current) return;
    if (prevReadableActiveRef.current === isReadableActive) return;
    prevReadableActiveRef.current = isReadableActive;
    // 新模式有缓存：直接显示缓存，不重新生成。
    if (cacheHitRef.current) return;
    if (summaryRequestedRef.current && (aiSummary || isLoadingSummary)) {
      generateSummary(isReadableActive);
    }
  }, [cacheChecked, isReadableActive, aiSummary, isLoadingSummary, generateSummary]);

  // Auto-generate when entry is selected
  useEffect(() => {
    // 缓存检查未完成：先别自动生成（有缓存时要等预取把它恢复出来）。
    if (!cacheReadyRef.current) return;
    if (!autoSummary || !entry || isLoadingSummary) return;
    if (summaryManuallyDisabledRef.current) return;
    if (aiSummary || summaryRequestedRef.current) return;

    generateSummary(isReadableActive);
  }, [
    cacheChecked,
    autoSummary,
    entry,
    isReadableActive,
    isLoadingSummary,
    aiSummary,
    generateSummary,
  ]);

  return {
    aiSummary,
    isLoadingSummary,
    summaryError,
    handleToggleSummary,
  };
}
