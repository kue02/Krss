import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import { AuthedImage } from "@/components/ui/authed-image";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useFeedMenuActions } from "@/hooks/useFeedMenuActions";
import { useUISettingKey } from "@/hooks/useUISettings";
import { getEntryImages } from "@/lib/extract-images";
import { formatRelativeTime } from "@/lib/date-utils";
import { cn } from "@/lib/utils";
import type { Entry, Feed } from "@/types/api";
import { EntryContextMenuContent } from "./EntryListItem";
import { RowQuickActions } from "./RowQuickActions";
import { UnreadIndicator, unreadRowClass } from "./unread-indicator";

interface ArticleRowsListRowProps {
  entry: Entry;
  feed?: Feed;
  /** 行点击 → 打开正文（第三栏 / 覆盖层） */
  onSelectEntry?: (entryId: string) => void;
  /** 当前选中的条目 id（给行加选中态高亮） */
  selectedEntryId?: string | null;
  /** 右键「标记上方为已读」（父级按当前列表顺序算上面有哪些） */
  onMarkAboveEntry?: (entryId: string) => void;
  /** 手机档：右键菜单在移动端不启用 */
  isMobile?: boolean;
  /** 该订阅未读数（给「未读数」档角标用；圆点档不需要） */
  feedUnreadCount?: number;
}

/**
 * 文章「列表」布局的单行（内部值 rows）。
 *
 * 结构同图片「悬停大图」的行（缩略图 + 标题 + 元信息），但**去掉悬停浮层大图**——
 * 图片悬停行（HoverImg）的行本身其实没有缩略图，故这里单独做一套紧凑行。
 * 每行：左侧 64×64 缩略图（无图退占位），右侧标题（最多两行）+ 来源图标 · 来源名 · 相对时间。
 * 纯展示 + 点击选条目，不放任何 hover 浮层。独立导出以便虚拟列表复用（性能，见 EntryList）。
 */
export function ArticleRowsListRow({
  entry,
  feed,
  onSelectEntry,
  selectedEntryId,
  onMarkAboveEntry,
  isMobile = false,
  feedUnreadCount,
}: ArticleRowsListRowProps) {
  const { t } = useTranslation();
  const unreadStyle = useUISettingKey("unreadStyle");
  const feedMenu = useFeedMenuActions();
  const feedMenuFolders = useMemo(
    () =>
      feed
        ? (feedMenu.folders ?? []).filter((folder) => folder.type === feed.type)
        : [],
    [feed, feedMenu.folders],
  );
  const thumbnail = useMemo(() => {
    const images = getEntryImages(entry.thumbnailUrl, entry.content, entry.url);
    return images[0];
  }, [entry.thumbnailUrl, entry.content, entry.url]);
  const time = entry.publishedAt
    ? formatRelativeTime(entry.publishedAt, t)
    : "";
  const selected = entry.id === selectedEntryId;
  const isUnread = !entry.read;
  const feedName = feed?.title ?? "";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={isMobile}>
        <button
          type="button"
          data-entry-id={entry.id}
          data-selected={selected ? "true" : undefined}
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelectEntry?.(entry.id)}
          className={cn(
            "group mx-2 my-0.5 flex w-[calc(100%-1rem)] items-stretch gap-3 rounded-[10px] border border-transparent px-2 py-2.5 text-left transition-[background-color,border-color,box-shadow] duration-150 hover:bg-item-hover [contain:layout]",
            selected && "bg-item-hover",
            unreadRowClass(isUnread, !!entry.starred, selected, unreadStyle),
          )}
        >
      <RowQuickActions entry={entry} className="self-center" />
      <UnreadIndicator unread={isUnread} count={feedUnreadCount} className="shrink-0">
      <div className="relative size-16 shrink-0 overflow-hidden rounded-md bg-muted">
        {thumbnail ? (
          <AuthedImage
            src={thumbnail}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <ImageOff className="size-5" />
          </div>
        )}
      </div>
      </UnreadIndicator>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
          {entry.title || entry.url || ""}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {feed && (
            <FeedAvatar
              iconPath={feed.iconPath}
              size={14}
              className="shrink-0"
            />
          )}
          {feedName && <span className="truncate">{feedName}</span>}
          {feedName && time && <span aria-hidden="true">·</span>}
          {time && <span className="shrink-0">{time}</span>}
        </div>
        </div>
        </button>
      </ContextMenuTrigger>
      <EntryContextMenuContent
        entry={entry}
        feed={feed}
        feedActions={feedMenu}
        feedFolders={feedMenuFolders}
        onMarkAbove={
          onMarkAboveEntry ? () => onMarkAboveEntry(entry.id) : undefined
        }
      />
    </ContextMenu>
  );
}

interface ArticleRowsListProps {
  items: { entry: Entry; feed?: Feed }[];
  /** 行点击 → 打开正文（第三栏 / 覆盖层） */
  onSelectEntry?: (entryId: string) => void;
  /** 当前选中的条目 id（给行加选中态高亮） */
  selectedEntryId?: string | null;
  onMarkAboveEntry?: (entryId: string) => void;
  isMobile?: boolean;
}

/** 文章「列表」布局的非虚拟列表容器（小列表 / 单测直接用）。 */
export function ArticleRowsList({
  items,
  onSelectEntry,
  selectedEntryId,
  onMarkAboveEntry,
  isMobile,
}: ArticleRowsListProps) {
  return (
    <ul className="w-full" data-testid="article-rows-list">
      {items.map(({ entry, feed }) => (
        <li key={entry.id}>
          <ArticleRowsListRow
            entry={entry}
            feed={feed}
            onSelectEntry={onSelectEntry}
            selectedEntryId={selectedEntryId}
            onMarkAboveEntry={onMarkAboveEntry}
            isMobile={isMobile}
          />
        </li>
      ))}
    </ul>
  );
}
