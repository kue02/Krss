import type { RefCallback } from "react";
import { useTranslation } from "react-i18next";
import { useEntryMeta } from "@/hooks/useEntryMeta";
import { isSafeUrl } from "@/lib/url";
import type { ArticleContentBlock } from "@/components/ui/article-content";
import { UserIcon, CalendarIcon, ClockIcon } from "@/components/ui/icons";
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
  const title = displayTitle ?? entry.title ?? t("entry.untitled");

  return (
    <div
      ref={scrollRef}
      className={
        embedded
          ? "entry-content-viewport [overflow-anchor:none]"
          : "entry-content-viewport flex-1 overflow-y-auto [overflow-anchor:none]"
      }
    >
      <article
        className={
          embedded
            ? "entry-content nf-enter mx-auto w-full max-w-[clamp(45ch,60vw,65ch)] min-w-0 overflow-x-hidden px-4 pb-6 pt-3 sm:px-5"
            : "entry-content nf-enter mx-auto w-full max-w-[clamp(45ch,60vw,65ch)] min-w-0 overflow-x-hidden px-4 pb-20 pt-16 sm:px-5 sm:pt-20"
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
              <div className="flex items-center gap-1.5">
                <UserIcon className="size-4 opacity-70" />
                <span>{entry.author}</span>
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
        />
      </article>
      {scrollNode && <BackToTopButton scrollNode={scrollNode} />}
    </div>
  );
}
