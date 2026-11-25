import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSwipeGesture } from "@/hooks/useSwipeGesture";
import { useMarkAsRead, useMarkAsStarred } from "@/hooks/useEntries";
import { readToggleAction } from "@/components/entry-list/read-toggle-action";
import type { Entry } from "@/types/api";

/** 露出的两个动作各占 66px，合计 132px（内容整体左移这么多） */
const ACTION_WIDTH = 132;

/** 松手判定的横向速度阈值（px/ms）：超过则按速度方向吸附 */
const FLING_VELOCITY = 0.4;

/** 打开某一行时广播，其它行收到后收起自己（保证同时只展开一条） */
const SWIPE_OPEN_EVENT = "krss:mobile-swipe-open";

interface MobileSwipeEntryRowProps {
  entry: Entry;
  children: ReactNode;
  /**
   * 第四十三批（移动端性能）：社交视图的大卡片（图集，行高数百 px）在离屏时
   * 跳过布局/绘制。只在社交非虚拟列表分支传 true；文章/普通列表行高仅 42–80px，
   * 600px 的估算高度会把滚动高度撑坏，所以那里不传。
   */
  contentVisibility?: boolean;
}

/**
 * 47-2：移动端条目「左滑露出快捷动作」。
 *
 * 只包 `EntryListItem`，不改它内部结构：
 *   内容层（不透明 `bg-background`）盖住右侧动作条；左滑后内容层
 *   `translateX(-132px)` 滑出，露出「已读/未读切换 + 星标」两格。
 *
 * 跟手（用户 2026-11-25 要求）：不再等手势结束才展开。手指拖动过程中内容层
 * 实时跟随位移、右侧动作条逐渐露出（`useSwipeGesture` 的 onDrag* 逐帧回调）；
 * 松手时超过半宽或速度够快则吸附展开，否则回弹。已展开时向右拖可收起。
 *
 * - 位移限制在 [-ACTION_WIDTH, 0]，不会把内容拖出屏幕；
 * - 拖动时 `transition: none`，松手后 `transition-transform duration-200 ease-out` 吸附；
 * - 与长按不冲突：长按在卡片内部（移动超过 10px 即取消），滑动由本层识别；
 * - 与「右滑开侧栏」不冲突：右滑仅在已展开时用于收起，未展开时右拖位移被夹在 0；
 * - 与虚拟列表测量不冲突：外层 `overflow-hidden`，仅横向 transform，行高不变。
 */
export function MobileSwipeEntryRow({
  entry,
  children,
  contentVisibility = false,
}: MobileSwipeEntryRowProps) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  /** 拖动中的实时位移（px，0 ~ -ACTION_WIDTH）；null 表示非拖动，由 open 决定 */
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  /** 拖动起点的基准位移（展开 = -ACTION_WIDTH，收起 = 0） */
  const baseOffsetRef = useRef(0);
  const { mutate: markAsRead } = useMarkAsRead();
  const { mutate: markAsStarred } = useMarkAsStarred();

  const readAction = readToggleAction(!entry.read);
  const ReadIcon = readAction.Icon;
  const isStarred = !!entry.starred;

  const close = useCallback(() => setOpen(false), []);
  const openRow = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent<string>(SWIPE_OPEN_EVENT, { detail: entry.id }),
    );
    setOpen(true);
  }, [entry.id]);

  const handleDragStart = useCallback(() => {
    baseOffsetRef.current = open ? -ACTION_WIDTH : 0;
    setDragOffset(baseOffsetRef.current);
  }, [open]);

  const handleDragMove = useCallback((offsetX: number) => {
    const next = Math.min(
      0,
      Math.max(-ACTION_WIDTH, baseOffsetRef.current + offsetX),
    );
    setDragOffset(next);
  }, []);

  const handleDragEnd = useCallback(
    (offsetX: number, velocityX: number) => {
      const offset = baseOffsetRef.current + offsetX;
      let shouldOpen: boolean;
      if (velocityX <= -FLING_VELOCITY) {
        shouldOpen = true; // 快速左甩 → 展开
      } else if (velocityX >= FLING_VELOCITY) {
        shouldOpen = false; // 快速右甩 → 收起
      } else {
        shouldOpen = Math.abs(offset) > ACTION_WIDTH / 2;
      }
      setDragOffset(null);
      if (shouldOpen) openRow();
      else close();
    },
    [close, openRow],
  );

  useSwipeGesture(rowRef, {
    enabledDirections: ["left", "right"],
    threshold: 30,
    velocityThreshold: 0.2,
    preventScroll: true,
    onDragStart: handleDragStart,
    onDragMove: handleDragMove,
    onDragEnd: handleDragEnd,
  });

  // 同时只展开一条：别的行打开时收起自己
  useEffect(() => {
    const handler = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== entry.id) setOpen(false);
    };
    window.addEventListener(SWIPE_OPEN_EVENT, handler);
    return () => window.removeEventListener(SWIPE_OPEN_EVENT, handler);
  }, [entry.id]);

  // 展开时：点行外 / 滚动列表都收起
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rowRef.current && !rowRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // 展开时点内容区：先收起，不进入详情（capture 阶段拦在卡片 onClick 之前）
  const handleContentClickCapture = (event: React.MouseEvent) => {
    if (!open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };

  const dragging = dragOffset !== null;
  const displayOffset = dragging ? dragOffset : open ? -ACTION_WIDTH : 0;

  return (
    <div
      ref={rowRef}
      className={cn(
        "relative overflow-hidden",
        contentVisibility &&
          "[content-visibility:auto] [contain-intrinsic-size:auto_600px]",
      )}
      data-swipe-row
    >
      {/* 动作条：旧版样式，在内容层背后、右侧对齐，内容层左移即逐渐露出 */}
      <div
        aria-hidden={!open}
        className={cn(
          "absolute bottom-0.5 right-2 top-0.5 z-0 flex overflow-hidden rounded-[10px] border border-border/60 bg-item-hover",
          !open && "pointer-events-none",
        )}
        style={{ width: ACTION_WIDTH }}
        data-swipe-actions
      >
        <button
          type="button"
          tabIndex={open ? 0 : -1}
          aria-label={t(readAction.labelKey)}
          onClick={() => {
            close();
            markAsRead({ id: entry.id, read: readAction.nextRead });
          }}
          className="group/act flex w-1/2 items-center justify-center"
        >
          <span className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 group-hover/act:bg-item-hover group-hover/act:text-foreground">
            <ReadIcon className="size-[15px]" />
          </span>
        </button>
        <button
          type="button"
          tabIndex={open ? 0 : -1}
          aria-label={t(
            isStarred ? "entry.remove_from_starred" : "entry.add_to_starred",
          )}
          onClick={() => {
            close();
            markAsStarred({ id: entry.id, starred: !isStarred });
          }}
          className="group/act flex w-1/2 items-center justify-center"
        >
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-full transition-colors duration-150 group-hover/act:bg-item-hover",
              isStarred
                ? "text-amber-500"
                : "text-muted-foreground group-hover/act:text-foreground",
            )}
          >
            <Star
              className={cn(
                "size-[15px]",
                isStarred && "fill-amber-500 text-amber-500",
              )}
            />
          </span>
        </button>
      </div>

      {/* 内容层：不透明底盖住动作条；拖动时实时跟随，松手后吸附 */}
      <div
        onClickCapture={handleContentClickCapture}
        data-swipe-content
        className={cn(
          "relative z-10",
          dragging
            ? "transition-none"
            : "transition-transform duration-200 ease-out",
          open
            ? "bg-item-hover shadow-[-10px_0_18px_-8px_rgba(0,0,0,0.28)]"
            : "bg-background",
        )}
        style={{ transform: `translateX(${displayOffset}px)` }}
      >
        {children}
      </div>
    </div>
  );
}
