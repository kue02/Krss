import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  useEntry,
  useMarkAsRead,
  useMarkAsStarred,
} from "@/hooks/useEntries";
import { useAISettings } from "@/hooks/useAISettings";
import { useFeeds } from "@/hooks/useFeeds";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import { useEntryContentScroll } from "@/hooks/useEntryContentScroll";
import { useScrollToTop } from "@/hooks/useScrollToTop";
import { useReadability } from "@/hooks/useReadability";
import { useAISummary } from "@/hooks/useAISummary";
import { useAITranslation } from "@/hooks/useAITranslation";
import { EntryContentHeader } from "./EntryContentHeader";
import { EntryContentBody } from "./EntryContentBody";
import { EntryToc } from "./EntryToc";
import { OriginalSiteView } from "./OriginalSiteView";
import { ReadingProgressBar } from "./ReadingProgressBar";
import { deferUnreadRemovals } from "@/components/entry-list/deferred-removal";
import { isPlainKey, isTypingTarget } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import type { ContentType } from "@/types/api";

interface EntryContentProps {
  entryId: string | null;
  isMobile?: boolean;
  /** 37-1：当前中栏的内容类型。社交视图的正文页用「无标题 + 订阅源头像」的页头 */
  contentType?: ContentType;
  /**
   * 39-1：**内嵌模式** —— 渲染在别处的容器里（通知视图的时间线展开容器），而不是
   * 自己占满一栏。此时：工具栏改成 `sticky` 顶在容器顶部、**不自带滚动容器**
   * （滚动由宿主容器负责）、**不渲染大纲**（大纲由宿主挂在 `relative` 包装上，
   * 因为 `EntryToc` 是 `absolute inset-y-0`，得对着可见区域而不是滚动内容）、
   * **不渲染阅读进度条**（进度条锁在第三栏工具栏正下方，内嵌没有那个位置）。
   */
  embedded?: boolean;
  /** 内嵌模式：宿主的滚动容器。用于判断「吸顶态」并驱动工具栏标题的浮出 */
  containerRef?: React.RefObject<HTMLDivElement | null>;
  onBack?: () => void;
  /** 28-5：桌面正文区左上角的关闭按钮（与移动端 onBack 同位置，图标用 X） */
  onClose?: () => void;
}

export function EntryContent({
  entryId,
  isMobile,
  contentType,
  embedded = false,
  containerRef,
  onBack,
  onClose,
}: EntryContentProps) {
  const { t } = useTranslation();
  const { data: entry, isLoading } = useEntry(entryId);
  const { data: aiSettings } = useAISettings();
  const { data: generalSettings } = useGeneralSettings();
  const { mutate: markAsRead } = useMarkAsRead();
  const { mutate: markAsStarred } = useMarkAsStarred();
  const queryClient = useQueryClient();
  const { scrollRef, isAtTop, scrollNode } = useEntryContentScroll(entryId);
  // #13 在阅读栏里直接加载原站
  const [showOriginalSite, setShowOriginalSite] = useState(false);

  useScrollToTop(scrollNode, "entrycontent");

  /**
   * 39-1（内嵌模式）：宿主的滚动容器才是真正的滚动节点。
   * `useEntryContentScroll` 的 `scrollRef/isAtTop` 是给「自己占一栏」那套用的，
   * 内嵌时不能挂自己的滚动容器（会多出一层滚动条），所以吸顶态自己从宿主容器量。
   */
  const [embeddedAtTop, setEmbeddedAtTop] = useState(true);
  useEffect(() => {
    if (!embedded) return undefined;
    const node = containerRef?.current;
    if (!node) return undefined;
    const update = () => setEmbeddedAtTop(node.scrollTop < 48);
    update();
    node.addEventListener("scroll", update, { passive: true });
    return () => node.removeEventListener("scroll", update);
  }, [embedded, containerRef, entryId]);
  const headerAtTop = embedded ? embeddedAtTop : isAtTop;

  // Track entries marked as read to trigger list removal on switch
  const markedAsReadRef = useRef<Set<string>>(new Set());
  // 自动「打开即已读」每篇文章只做一次：否则手动切回未读（快捷键 m）会被立刻改回已读
  const autoMarkedEntryRef = useRef<string | null>(null);

  const autoTranslateRule = entry?.autoTranslate ?? false;
  const autoTranslate = autoTranslateRule || (aiSettings?.autoTranslate ?? false);
  const targetLanguage = aiSettings?.summaryLanguage ?? "zh-CN";
  const { data: feeds = [] } = useFeeds();
  // 订阅级覆盖优先（#8）：这个源单独设过「阅读模式 / 原文」就听它的，否则跟随全局
  const feedReaderMode = entry
    ? feeds.find((feed) => feed.id === entry.feedId)?.readerMode
    : undefined;
  const autoReadability =
    feedReaderMode ?? generalSettings?.autoReadability ?? false;
  // 订阅级覆盖优先（#5）；规则动作 summarize 打的条目级标记最大（它本来就是为这条打的）
  const feedAutoSummary = entry
    ? feeds.find((feed) => feed.id === entry.feedId)?.autoSummary
    : undefined;
  const autoSummary = entry?.autoSummary
    ? true
    : (feedAutoSummary ?? aiSettings?.autoSummary ?? false);

  // Readability hook
  const {
    isReadableLoading,
    readableContent,
    readableError,
    isReadableActive,
    baseContent,
    handleToggleReadable,
  } = useReadability({ entry, autoReadability });

  // AI Summary hook
  const { aiSummary, isLoadingSummary, summaryError, handleToggleSummary } =
    useAISummary({
      entry,
      isReadableActive,
      readableContent,
      autoSummary,
    });

  // AI Translation hook
  const {
    isTranslating,
    hasTranslation,
    translationDisabled,
    displayTitle,
    translatedContentBlocks,
    combinedTranslatedContent,
    handleToggleTranslation,
  } = useAITranslation({
    entry,
    isReadableActive,
    readableContent,
    autoTranslate,
    targetLanguage,
  });

  // Mark as read when entry is loaded
  // Use skipInvalidate to prevent list item from disappearing immediately
  // 39-1：内嵌模式下已读由宿主负责（时间线的 handleSelect 自己标），
  // 这里再标一次会走两遍写库 + 两条 deferred 记录，所以整段跳过。
  useEffect(() => {
    if (embedded) return;
    if (!entry || autoMarkedEntryRef.current === entry.id) return;
    autoMarkedEntryRef.current = entry.id;
    if (!entry.read) {
      markedAsReadRef.current.add(entry.id);
      markAsRead({ id: entry.id, read: true, skipInvalidate: true });
    }
  }, [entry, markAsRead, embedded]);

  // 快捷键 g：切换阅读模式（原文 / Readability）
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!entry) return;
      if (isTypingTarget(event.target)) return;
      if (!isPlainKey(event)) return;
      if (event.key.toLowerCase() !== "g") return;
      event.preventDefault();
      handleToggleReadable();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [entry, handleToggleReadable]);

  // 24-1：点开看过的条目**离列表才摘** —— 卸载时只记到 deferred-removal
  //（记本体 + 下标，`resetKey` 变才摘），不再当场 removeFromUnreadList。
  // 滚动标已读（useScrollMarkRead）一行不动。
  // Note: EntryContent uses key={entryId} in App.tsx, so it unmounts/remounts on switch
  useEffect(() => {
    const markedAsReadSet = markedAsReadRef.current;
    return () => {
      if (markedAsReadSet.size > 0) {
        deferUnreadRemovals(queryClient, markedAsReadSet);
        markedAsReadSet.clear();
      }
    };
  }, [queryClient]);

  const handleToggleStarred = useCallback(() => {
    if (entry) {
      markAsStarred({ id: entry.id, starred: !entry.starred });
    }
  }, [entry, markAsStarred]);

  /**
   * 23-2：正文工具栏的「标为已读 / 标为未读」。
   * 取值语义与条目右键菜单、社交悬停操作条一致（`readToggleAction`），
   * 也与快捷键 `m` 一样直接写库（不带 skipInvalidate）。
   */
  const handleToggleRead = useCallback(() => {
    if (!entry) return;
    markAsRead({ id: entry.id, read: !entry.read });
  }, [entry, markAsRead]);

  // Determine display content
  const displayContent = combinedTranslatedContent ?? baseContent;
  const highlightContent = combinedTranslatedContent ?? baseContent ?? "";

  if (entryId === null) {
    return <EntryContentEmpty message={t("entry.select_article")} />;
  }

  if (isLoading) {
    return <EntryContentSkeleton />;
  }

  if (!entry) {
    return <EntryContentEmpty message={t("entry.select_article")} />;
  }

  return (
    <div
      className={cn(
        "relative flex w-full flex-col",
        embedded ? "min-h-0" : "h-full overflow-hidden",
      )}
    >
      <EntryContentHeader
        entry={entry}
        displayTitle={displayTitle}
        isAtTop={headerAtTop}
        isReadableActive={isReadableActive}
        isLoading={isReadableLoading}
        error={readableError}
        onToggleReadable={handleToggleReadable}
        onToggleStarred={handleToggleStarred}
        onToggleRead={handleToggleRead}
        isLoadingSummary={isLoadingSummary}
        hasSummary={!!aiSummary}
        onToggleSummary={handleToggleSummary}
        isTranslating={isTranslating}
        hasTranslation={hasTranslation}
        translationDisabled={translationDisabled}
        onToggleTranslation={handleToggleTranslation}
        isMobile={isMobile}
        onBack={onBack}
        onClose={onClose}
        isOriginalSiteActive={showOriginalSite}
        onToggleOriginalSite={() => setShowOriginalSite((value) => !value)}
        /** 39-1：内嵌时工具栏跟宿主容器一起滚（sticky），第三栏那套是 absolute 盖在面板上 */
        sticky={embedded}
      />
      {/* 23-4：阅读进度条锁在工具栏（h-12 = 48px）正下方。
          跟着真实滚动容器（正文那个元素滚动）走；看原站时滚的是 iframe，进度条没有意义。
          39-1：内嵌模式下没有「工具栏正下方」这个位置，跳过 */}
      {!showOriginalSite && !embedded && (
        <ReadingProgressBar scrollNode={scrollNode} resetKey={entryId} />
      )}
      {showOriginalSite && entry.url ? (
        <OriginalSiteView url={entry.url} />
      ) : (
      <EntryContentBody
        entry={entry}
        displayTitle={displayTitle}
        isSocial={contentType === "social"}
        /** 39-1：内嵌时用自己的滚动容器会多一层滚动条 —— 传 null，滚动归宿主 */
        scrollRef={embedded ? noopRef : scrollRef}
        scrollNode={embedded ? null : scrollNode}
        embedded={embedded}
        displayContent={displayContent}
        displayBlocks={translatedContentBlocks}
        highlightContent={highlightContent}
        aiSummary={aiSummary}
        isLoadingSummary={isLoadingSummary}
        summaryError={summaryError}
      />
      )}
      {/* 39-1：大纲是 `absolute inset-y-0`，内嵌时要对着宿主容器的可见区域，
          由宿主挂在自己的 `relative` 包装上并传 `containerRef` 过来 */}
      {!embedded && <EntryToc scrollNode={scrollNode} entryId={entryId} />}
    </div>
  );
}

const noopRef: React.RefCallback<HTMLDivElement> = () => {};

function EntryContentEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center px-6" />
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center text-muted-foreground">
          <svg
            className="mx-auto size-12 opacity-50"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <p className="mt-2 text-sm">{message}</p>
        </div>
      </div>
    </div>
  );
}

function EntryContentSkeleton() {
  return (
    <div className="relative flex h-full flex-col animate-pulse">
      <div className="absolute inset-x-0 top-0 z-20">
        <div className="h-12" />
      </div>
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 pb-20 pt-16">
          <div className="mb-10 space-y-5">
            <div className="h-10 w-3/4 rounded bg-secondary" />
            <div className="flex gap-6">
              <div className="h-4 w-24 rounded bg-secondary" />
              <div className="h-4 w-32 rounded bg-secondary" />
            </div>
            <hr className="border-border/60" />
          </div>
          <div className="space-y-4">
            <div className="h-4 w-full rounded bg-secondary" />
            <div className="h-4 w-full rounded bg-secondary" />
            <div className="h-4 w-3/4 rounded bg-secondary" />
            <div className="h-4 w-full rounded bg-secondary" />
            <div className="h-4 w-5/6 rounded bg-secondary" />
          </div>
        </div>
      </div>
    </div>
  );
}
