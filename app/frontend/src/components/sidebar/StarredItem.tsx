import { useTranslation } from "react-i18next";
import { ToggleButton } from "@heroui/react";
import { cn } from "@/lib/utils";
import { StarIcon } from "@/components/ui/icons";
import { feedItemStyles, sidebarItemIconStyles } from "./styles";

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
  /**
   * 12-6：合并两档星标后，这一行的行尾放一个「当前视图」开关 ——
   * 打开 = 只显示当前内容类型下的星标（原来单独一行的「当前视图星标」）。
   */
  onToggleViewOnly?: () => void;
}

export function StarredItem({
  isActive = false,
  count = 0,
  onClick,
  viewOnly = false,
  onToggleViewOnly,
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
      <span className="grow truncate">{t("sidebar.starred")}</span>
      {/* 12-6：原来「当前视图星标」是单独一行，现在合并成一个行尾开关 */}
      {onToggleViewOnly && (
        <ToggleButton
          size="sm"
          isSelected={viewOnly}
          onChange={onToggleViewOnly}
          aria-label={t("sidebar.starred_view")}
          className="shrink-0 px-1.5 py-0.5 text-[11px] leading-4"
        >
          {t("sidebar.starred_view_short")}
        </ToggleButton>
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
