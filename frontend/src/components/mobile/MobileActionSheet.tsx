import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface MobileActionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: ReactNode;
}

/**
 * 移动端底部操作面板（iOS Action Sheet 形态）。
 *
 * 顶栏只留「返回 / 标题 / 星标 / 更多」，其余动作全部收进这里：
 * 单手可达、每行至少 52px 高、不挤压标题，也不再出现 6 颗 36px 小按钮。
 * 用 framer-motion 做 180ms 的滑入，遮罩点击与 Esc 都能关闭。
 */
export function MobileActionSheet({
  open,
  onOpenChange,
  title,
  children,
}: MobileActionSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    // 面板打开时锁住背后的文档滚动：移动端列表滚的是 html 文档，
    // 直接记下并覆盖 html 的内联 overflow，关闭时原样恢复（不抢项目共享锁类的所有权）。
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      root.style.overflow = previousOverflow;
    };
  }, [open, onOpenChange]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="mobile-action-sheet-backdrop"
            className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            // 用 pointerdown 而不是 click 关闭：长按打开时，手指抬起补发的
            // click 会命中刚出现的全屏遮罩，click 关闭会让面板刚开就关；
            // 而那次手指的 pointerdown 发生在遮罩出现之前，不会命中这里。
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) onOpenChange(false);
            }}
          />
          <motion.div
            key="mobile-action-sheet-panel"
            role="dialog"
            aria-modal="true"
            aria-label={title || "Actions"}
            className="fixed inset-x-0 bottom-0 z-50 overflow-hidden rounded-t-[22px] border-t border-border/70 bg-overlay pb-[env(safe-area-inset-bottom)] shadow-[0_-18px_50px_rgba(0,0,0,0.18)]"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
          >
            <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-border" />
            {title ? (
              <div className="px-5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {title}
              </div>
            ) : null}
            <div className="max-h-[70dvh] overflow-y-auto pb-2">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface MobileActionSheetItemProps {
  icon?: ReactNode;
  label: string;
  description?: string;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** 操作面板的一行：52px 最小点击高度，图标 20px，右侧可显示选中态。 */
export function MobileActionSheetItem({
  icon,
  label,
  description,
  selected = false,
  danger = false,
  disabled = false,
  onClick,
}: MobileActionSheetItemProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-[52px] w-full items-center gap-3 px-5 text-left transition-colors duration-150 active:bg-item-hover",
        disabled && "cursor-not-allowed opacity-45",
        danger ? "text-destructive" : "text-foreground",
      )}
    >
      {icon ? (
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center",
            danger ? "text-destructive" : "text-muted-foreground",
            selected && !danger && "text-accent",
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium leading-5">
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      {selected ? (
        <svg
          className="size-5 shrink-0 text-accent"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 12.5l4.2 4.2L19 7"
          />
        </svg>
      ) : null}
    </button>
  );
}
