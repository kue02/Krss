import { Fragment, useEffect, useState, type ReactNode, type RefCallback } from "react";
import { useTranslation } from "react-i18next";
import { useEntryMeta } from "@/hooks/useEntryMeta";
import { useFeeds } from "@/hooks/useFeeds";
import { apiUrl } from "@/lib/server-url";
import { isSafeUrl } from "@/lib/url";
import type { ArticleContentBlock } from "@/components/ui/article-content";
import { CalendarIcon, ClockIcon } from "@/components/ui/icons";
import { FeedIcon } from "@/components/ui/feed-icon";
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

  // 正文栏页头的署名行：把「源 / 作者 / 日期 / 阅读时长」里实际存在的字段收进数组，
  // 再统一用 `·` 分隔，避免出现孤立的间隔符。
  const bylineFields: { key: string; node: ReactNode }[] = [];
  if (sourceFeed?.title) {
    bylineFields.push({
      key: "source",
      node: (
        <span className="flex min-w-0 items-center gap-1.5">
          {sourceFeed.iconPath && !iconFailed ? (
            <img
              src={apiUrl(`/icons/${sourceFeed.iconPath}`)}
              alt=""
              width={18}
              height={18}
              loading="lazy"
              decoding="async"
              className="size-[18px] shrink-0 rounded-[3px] object-contain"
              onError={() => setIconFailed(true)}
            />
          ) : (
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[3px] bg-secondary text-muted-foreground">
              <FeedIcon className="size-3" />
            </span>
          )}
          <span className="min-w-0 truncate font-medium text-foreground/85">
            {sourceFeed.title}
          </span>
        </span>
      ),
    });
  }
  if (entry.author) {
    bylineFields.push({
      key: "author",
      node: <span className="min-w-0 truncate">{entry.author}</span>,
    });
  }
  if (publishedLong) {
    bylineFields.push({
      key: "date",
      node: (
        <span className="inline-flex items-center gap-1">
          <CalendarIcon className="size-3.5 shrink-0 opacity-60" />
          <span className="tabular-nums">{publishedLong}</span>
        </span>
      ),
    });
  }
  if (readingTime) {
    bylineFields.push({
      key: "readingTime",
      node: (
        <span className="inline-flex items-center gap-1">
          <ClockIcon className="size-3.5 shrink-0 opacity-60" />
          {readingTime}
        </span>
      ),
    });
  }

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
      <article
        className={
          embedded
            ? "entry-content nf-enter mx-auto w-full max-w-[clamp(45ch,60vw,65ch)] min-w-0 overflow-x-hidden px-4 pb-6 pt-3 sm:px-5"
            : "entry-content nf-enter mx-auto w-full max-w-[clamp(45ch,60vw,65ch)] min-w-0 overflow-x-hidden px-4 pb-20 pt-[calc(3.25rem+env(safe-area-inset-top))] sm:px-5 sm:pt-20"
        }
      >
        {/* 37-2：社交视图不显示标题（社交条目的标题多半就是正文开头），作者行改用订阅源头像 */}
        {isSocial ? (
          <SocialAuthorHeader entry={entry} />
        ) : (
        <header className="mb-6">
          <h1 className="text-[24px] font-semibold leading-[1.22] tracking-[-0.02em] text-foreground wrap-anywhere sm:text-[28px] sm:leading-[1.2]">
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

          {bylineFields.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] leading-5 text-foreground/80">
              {bylineFields.map((field, index) => (
                <Fragment key={field.key}>
                  {index > 0 && (
                    <span className="text-muted-foreground/40">·</span>
                  )}
                  {field.node}
                </Fragment>
              ))}
            </div>
          )}

          <div
            aria-hidden="true"
            className="relative mt-5 h-px w-full bg-border/50"
          >
            <span className="absolute left-0 top-1/2 h-[2px] w-10 -translate-y-1/2 rounded-full bg-primary" />
          </div>
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
