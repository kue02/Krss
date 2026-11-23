import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useFeedMenuActions } from "@/hooks/useFeedMenuActions";
import { formatRelativeTime } from "@/lib/date-utils";
import type { Entry, Feed } from "@/types/api";
import { EntryContextMenuContent } from "./EntryListItem";

interface ArticlePlainListRowProps {
  entry: Entry;
  feed?: Feed;
  /** 行点击 → 打开正文（第三栏 / 合列内联） */
  onSelectEntry?: (entryId: string) => void;
  /** 当前选中的条目 id（给行加选中态高亮） */
  selectedEntryId?: string | null;
  /** 右键「标记上方为已读」（父级按当前列表顺序算上面有哪些） */
  onMarkAboveEntry?: (entryId: string) => void;
  /** 手机档：右键菜单在移动端不启用（与条目卡片一致，走左滑动作） */
  isMobile?: boolean;
}

/**
 * 文章「列表」布局的单行（内部值 inoreader，用户命名「Inoreader列表」）。
 *
 * 形态照 Inoreader 的列表：**来源小图标 + 加粗标题 + 右侧「来源 · 时间」**，
 * 无缩略图、无摘要、无悬停浮层 —— 就是图片视图「悬停大图」的行去掉悬停效果。
 * 纯展示 + 点击选条目；右键复用条目卡片同一套菜单（`EntryContextMenuContent`），
 * 独立导出以便虚拟列表复用（同 ArticleRowsListRow）。
 */
export function ArticlePlainListRow({
  entry,
  feed,
  onSelectEntry,
  selectedEntryId,
  onMarkAboveEntry,
  isMobile = false,
}: ArticlePlainListRowProps) {
  const { t } = useTranslation();
  const feedMenu = useFeedMenuActions();
  const feedMenuFolders = useMemo(
    () =>
      feed
        ? (feedMenu.folders ?? []).filter((folder) => folder.type === feed.type)
        : [],
    [feed, feedMenu.folders],
  );
  const time = entry.publishedAt
    ? formatRelativeTime(entry.publishedAt, t)
    : "";
  const selected = entry.id === selectedEntryId;
  const feedName = feed?.title ?? "";
  const meta = [feedName, time].filter(Boolean).join(" · ");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={isMobile}>
        <button
          type="button"
          data-entry-id={entry.id}
          data-selected={selected ? "true" : undefined}
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelectEntry?.(entry.id)}
          /* 尺度照图片「悬停大图」的行实测值：padding 10px 16px、标题 14.5px/500、
             行高 1.45、图标 16px、右侧元信息 12px 且距标题 12px（gap 8 + ml 4） */
          className={`flex w-full items-center gap-2 border-b border-border px-4 py-[10px] text-left transition-colors hover:bg-item-hover ${
            selected ? "bg-item-hover" : ""
          }`}
        >
          {feed && (
            <FeedAvatar iconPath={feed.iconPath} size={16} className="shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium leading-[1.45] text-foreground">
            {entry.title || entry.url || ""}
          </span>
          {meta && (
            <span className="ml-1 shrink-0 text-xs text-muted-foreground">
              {meta}
            </span>
          )}
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
