import { useMemo } from "react";
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

  return (
    <header className="mb-4 space-y-4" data-slot="social-entry-header">
      <div className="flex items-center gap-2.5">
        <FeedAvatar
          iconPath={feed?.iconPath}
          size={32}
          rounded="circle"
          alt={authorName}
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 leading-6">
          {authorName && (
            <span className="truncate text-base font-semibold text-foreground">
              {authorName}
            </span>
          )}
          {showHandle && (
            <a
              href={socialSource.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-base text-muted-foreground transition-colors duration-200 hover:text-foreground"
              onClick={(event) => event.stopPropagation()}
            >
              @{socialSource.handle}
            </a>
          )}
        </div>
      </div>

      {(publishedLong || readingTime) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
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
      )}
      <hr className="border-border/60" />
    </header>
  );
}