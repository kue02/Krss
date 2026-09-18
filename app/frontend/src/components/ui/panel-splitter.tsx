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
   * 是否**常显**分界限（默认 true）。
   *
   * 用户 12-5 澄清：「悬浮只是显示，不需要控制悬浮，这个设置只是控制，如果不悬浮，它也显示，
   * 并且可以显示在哪个视图下」—— 所以设置项管的是这条线**平时画不画**，
   * 悬浮时的拖拽指示线照旧（不受设置影响）。关掉时只影响这条线，栏宽仍按上次拖好的值保留。
   */
  visible?: boolean;
}

export function PanelSplitter({
  isDragging,
  onPointerDown,
  onTouchStart,
  onDoubleClick,
  className,
  tooltip,
  visible = true,
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
        {visible && (
          <Separator
            orientation="vertical"
            className={cn(
              "h-full w-px bg-border transition-colors duration-200",
              "group-hover:bg-muted-foreground/50",
              isDragging && "bg-primary",
            )}
          />
        )}
      </div>
    </div>
  );
}
