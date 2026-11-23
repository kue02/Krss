import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import { AuthedImage } from "@/components/ui/authed-image";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import { getEntryImages } from "@/lib/extract-images";
import { formatRelativeTime } from "@/lib/date-utils";
import type { Entry, Feed } from "@/types/api";

interface ArticleRowsListRowProps {
  entry: Entry;
  feed?: Feed;
  /** 行点击 → 打开正文（第三栏 / 覆盖层） */
  onSelectEntry?: (entryId: string) => void;
  /** 当前选中的条目 id（给行加选中态高亮） */
  selectedEntryId?: string | null;
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
}: ArticleRowsListRowProps) {
  const { t } = useTranslation();
  const thumbnail = useMemo(() => {
    const images = getEntryImages(entry.thumbnailUrl, entry.content, entry.url);
    return images[0];
  }, [entry.thumbnailUrl, entry.content, entry.url]);
  const time = entry.publishedAt
    ? formatRelativeTime(entry.publishedAt, t)
    : "";
  const selected = entry.id === selectedEntryId;
  const feedName = feed?.title ?? "";

  return (
    <button
      type="button"
      data-entry-id={entry.id}
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelectEntry?.(entry.id)}
      className={`flex w-full items-stretch gap-3 border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-item-hover ${
        selected ? "bg-item-hover" : ""
      }`}
    >
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
  );
}

interface ArticleRowsListProps {
  items: { entry: Entry; feed?: Feed }[];
  /** 行点击 → 打开正文（第三栏 / 覆盖层） */
  onSelectEntry?: (entryId: string) => void;
  /** 当前选中的条目 id（给行加选中态高亮） */
  selectedEntryId?: string | null;
}

/** 文章「列表」布局的非虚拟列表容器（小列表 / 单测直接用）。 */
export function ArticleRowsList({
  items,
  onSelectEntry,
  selectedEntryId,
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
          />
        </li>
      ))}
    </ul>
  );
}
