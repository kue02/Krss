import type { ReactNode } from "react";
import { Badge } from "@heroui/react";
import { useUISettingKey } from "@/hooks/useUISettings";
import { cn } from "@/lib/utils";

/**
 * 已读/未读标记（用户 11-14 统一，12-2 改成挂到**条目图标的左上角**）。
 *
 * 用户 12-2 原话：「未读 Badge，在左上角设置『点状徽标』」+「去看 heroui 的这个组件，
 * 就是在条目的那个图标左上角」—— 用的就是 HeroUI Badge 官方的 `Badge.Anchor` +
 * `placement="top-left"`；官方「点状徽标」= 空内容的 Badge（`<Badge />`）。
 *
 * 三个档（设置 → 外观 → 阅读 →「未读标记」）：
 * - badge / dot：**都是小圆点**（12-14 用户改口：不要文字，就是圆点），差别只留在设置项上
 * - dim：不在图标上挂东西，改为整行降透明度（由 `unreadRowClass()` 负责）
 */
export function UnreadIndicator({
  unread,
  children,
  className,
}: {
  unread: boolean;
  /** 被标记的图标（favicon / 头像）—— 徽标定位在它左上角 */
  children?: ReactNode;
  className?: string;
}) {
  const style = useUISettingKey("unreadStyle");

  if (style === "dim" || !unread || !children) {
    return <div className={cn("shrink-0", className)}>{children}</div>;
  }

  return (
    <Badge.Anchor className={cn("relative shrink-0", className)}>
      {children}
      {/*
        12-14：标记一律是**小圆点**（用户：「这个不是字，也是小圆点」）。
        用 HeroUI 的「点状徽标」= 空内容 Badge，placement=top-left 让它压在图标左上角上
        （用户要的就是轻微吃掉一点图标边缘，而不是浮在图标外面）。
        `-translate-x-1 -translate-y-1` 是把它再往左上挪一点，视觉上更像「角标」。
      */}
      <Badge
        placement="top-left"
        color="accent"
        size="sm"
        variant="primary"
        data-unread-marker={style === "dot" ? "dot" : "badge"}
        className="-translate-x-1 -translate-y-1"
      />
    </Badge.Anchor>
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
