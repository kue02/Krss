import type { ReactNode } from "react";
import { Badge } from "@heroui/react";
import { BellIcon } from "@/components/ui/icons";
import { DEFAULT_UNREAD_BADGE, useUISettingKey } from "@/hooks/useUISettings";
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
  count,
  children,
  className,
}: {
  unread: boolean;
  /** 该订阅的未读条数（13-3「未读数」内容档用；来自 useUnreadCounts 的缓存，不额外发请求） */
  count?: number;
  /** 被标记的图标（favicon / 头像）—— 徽标定位在它左上角 */
  children?: ReactNode;
  className?: string;
}) {
  const style = useUISettingKey("unreadStyle");
  // 缺省兜底：老库（或极端情况下）没有这个键时用默认配置，绝不让角标渲染崩掉
  const config = useUISettingKey("unreadBadge") ?? DEFAULT_UNREAD_BADGE;

  if (style === "dim" || !unread || !children) {
    return <div className={cn("shrink-0", className)}>{children}</div>;
  }

  /*
   * 圆点档（13-3 的默认档，用户 2026-09-18 定：「小圆点…是设置成默认的，是一个单独的样式，不变的」）：
   * 外观完全固定 —— 8px、跟随主题色、压住图标左上角 2px（HeroUI 自带 4px + 叠加 4px），
   * 不吃面板里的 位置 / 大小 / 颜色 / 外观（那几项只作用于「未读数 / 图标」两档）。
   */
  if (config.content === "dot") {
    return (
      <Badge.Anchor className={cn("relative shrink-0", className)}>
        {children}
        <Badge
          placement="top-left"
          color="accent"
          size="sm"
          variant="primary"
          data-unread-marker="dot"
          className="size-2 min-h-0 min-w-0 -translate-x-1 -translate-y-1 rounded-full"
        />
      </Badge.Anchor>
    );
  }

  /** 四档位置对应的偏移方向（HeroUI 的 placement 决定角，我们只补「压住多少」） */
  const direction: Record<string, [number, number]> = {
    "top-left": [-1, -1],
    "top-right": [1, -1],
    "bottom-left": [-1, 1],
    "bottom-right": [1, 1],
  };
  const [dx, dy] = direction[config.placement] ?? [-1, -1];
  // HeroUI 自己带 4px 偏移，这里叠加用户设的「压边」（0–6px）
  const shift = 4 + config.offset;
  const isCount = config.content === "count";
  const label = isCount ? (count && count > 99 ? "99+" : String(count ?? "")) : "";
  const customColor = config.followAccent ? null : config.customColor;

  return (
    <Badge.Anchor className={cn("relative shrink-0", className)}>
      {children}
      <Badge
        placement={config.placement}
        color={config.followAccent ? "accent" : config.color}
        size="sm"
        variant={config.variant}
        data-unread-marker={config.content}
        className={cn(
          "min-h-0 min-w-0 items-center justify-center rounded-full tabular-nums",
          // HeroUI `sm` 自带 min-width/min-height: 16px，不清掉的话「大小」永远改不动（12-14 踩过）
          "min-w-0 min-h-0",
        )}
        style={{
          height: config.size,
          width: isCount ? "auto" : config.size,
          minWidth: config.size,
          paddingInline: isCount ? 4 : 0,
          transform: `translate(${dx * shift}px, ${dy * shift}px)`,
          ...(customColor ? { backgroundColor: customColor } : null),
        }}
      >
        {isCount ? (
          <Badge.Label className="text-[10px] leading-none">{label}</Badge.Label>
        ) : (
          <span
            className="flex items-center justify-center [&>svg]:size-full"
            style={{ width: config.size * 0.6, height: config.size * 0.6 }}
          >
            <BellIcon />
          </span>
        )}
      </Badge>
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
