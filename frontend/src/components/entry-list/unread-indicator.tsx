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
          // 20-1：别用 color="accent"——HeroUI 的 accent 在浅色主题下解析成近黑色
          // （实测 rgb(1,6,10)），8px 小点压在彩色 favicon 上直接隐身。
          // `bg-primary` 也被 Badge 自身 variant 背景盖掉，只能内联 `--accent`（主题里是对的）。
          size="sm"
          variant="primary"
          data-unread-marker="dot"
          // 21-1：HeroUI 自带 translate(25%) 已经把圆点往外推了 4px，
          // 再写 -translate 会把圆点几乎整个推到图标外面、看着像被切掉一半。
          // 去掉外推，让圆点对半压在图标边上（Folo 式）+ 白边托出来，保证完整可见。
          className="size-2 min-h-0 min-w-0 rounded-full"
          style={{
            backgroundColor: "var(--accent)",
            boxShadow: "0 0 0 1.5px var(--background)",
          }}
        />
      </Badge.Anchor>
    );
  }

  /**
   * 「压住边缘」= 角标**压进图标里多少 px**，四角同一套算法（真机实测修正过）：
   *
   * HeroUI 的 `placement` 只给 `left/right/top/bottom: 0` 加一个 `translate(±25%)`，
   * 而我们在同一元素上写内联 `transform`，内联会把组件那条百分比位移**整个顶掉** ——
   * 上一版按「HeroUI 自带 4px + 用户值」折算成固定 px（`shift = 4 + offset`），
   * 结果默认档就把角标推到图标**外面**（实测 top-right 时右缘超出图标 8px、完全不压边）。
   *
   * 正解：直接用 `calc(±100% ∓ offset)`，`100%` 是角标自己的宽/高（数字档宽度是内容撑的，也能算对），
   * 这样「角标内侧边缘与图标边缘的距离」恒等于用户设的 offset，四角对称、与尺寸无关。
   */
  const inward = `calc(-100% + ${config.offset}px)`; // 左/上：往图标里推
  const outward = `calc(100% - ${config.offset}px)`; // 右/下：往图标里推（负方向）
  const translateX = config.placement.includes("left") ? inward : outward;
  const translateY = config.placement.includes("top") ? inward : outward;
  const isCount = config.content === "count";
  const label = isCount ? (count && count > 99 ? "99+" : String(count ?? "")) : "";
  const customColor = config.followAccent ? null : config.customColor;
  /**
   * 「未读数」档的盒子要比圆点大一圈 —— 里面要装一个数字。
   * 效果图里圆点是 8px、未读数胶囊是 17px（≈ 大小 ×2），这里取「大小 + 8」：
   * 默认档 8 → 16px 胶囊，拉满 16 → 24px，滑杆仍然有可见效果，且数字不会溢出盒子。
   */
  const boxSize = isCount ? config.size + 8 : config.size;

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
          height: boxSize,
          width: isCount ? "auto" : boxSize,
          minWidth: boxSize,
          paddingInline: isCount ? 4 : 0,
          transform: `translate(${translateX}, ${translateY})`,
          ...(customColor ? { backgroundColor: customColor } : null),
          // 21-1：小圆点压在彩色 favicon 上难看见，加一圈底色描边托出来（只作用于 dot 内容）
          ...(isCount ? null : { boxShadow: "0 0 0 1.5px var(--background)" }),
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
