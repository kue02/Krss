import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  streamTranslateBlocks,
  isTranslateInit,
  isTranslateBlockResult,
  isTranslateDone,
  isTranslateError,
  type TranslateBlockData,
} from "@/api";
import { needsTranslation } from "@/lib/language-detect";
import { stripHtml } from "@/lib/html-utils";
import {
  useTranslationStore,
  translationActions,
} from "@/stores/translation-store";
import { translateArticlesBatch } from "@/services/translation-service";
import {
  attachContentTranslation,
  claimContentTranslation,
  type ContentTranslationEvent,
} from "@/services/content-translation-inflight";
import { showToast } from "@/stores/toast-store";
import type { Entry } from "@/types/api";

interface UseAITranslationOptions {
  entry: Entry | undefined;
  isReadableActive: boolean;
  readableContent: string | null | undefined;
  autoTranslate: boolean;
  targetLanguage: string;
}

interface UseAITranslationReturn {
  isTranslating: boolean;
  hasTranslation: boolean;
  translationDisabled: boolean;
  displayTitle: string | null;
  translatedContent: string | null;
  translatedContentBlocks: Array<{ key: string; html: string }> | null;
  combinedTranslatedContent: string | null;
  handleToggleTranslation: () => Promise<void>;
}

export function useAITranslation({
  entry,
  isReadableActive,
  readableContent,
  autoTranslate,
  targetLanguage,
}: UseAITranslationOptions): UseAITranslationReturn {
  const { t } = useTranslation();
  const [translatedContent, setTranslatedContent] = useState<string | null>(
    null,
  );
  /** 免费通道失败→模型兜底：同一次翻译只提示一次 */
  const fallbackToastShownRef = useRef(false);
  /**
   * 49-3（用户 2026-10-12「正在自动翻译弹框太多了」）：
   * 「正在自动翻译…」这一条**每条条目只弹一次** —— 原来每跑一遍自动翻译就弹一条，
   * 而打开一条条目在实际链路上会被触发两次（预载那条没落库时会再自己发一次），
   * 列表里快速切换条目就会叠起十几条一模一样的胶囊。
   */
  const autoTranslateToastShownRef = useRef(false);
  /**
   * 49-2（用户 2026-10-12「翻译只翻译了标题，正文没有翻译」）：
   * 逐块翻译失败时必须**说出来**，不能静默留原文 —— 免费通道只吃纯文本，带内联标记
   * （列表 / 代码）的块会交给模型；模型不可达时那些块就一直是原文，界面上看不出任何异常。
   */
  const failedBlockCountRef = useRef(0);
  const lastTranslateErrorRef = useRef<string | null>(null);
  const failureToastShownRef = useRef(false);
  const [originalBlocks, setOriginalBlocks] = useState<TranslateBlockData[]>(
    [],
  );
  const [translatedBlocks, setTranslatedBlocks] = useState<Map<number, string>>(
    new Map(),
  );
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationMode, setTranslationMode] = useState<boolean | null>(null);

  const translateAbortRef = useRef<AbortController | null>(null);
  const translateRequestedRef = useRef(false);
  const prevTranslateReadableRef = useRef(false);
  const manuallyDisabledRef = useRef(false);
  const requestSeqRef = useRef(0);
  const hasExistingTranslationRef = useRef(false);
  const isTranslatingRef = useRef(false);

  const clearTranslationState = useCallback(() => {
    setTranslatedContent(null);
    setOriginalBlocks([]);
    setTranslatedBlocks(new Map());
    setTranslationMode(null);
    hasExistingTranslationRef.current = false;
  }, []);

  const cancelInFlightTranslation = useCallback(() => {
    requestSeqRef.current += 1;
    if (translateAbortRef.current) {
      translateAbortRef.current.abort();
      translateAbortRef.current = null;
    }
    setIsTranslating(false);
    isTranslatingRef.current = false;
  }, []);

  // Reset state when entry changes
  useEffect(() => {
    cancelInFlightTranslation();
    clearTranslationState();
    translateRequestedRef.current = false;
    prevTranslateReadableRef.current = false;
    manuallyDisabledRef.current = false;
    autoTranslateToastShownRef.current = false;
    failedBlockCountRef.current = 0;
    lastTranslateErrorRef.current = null;
    failureToastShownRef.current = false;
  }, [entry?.id, cancelInFlightTranslation, clearTranslationState]);

  // Get cached translations from store
  const cachedTranslation = useTranslationStore((state) =>
    entry && autoTranslate
      ? state.getTranslation(entry.id, targetLanguage, isReadableActive)
      : undefined,
  );

  const cachedTitleTranslation = useTranslationStore((state) =>
    entry && autoTranslate
      ? state.getTranslation(entry.id, targetLanguage)
      : undefined,
  );

  const isTranslationForCurrentMode = translationMode === isReadableActive;
  const translatedContentForCurrentMode = isTranslationForCurrentMode
    ? translatedContent
    : null;

  const isAlreadyTargetLanguage = useMemo(() => {
    if (!entry) return false;
    const content = isReadableActive ? readableContent : entry.content;
    const summary = content ? stripHtml(content).slice(0, 200) : null;
    return !needsTranslation(entry.title || "", summary, targetLanguage);
  }, [entry, isReadableActive, readableContent, targetLanguage]);

  const displayTitle = useMemo(() => {
    if (!autoTranslate || !entry) return entry?.title || null;
    return cachedTitleTranslation?.title ?? entry.title ?? null;
  }, [autoTranslate, entry, cachedTitleTranslation?.title]);

  const combinedTranslatedContent = useMemo(() => {
    if (!isTranslationForCurrentMode) return null;
    if (translatedContentForCurrentMode) return translatedContentForCurrentMode;
    if (originalBlocks.length === 0) return null;
    return originalBlocks
      .map((block) => translatedBlocks.get(block.index) ?? block.html)
      .join("");
  }, [
    isTranslationForCurrentMode,
    translatedContentForCurrentMode,
    originalBlocks,
    translatedBlocks,
  ]);

  const translatedContentBlocks = useMemo(() => {
    if (
      !entry ||
      !isTranslationForCurrentMode ||
      translatedContentForCurrentMode ||
      originalBlocks.length === 0
    ) {
      return null;
    }
    return originalBlocks.map((block) => ({
      key: `${entry.id}-${block.index}`,
      html: translatedBlocks.get(block.index) ?? block.html,
    }));
  }, [
    entry,
    isTranslationForCurrentMode,
    translatedContentForCurrentMode,
    originalBlocks,
    translatedBlocks,
  ]);

  const hasTranslation =
    !isTranslating &&
    isTranslationForCurrentMode &&
    !!(translatedContentForCurrentMode || originalBlocks.length > 0);

  /**
   * 处理一个翻译流事件。**自己发的流**与**预载转发来的流**共用这一份 ——
   * 两种来源的界面表现必须一致（逐块出、兜底提示只提示一次）。
   * 返回 `true` = 命中后端缓存、流可以提前结束。
   */
  const applyTranslateEvent = useCallback(
    (event: ContentTranslationEvent): boolean => {
      if ("cached" in event) {
        setTranslatedContent(event.content);
        setOriginalBlocks([]);
        setTranslatedBlocks(new Map());
        return true;
      }

      if (isTranslateInit(event)) {
        setOriginalBlocks(event.blocks);
        return false;
      }

      if (isTranslateBlockResult(event)) {
        if (event.fallback && !fallbackToastShownRef.current) {
          fallbackToastShownRef.current = true;
          showToast(t("entry.translate_fallback_hint"));
        }
        setTranslatedBlocks((prev) => {
          const newMap = new Map(prev);
          newMap.set(event.index, event.html);
          return newMap;
        });
        return false;
      }

      // 49-2：失败的块要记账（收尾时给一句可见提示），但不在这里改「已翻译」状态 ——
      // 部分成功时其余块仍是有效译文，不能因为一块失败就把整篇打回原文。
      if (isTranslateError(event)) {
        failedBlockCountRef.current += 1;
        lastTranslateErrorRef.current = event.error;
        return false;
      }

      // done 本身不改状态：收尾统一由流的结束（或订阅到的 done 承诺）负责
      if (isTranslateDone(event)) return false;
      return false;
    },
    [t],
  );

  const generateTranslation = useCallback(
    async (forReadability: boolean, options?: { allowAttach?: boolean }) => {
      if (!entry) return;

      const content = forReadability ? readableContent : entry.content;
      if (!content) return;

      requestSeqRef.current += 1;
      if (translateAbortRef.current) {
        translateAbortRef.current.abort();
        translateAbortRef.current = null;
      }
      const requestSeq = requestSeqRef.current;

      setIsTranslating(true);
      isTranslatingRef.current = true;
      setTranslatedContent(null);
      setOriginalBlocks([]);
      setTranslatedBlocks(new Map());
      hasExistingTranslationRef.current = false;
      setTranslationMode(forReadability);
      translateRequestedRef.current = true;
      // 49-2：每跑一次翻译重新记账（这次失败了要说，上次说过的不重复说）
      failedBlockCountRef.current = 0;
      lastTranslateErrorRef.current = null;

      // 别人（预载）正在翻同一条 ⇒ 只订阅它的事件，**不重复跑一遍模型**。
      // 它结束时：store 里有结果就直接用；没有（失败 / 被取消）就落到下面自己补一次。
      if (options?.allowAttach !== false) {
        const attached = attachContentTranslation(
          entry.id,
          forReadability,
          targetLanguage,
          (event) => {
            if (requestSeqRef.current !== requestSeq) return;
            applyTranslateEvent(event);
          },
        );
        if (attached) {
          await attached;
          if (requestSeqRef.current !== requestSeq) return;
          const prefetched = translationActions.get(
            entry.id,
            targetLanguage,
            forReadability,
          );
          if (prefetched?.content) {
            setTranslatedContent(prefetched.content);
            setIsTranslating(false);
            isTranslatingRef.current = false;
            return;
          }
          // 预载那条没成 —— 继续往下走「自己发」这条路（不再递归订阅自己）
        }
      }

      // 自己当发起方：登记在途（预载撞上就不会再发一条），并把事件转发给订阅方
      const claim = claimContentTranslation(
        entry.id,
        forReadability,
        targetLanguage,
      );

      const abortController = new AbortController();
      translateAbortRef.current = abortController;

      try {
        const stream = streamTranslateBlocks(
          {
            entryId: entry.id,
            content,
            title: entry.title ?? undefined,
            isReadability: forReadability,
          },
          abortController.signal,
        );

        for await (const event of stream) {
          if (requestSeqRef.current !== requestSeq) {
            return;
          }

          claim?.emit(event);
          if (applyTranslateEvent(event)) break;
        }
      } catch (err) {
        if (requestSeqRef.current !== requestSeq) {
          return;
        }
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        return;
      } finally {
        claim?.finish();
        if (requestSeqRef.current === requestSeq) {
          setIsTranslating(false);
          isTranslatingRef.current = false;
          if (translateAbortRef.current === abortController) {
            translateAbortRef.current = null;
          }
          // 49-2：有块没译出来就明说（用户口径「失败须给可见原因」）。
          // 同一次翻译只提示一次；toast-store 现在也会把同文案合并成一条。
          if (failedBlockCountRef.current > 0 && !failureToastShownRef.current) {
            failureToastShownRef.current = true;
            const reason = (lastTranslateErrorRef.current ?? "").slice(0, 60);
            showToast(
              t("entry.translate_blocks_failed", {
                count: failedBlockCountRef.current,
                reason,
              }),
            );
          }
        }
      }
    },
    // t 要进来：49-2 之后这个回调里会拼「有 N 段没译出来」的提示文案，
    // 漏了它切语言时那条提示会停在旧语言上（eslint 也照实报）
    [entry, readableContent, targetLanguage, applyTranslateEvent, t],
  );

  useEffect(() => {
    hasExistingTranslationRef.current = !!(
      translatedContent || originalBlocks.length > 0
    );
  }, [translatedContent, originalBlocks.length]);

  useEffect(() => {
    isTranslatingRef.current = isTranslating;
  }, [isTranslating]);

  const handleToggleTranslation = useCallback(async () => {
    if (!entry) return;

    if (hasTranslation && !isTranslating) {
      clearTranslationState();
      translateRequestedRef.current = false;
      manuallyDisabledRef.current = true;
      translationActions.disable(entry.id);
      return;
    }

    if (isTranslating && translateAbortRef.current) {
      cancelInFlightTranslation();
      clearTranslationState();
      translateRequestedRef.current = false;
      manuallyDisabledRef.current = true;
      translationActions.disable(entry.id);
      return;
    }

    manuallyDisabledRef.current = false;
    translationActions.enable(entry.id);

    const summary = entry.content
      ? stripHtml(entry.content).slice(0, 200)
      : null;
    if (needsTranslation(entry.title || "", summary, targetLanguage)) {
      translateArticlesBatch(
        [{ id: entry.id, title: entry.title || "", summary }],
        targetLanguage,
      ).catch(() => {});
    }

    await generateTranslation(isReadableActive);
  }, [
    entry,
    hasTranslation,
    isTranslating,
    isReadableActive,
    clearTranslationState,
    cancelInFlightTranslation,
    generateTranslation,
    targetLanguage,
  ]);

  // Auto-regenerate when readability mode changes
  useEffect(() => {
    if (prevTranslateReadableRef.current !== isReadableActive) {
      prevTranslateReadableRef.current = isReadableActive;
      if (
        translateRequestedRef.current &&
        (hasExistingTranslationRef.current || isTranslatingRef.current)
      ) {
        if (cachedTranslation?.content) {
          cancelInFlightTranslation();
          clearTranslationState();
          setTranslatedContent(cachedTranslation.content);
          setTranslationMode(isReadableActive);
          translateRequestedRef.current = true;
          return;
        }

        const content = isReadableActive ? readableContent : entry?.content;
        const summary = content ? stripHtml(content).slice(0, 200) : null;

        if (needsTranslation(entry?.title || "", summary, targetLanguage)) {
          generateTranslation(isReadableActive);
        } else {
          cancelInFlightTranslation();
          clearTranslationState();
          translateRequestedRef.current = false;
        }
      }
    }
  }, [
    isReadableActive,
    cancelInFlightTranslation,
    clearTranslationState,
    generateTranslation,
    readableContent,
    entry,
    targetLanguage,
    cachedTranslation,
  ]);

  // Auto-translate when entry is selected
  useEffect(() => {
    if (!autoTranslate || !entry || isTranslating || isTranslatingRef.current)
      return;
    if (manuallyDisabledRef.current) return;
    if (hasTranslation) return;

    if (cachedTranslation?.content) {
      setTranslatedContent(cachedTranslation.content);
      setTranslationMode(isReadableActive);
      translateRequestedRef.current = true;
      return;
    }

    const content = isReadableActive ? readableContent : entry.content;
    const summary = content ? stripHtml(content).slice(0, 200) : null;
    if (!needsTranslation(entry.title || "", summary, targetLanguage)) {
      return;
    }

    // 自动翻译也是「自己动起来」的，给个提示说明正在做什么。
    // 49-3：**每条条目只弹一次** —— 这条链路会为同一条目跑两遍（预载没落库时再自发一次），
    // 列表里快速切换就会叠出一屏一模一样的胶囊（用户报的就是这个）。
    if (!autoTranslateToastShownRef.current) {
      autoTranslateToastShownRef.current = true;
      showToast(t("entry.auto_translate_on"));
    }
    generateTranslation(isReadableActive);
  }, [
    autoTranslate,
    entry,
    isReadableActive,
    readableContent,
    targetLanguage,
    cachedTranslation,
    isTranslating,
    hasTranslation,
    generateTranslation,
  ]);

  // Save translation to store when completed
  useEffect(() => {
    if (!entry || !autoTranslate) return;

    const content = combinedTranslatedContent;
    if (content && !isTranslating && translationMode !== null) {
      translationActions.set(
        entry.id,
        targetLanguage,
        { content },
        translationMode,
      );
    }
  }, [
    entry,
    autoTranslate,
    targetLanguage,
    translationMode,
    combinedTranslatedContent,
    isTranslating,
  ]);

  return {
    isTranslating,
    hasTranslation,
    translationDisabled: isAlreadyTargetLanguage,
    displayTitle,
    translatedContent: translatedContentForCurrentMode,
    translatedContentBlocks,
    combinedTranslatedContent,
    handleToggleTranslation,
  };
}
