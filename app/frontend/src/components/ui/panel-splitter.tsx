import { Separator } from "@heroui/react";
import { cn } from "@/lib/utils";

interface PanelSplitterProps {
  isDragging?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onTouchStart?: (e: React.TouchEvent) => void;
  onDoubleClick?: () => void;
  className?: string;
  tooltip?: string;
  /**
   * 分界限的显示方式：
   * - "always"：常显（第一栏右侧那条，跟着 设置 → 外观 → 视图 的「显示分界限」走）
   * - "hover"：只在悬浮/拖拽时显示（第二栏左侧那条 —— 用户 12-15：这条保持原逻辑）
   * - "never"：不画（设置关掉时）
   *
   * 12-15 原话：「分割线这个，第二栏的分界线还是原来的逻辑，只改第一栏的」。
   * 12-5 原话：「悬浮只是显示，不需要控制悬浮，这个设置只是控制，如果不悬浮，它也显示，
   * 并且可以显示在哪个视图下」—— 关掉只影响这条线，栏宽仍按上次拖好的值保留。
   */
  visibility?: "always" | "hover" | "never";
}

export function PanelSplitter({
  isDragging,
  onPointerDown,
  onTouchStart,
  onDoubleClick,
  className,
  tooltip,
  visibility = "always",
}: PanelSplitterProps) {
  return (
    <div className={cn("relative h-full w-0 shrink-0 z-30", className)}>
      <div
        className={cn(
          "absolute inset-y-0 -left-1 w-2 cursor-ew-resize flex items-center justify-center transition-colors duration-200 group",
          "touch-none select-none",
          isDragging && "bg-secondary/30",
        )}
        onPointerDown={onPointerDown}
        onTouchStart={onTouchStart}
        onDoubleClick={onDoubleClick}
        title={tooltip}
      >
        {/* HeroUI 分隔符（12-5：用组件，不手搓 1px div）：
            开关打开时**常显**，悬浮/拖拽时加重 —— 悬浮指示线不受设置控制 */}
        {visibility !== "never" && (
          <Separator
            orientation="vertical"
            className={cn(
              "h-full w-px transition-colors duration-200",
              // hover 档继承原来的观感：平时透明，悬浮/拖拽才显出来
              visibility === "always" ? "bg-border" : "bg-transparent",
              "group-hover:bg-muted-foreground/50",
              isDragging && "bg-primary",
            )}
          />
        )}
      </div>
    </div>
  );
}
