import { Badge } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { useUISettingKey } from "@/hooks/useUISettings";
import { cn } from "@/lib/utils";

/**
 * 已读/未读的全局统一标记（用户 11-14）。
 *
 * 以前是两个视图各写一套：社交媒体视图在条目最左侧画一个小蓝点
 * （`absolute -left-0.5 top-8 size-2 rounded-full bg-primary`），其它视图把已读的整卡降透明度。
 * 现在样式由 设置 → 外观 → 阅读 →「未读标记」统一决定，两个渲染分支共用这一个组件 + 一个行类助手，
 * 免得再各写一套、日后漂成两个样子。
 *
 * - badge：HeroUI `Badge`（用户点名要用的组件，也是默认）
 * - dot：小圆点（沿用社交媒体视图原来的观感）
 * - dim：已读变灰 —— **整卡透明度不能由本组件负责**，由 `unreadRowClass()` 给行上用
 */
export function UnreadIndicator({
  unread,
  className,
}: {
  unread: boolean;
  className?: string;
}) {
  const style = useUISettingKey("unreadStyle");
  const { t } = useTranslation();
  if (!unread || style === "dim") return null;

  if (style === "dot") {
    return (
      <span
        aria-hidden="true"
        data-unread-marker="dot"
        className={cn("size-2 shrink-0 rounded-full bg-primary", className)}
      />
    );
  }

  return (
    <Badge
      color="accent"
      size="sm"
      variant="soft"
      data-unread-marker="badge"
      className={cn("shrink-0 align-middle", className)}
    >
      {t("entry.unread")}
    </Badge>
  );
}

/**
 * 已读/未读的「整行」类（只有 `dim` 样式会给行降透明度）。
 * 两个分支原来都把这段三条件表达式写死在 className 里，现在收敛到这里。
 */
export function unreadRowClass(
  unread: boolean,
  starred: boolean,
  selected: boolean,
  style: string,
): string {
  return style === "dim" && !unread && !starred && !selected ? "opacity-[0.78]" : "";
}
