import { useTranslation } from "react-i18next";
import { CheckCircle2, Circle, Star } from "lucide-react";
import { useMarkAsRead, useMarkAsStarred } from "@/hooks/useEntries";
import { cn } from "@/lib/utils";
import type { Entry } from "@/types/api";

interface RowQuickActionsProps {
  entry: Entry;
  className?: string;
}

/**
 * 列表行左侧的快捷动作：标为已读/未读 + 加星标/取消星标。
 *
 * 用户 2026-11-24：「已读未读和加星标那个没有做，也显示左侧，图标前面」。
 * 位置固定在来源图标（或缩略图）左边；点按钮只改状态，不打开正文
 * （`stopPropagation`，否则会连带触发行的选中）。
 */
export function RowQuickActions({ entry, className }: RowQuickActionsProps) {
  const { t } = useTranslation();
  const { mutate: markAsRead } = useMarkAsRead();
  const { mutate: markAsStarred } = useMarkAsStarred();

  return (
    <span
      className={cn(
        "hidden w-0 shrink-0 items-center gap-0.5 overflow-hidden opacity-0 transition-[width,opacity] duration-150 group-hover:w-[58px] group-hover:opacity-100 group-focus-within:w-[58px] group-focus-within:opacity-100 md:flex",
        className,
      )}
      data-testid="row-quick-actions"
    >
      <button
        type="button"
        data-testid="row-read-toggle"
        aria-label={
          entry.read ? t("entry.mark_unread") : t("entry.mark_read")
        }
        title={entry.read ? t("entry.mark_unread") : t("entry.mark_read")}
        onClick={(event) => {
          event.stopPropagation();
          markAsRead({ id: entry.id, read: !entry.read });
        }}
        className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-item-hover hover:text-foreground active:scale-95"
      >
        {entry.read ? (
          <CheckCircle2 className="size-[15px]" />
        ) : (
          <Circle className="size-[15px]" />
        )}
      </button>
      <button
        type="button"
        data-testid="row-star-toggle"
        aria-label={entry.starred ? t("entry.unstar") : t("entry.star")}
        title={entry.starred ? t("entry.unstar") : t("entry.star")}
        onClick={(event) => {
          event.stopPropagation();
          markAsStarred({ id: entry.id, starred: !entry.starred });
        }}
        className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-item-hover hover:text-foreground active:scale-95"
      >
        <Star
          className={cn(
            "size-[15px]",
            entry.starred && "fill-amber-500 text-amber-500",
          )}
        />
      </button>
    </span>
  );
}
