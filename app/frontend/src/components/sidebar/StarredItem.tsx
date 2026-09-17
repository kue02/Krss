import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { StarIcon } from "@/components/ui/icons";
import { feedItemStyles, sidebarItemIconStyles } from "./styles";
import type { ContentType } from "@/types/api";

interface StarredItemProps {
  isActive?: boolean;
  count?: number;
  onClick?: () => void;
  /**
   * 「只显示当前视图的星标」那一档（2026-09-17 用户要求，挂在「已加星标」上面）。
   * 星标条目跨所有内容类型，这一档只看当前内容类型（文章/图片/通知/社交媒体）下的，
   * 并把它标出来，免得两个入口看起来一模一样。
   */
  viewOnly?: boolean;
  contentType?: ContentType;
}

export function StarredItem({
  isActive = false,
  count = 0,
  onClick,
  viewOnly = false,
  contentType,
}: StarredItemProps) {
  const { t } = useTranslation();

  return (
    <div
      data-active={isActive}
      className={cn(feedItemStyles, "mt-1 pl-2.5")}
      onClick={onClick}
    >
      <span className={sidebarItemIconStyles}>
        <StarIcon className="size-4 -translate-y-px text-amber-500" />
      </span>
      <span className="grow">
        {t(viewOnly ? "sidebar.starred_view" : "sidebar.starred")}
      </span>
      {viewOnly && contentType && (
        <span className="shrink-0 rounded-[4px] border border-border/60 bg-secondary/40 px-1.5 py-px text-[11px] font-medium leading-4 text-muted-foreground">
          {t(`content_type.${contentType}`)}
        </span>
      )}
      {/* 两档都带数量（用户 11-15）：上一档是当前内容类型下的星标数，下一档是全部星标数。
          样式与订阅行的未读数一致（同一处观感，别再各写一套） */}
      {count > 0 && (
        <span className="shrink-0 text-[0.7rem] font-medium tabular-nums text-muted-foreground">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </div>
  );
}
