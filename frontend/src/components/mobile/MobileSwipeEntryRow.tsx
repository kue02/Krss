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

/** 打开某一行时广播，其它行收到后收起自己（保证同时只展开一条） */
const SWIPE_OPEN_EVENT = "krss:mobile-swipe-open";

interface MobileSwipeEntryRowProps {
  entry: Entry;
  children: ReactNode;
}

/**
 * 47-2：移动端条目「左滑露出快捷动作」。
 *
 * 只包 `EntryListItem`，不改它内部结构：
 *   内容层（不透明 `bg-background`）盖住右侧动作条；左滑后内容层
 *   `translateX(-132px)` 滑出，露出「已读/未读切换 + 星标」两格。
 *
 * - 手势复用 `useSwipeGesture`（原生非被动 touch 监听，`preventScroll` 挡住横滑时的纵向滚动）；
 * - 与长按不冲突：长按在卡片内部（移动超过 10px 即取消），滑动由本层识别；
 * - 与「右滑开侧栏」不冲突：方向不同，且右滑仅用于**收起**已展开的行；
 * - 与虚拟列表测量不冲突：外层 `overflow-hidden`，仅横向 transform，行高不变。
 * - 内容层盖住动作条靠不透明底色；所以内容必须是不透明背景（列表页底 = `bg-background`）。
 */
export function MobileSwipeEntryRow({ entry, children }: MobileSwipeEntryRowProps) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
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

  useSwipeGesture(rowRef, {
    enabledDirections: ["left", "right"],
    threshold: 30,
    velocityThreshold: 0.2,
    preventScroll: true,
    onSwipeLeft: openRow,
    onSwipeRight: () => {
      if (open) close();
    },
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

  return (
    <div ref={rowRef} className="relative overflow-hidden" data-swipe-row>
      {/* 动作条：在内容层背后，右侧对齐 */}
      <div
        aria-hidden={!open}
        className={cn(
          "absolute bottom-0.5 right-1.5 top-0.5 z-0 flex items-center justify-end gap-2 pr-1",
          !open && "pointer-events-none",
        )}
        style={{ width: ACTION_WIDTH }}
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
          <span className="flex size-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-nf transition-colors duration-150 group-hover/act:bg-item-hover group-hover/act:text-foreground">
            <ReadIcon className="size-4" />
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
              "flex size-9 items-center justify-center rounded-full border border-border bg-card shadow-nf transition-colors duration-150 group-hover/act:bg-item-hover",
              isStarred
                ? "text-amber-500"
                : "text-muted-foreground group-hover/act:text-foreground",
            )}
          >
            <Star
              className={cn(
                "size-4",
                isStarred && "fill-amber-500 text-amber-500",
              )}
            />
          </span>
        </button>
      </div>

      {/* 内容层：不透明底盖住动作条，展开时左移 */}
      <div
        onClickCapture={handleContentClickCapture}
        className={cn(
          "relative z-10 transition-transform duration-200 ease-out",
          "bg-background",
          open && "shadow-[-8px_0_16px_-10px_rgba(0,0,0,0.18)]",
        )}
        style={open ? { transform: `translateX(-${ACTION_WIDTH}px)` } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
