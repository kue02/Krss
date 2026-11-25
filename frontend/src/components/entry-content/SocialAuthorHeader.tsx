import { Fragment, useMemo, type ReactNode } from "react";
import { useFeeds } from "@/hooks/useFeeds";
import { useEntryMeta } from "@/hooks/useEntryMeta";
import { parseSocialSource } from "@/lib/social-source";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import { CalendarIcon, ClockIcon } from "@/components/ui/icons";
import type { Entry } from "@/types/api";

/**
 * 37-2：社交视图正文页的页头 —— **不显示标题**（社交条目的标题多半就是正文开头，
 * 单列一行只是把同一句话再打一遍），作者行改用**订阅源自己的头像**（Folo 的
 * `SocialMediaLayout` + `AuthorHeader` 就是这个口径：`FeedIcon target={feed}`，
 * 不是通用人像图标）。作者名照列表的口径取源名，源名没带 handle 时补 @handle。
 *
 * 排版对齐文章视图的编辑化页头（`EntryContentBody` 非社交分支）：大头像 + 大号作者名、
 * 一行 `·` 分隔的 byline、底部发丝线 + 左侧主色短强调线；仍不带标题、不带眉标。
 */
export function SocialAuthorHeader({ entry }: { entry: Entry }) {
  const { data: feeds = [] } = useFeeds();
  const { publishedLong, readingTime } = useEntryMeta(entry);

  const feed = useMemo(
    () => feeds.find((item) => item.id === entry.feedId),
    [feeds, entry.feedId],
  );
  const socialSource = useMemo(
    () => parseSocialSource(entry.url),
    [entry.url],
  );

  const authorName = entry.author || feed?.title || "";
  const showHandle =
    socialSource &&
    !authorName.toLowerCase().includes(socialSource.handle.toLowerCase());

  // byline 只放日期与阅读时长，字段间用和文章页头一致的 `·` 分隔。
  const bylineFields: { key: string; node: ReactNode }[] = [];
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

  return (
    <header className="mb-6" data-slot="social-entry-header">
      <div className="flex items-center gap-3">
        <FeedAvatar
          iconPath={feed?.iconPath}
          size={40}
          rounded="circle"
          alt={authorName}
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
          {authorName && (
            <span className="truncate text-[22px] font-semibold leading-[1.25] tracking-[-0.01em] text-foreground sm:text-[24px]">
              {authorName}
            </span>
          )}
          {showHandle && (
            <a
              href={socialSource.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-[15px] text-muted-foreground transition-colors duration-200 hover:text-foreground"
              onClick={(event) => event.stopPropagation()}
            >
              @{socialSource.handle}
            </a>
          )}
        </div>
      </div>

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
  );
}
