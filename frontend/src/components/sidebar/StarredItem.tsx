import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { StarIcon } from "@/components/ui/icons";
import { feedItemStyles, sidebarItemIconStyles } from "./styles";

interface StarredItemProps {
  isActive?: boolean;
  count?: number;
  onClick?: () => void;
}

/**
 * 侧栏星标入口（2026-09-18 用户要求收敛）。
 *
 * - 文案就叫「星标」（原来叫「已加星标」）；
 * - 行尾那个「当前视图」开关**已删掉**（用户原话：「去掉右侧的当前视图，保留第二栏的当前视图」）——
 *   同一语义只留第二栏列表头那一个图标按钮，免得两处都能改、状态还各说各话。
 *   这一行点进来即是「只当前视图」那一档（默认选中，取数时带上当前内容类型）。
 */
export function StarredItem({
  isActive = false,
  count = 0,
  onClick,
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
      {/* 数量角标：样式与订阅行的未读数一致（0 不显示、>99 显示 99+） */}
      {count > 0 && (
        <span className="shrink-0 text-[0.7rem] font-medium tabular-nums text-muted-foreground">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </div>
  );
}
