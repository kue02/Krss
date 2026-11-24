import { useEffect, useState, type RefCallback } from "react";
import { useTranslation } from "react-i18next";
import { useEntryMeta } from "@/hooks/useEntryMeta";
import { useFeeds } from "@/hooks/useFeeds";
import { apiUrl } from "@/lib/server-url";
import { isSafeUrl } from "@/lib/url";
import type { ArticleContentBlock } from "@/components/ui/article-content";
import { CalendarIcon, ClockIcon } from "@/components/ui/icons";
import { PluginSlot } from "@/plugins/PluginSlot";
import { useEntryDecorations } from "@/components/reader/useEntryDecorations";
import { useReaderTextRange } from "@/components/reader/useReaderTextRange";
import { AiSummaryBox } from "./AiSummaryBox";
import { BackToTopButton } from "./BackToTopButton";
import { ArticleProse } from "./ArticleProse";
import { SocialAuthorHeader } from "./SocialAuthorHeader";
import type { Entry } from "@/types/api";

interface EntryContentBodyProps {
  entry: Entry;
  displayTitle?: string | null;
  /** 37-1/37-2：社交视图换成「无标题 + 订阅源头像」的页头（文章视图一行不动） */
  isSocial?: boolean;
  /**
   * 39-1：内嵌在别处的滚动容器里（通知视图的时间线展开容器）。
   * 两处要变：① 外层不能再当滚动容器（否则和宿主容器**套两层滚动条**），
   * ② 上下留白是第三栏为工具栏/回到顶部按钮预留的，内嵌时工具栏是 `sticky`
   * 占自身流内高度的，不需要那么大。
   */
  embedded?: boolean;
  scrollRef: RefCallback<HTMLDivElement>;
  scrollNode?: HTMLDivElement | null;
  displayContent: string | null | undefined;
  displayBlocks?: ArticleContentBlock[] | null;
  highlightContent?: string;
  aiSummary?: string | null;
  isLoadingSummary?: boolean;
  summaryError?: string | null;
}

export function EntryContentBody({
  entry,
  displayTitle,
  isSocial = false,
  embedded = false,
  scrollRef,
  scrollNode,
  displayContent,
  displayBlocks,
  highlightContent,
  aiSummary,
  isLoadingSummary,
  summaryError,
}: EntryContentBodyProps) {
  const { t } = useTranslation();
  const { publishedLong, readingTime } = useEntryMeta(entry);
  const { data: feeds = [] } = useFeeds();
  const sourceFeed = feeds.find((feed) => feed.id === entry.feedId);
  const [iconFailed, setIconFailed] = useState(false);
  useEffect(() => {
    setIconFailed(false);
  }, [entry.feedId, sourceFeed?.iconPath]);
  const title = displayTitle ?? entry.title ?? t("entry.untitled");

  /**
   * 56-23：插件在正文上画的两样东西都锚在**同一个容器**上 —— `ArticleProse` 里那个
   * `data-slot="article-prose"`（正文 HTML 的宿主）。装饰的 rune 偏移、选中区间的 rune 偏移
   * 都按它的纯文本算，所以标题 / 日期行 / AI 摘要不会混进下标里。
   */
  const [bodyNode, setBodyNode] = useState<HTMLDivElement | null>(null);
  useEntryDecorations(entry.id, bodyNode, displayContent);
  const textRange = useReaderTextRange(bodyNode, entry.id);

  return (
    <div
      ref={scrollRef}
      className={
        embedded
          ? "entry-content-viewport [overflow-anchor:none]"
          : "entry-content-viewport flex-1 overflow-y-auto [overflow-anchor:none]"
      }
    >
      {/**
       * 56-23：正文里有选中文字时才出现的插件条（`entry.reader.body`）。
       * 没选中 → 整块不渲染（不占位、不留白）；有选中但没有插件贡献 → PluginSlot 回 null，
       * 外层靠 `empty:hidden` 收掉，也不会浮出一条空胶囊。
       * 用 `sticky` 而不是插进正文流里：滚动读长文时按钮要一直在手边。
       */}
      {textRange && (
        <div
          data-slot="selection-toolbar"
          className="empty:hidden sticky top-2 z-10 mx-auto flex w-fit max-w-full flex-wrap items-center gap-1 rounded-full border border-border/60 bg-overlay/90 px-2 py-1 shadow-nf backdrop-blur-xl"
        >
          <PluginSlot
            surface="entry.reader.body"
            variant="toolbar"
            selection={{ entryIds: [entry.id], textRange }}
          />
        </div>
      )}
      {/**
       * 移动端正文末尾留白：`pb-20`（80px）滚到底只剩一小截空档，最后几行贴得太紧。
       * 非 embedded 档给 10rem（160px）+ 安全区，滚到底还能把末尾段落继续往上抬；
       * 若底栏可见（56px + 安全区）扣掉后仍有约 104px ≈ 3.7 行正文的视觉留白。
       * 恢复 80px 的断点用 `md`（=768px）而不是 `sm`：`useMobileLayout` 的移动端界就是
       * 768px，640–767px 仍走详情页布局，`sm:pb-20` 会让这段又只剩 24px。
       */}
      <article
        className={
          embedded
            ? "entry-content nf-enter mx-auto w-full max-w-[clamp(45ch,60vw,65ch)] min-w-0 overflow-x-hidden px-4 pb-6 pt-3 sm:px-5"
            : "entry-content nf-enter mx-auto w-full max-w-[clamp(45ch,60vw,65ch)] min-w-0 overflow-x-hidden px-4 pb-[calc(10rem+env(safe-area-inset-bottom))] pt-[calc(3.25rem+env(safe-area-inset-top))] sm:px-5 sm:pt-20 md:pb-20"
        }
      >
        {/* 37-2：社交视图不显示标题（社交条目的标题多半就是正文开头），作者行改用订阅源头像 */}
        {isSocial ? (
          <SocialAuthorHeader entry={entry} />
        ) : (
        <header className="mb-4 space-y-5">
          <h1 className="text-2xl font-semibold leading-tight tracking-tight text-foreground wrap-anywhere sm:text-[25.6px] sm:font-semibold sm:leading-8">
            {entry.url && isSafeUrl(entry.url) ? (
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-opacity hover:opacity-80"
              >
                {title}
              </a>
            ) : (
              title
            )}
          </h1>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
            {entry.author && (
              <div className="flex min-w-0 items-center gap-2">
                {sourceFeed?.iconPath && !iconFailed ? (
                  <img
                    src={apiUrl(`/icons/${sourceFeed.iconPath}`)}
                    alt=""
                    width={24}
                    height={24}
                    loading="lazy"
                    decoding="async"
                    className="size-6 shrink-0 rounded-full object-cover"
                    onError={() => setIconFailed(true)}
                  />
                ) : (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-muted-foreground">
                    {entry.author.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                )}
                <span className="truncate">{entry.author}</span>
              </div>
            )}

            {publishedLong && (
              <div className="flex items-center gap-1.5">
                <CalendarIcon className="size-4 opacity-70" />
                <span className="tabular-nums">{publishedLong}</span>
              </div>
            )}

            {readingTime && (
              <div className="flex items-center gap-1.5">
                <ClockIcon className="size-4 opacity-70" />
                <span>{readingTime}</span>
              </div>
            )}
          </div>
          <hr className="border-border/60" />
        </header>
        )}

        <AiSummaryBox
          content={aiSummary ?? null}
          isLoading={isLoadingSummary}
          error={summaryError}
        />

        <ArticleProse
          content={displayContent}
          blocks={displayBlocks}
          articleUrl={entry.url}
          highlightContent={highlightContent}
          fitImages={isSocial}
          bodyRef={setBodyNode}
        />
      </article>
      {scrollNode && <BackToTopButton scrollNode={scrollNode} />}
    </div>
  );
}
