import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSwipeGesture } from "@/hooks/useSwipeGesture";
import { useUISettingKey } from "@/hooks/useUISettings";
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
  const swipeActionStyle = useUISettingKey("mobileSwipeActionStyle") ?? "flat";
  const isCircleAction = swipeActionStyle === "circle";
  const rowRef = useRef<HTMLDivElement>(null);
  /** 内容层节点：拖动期间直接写它的 transform，不触发 React 重渲染 */
  const contentRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  /**
   * 动作面板贴合内容卡片实测的内缩（px）与右圆角（任务 6b）。
   *
   * 动作面板本身压在内容层下面，露出的一截要用「内容层里那张卡片」的边界和圆角去对齐：
   * 社交卡是满宽 `rounded-xl`（12px），文章卡在 <640 是满宽直角、≥640 是 `mx-2 my-0.5 rounded-[10px]`。
   * 固定写死 right-2/top-0.5/rounded-10 只在后一种情况贴合，所以展开时实测卡片 offset/圆角再写进内联样式。
   * circle 分支是浮在底图上的圆形按钮、没有底板，不套圆角，但同样按卡片实测内缩，
   * 免得窄卡/贴边卡片上圆钮压在卡片外。
   */
  const [actionsInset, setActionsInset] = useState<{
    top: number;
    right: number;
    bottom: number;
    radius: string;
  } | null>(null);
  /** 拖动起点的基准位移（展开 = -ACTION_WIDTH，收起 = 0） */
  const baseOffsetRef = useRef(0);
  /** 拖动中的目标位移（px，0 ~ -ACTION_WIDTH）；null 表示当前未拖动 */
  const dragOffsetRef = useRef<number | null>(null);
  /** 合并到下一帧的 rAF 句柄，保证每帧最多写一次 DOM */
  const rafRef = useRef<number | null>(null);
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

  /** 取消尚未执行的合帧（touchend / 卸载时用） */
  const cancelPendingFrame = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /** rAF 回调：把最新目标位移写到内容层（每帧最多一次） */
  const flushDragTransform = useCallback(() => {
    rafRef.current = null;
    const content = contentRef.current;
    const offset = dragOffsetRef.current;
    if (content && offset !== null) {
      content.style.transform = `translateX(${offset}px)`;
    }
  }, []);

  const scheduleDragTransform = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(flushDragTransform);
  }, [flushDragTransform]);

  /**
   * 任务 6a：横向滑动开始时清掉 m3-ripple 的按压态。
   *
   * `useSwipeGesture` 在横向 touchmove 里 `preventDefault()` 掉了后续 click，
   * 而 m3-ripple 只在 `click` / `pointercancel` 清 `--press` —— 滑动两者都不会走到，
   * 于是 `.salty-ripple-surface.--press::after` 的 0.05 压感一直留在整卡上（看起来像选中不回弹）。
   * 这里在拖动起点主动摘掉 `--press` 并取消残留的 ::after 动画，压感随过渡淡出，
   * 卡片本身恢复原色；同时保留移动端的按压反馈（不再靠 pressedOpacity=0 硬关）。
   */
  const clearPressedRipple = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const surfaces = content.querySelectorAll<HTMLElement>(
      ".salty-ripple-surface.--press",
    );
    for (const surface of surfaces) {
      surface.classList.remove("--press");
      surface.getAnimations?.({ subtree: true }).forEach((a) => a.cancel());
    }
  }, []);

  const handleDragStart = useCallback(() => {
    clearPressedRipple();
    baseOffsetRef.current = open ? -ACTION_WIDTH : 0;
    dragOffsetRef.current = baseOffsetRef.current;
    const content = contentRef.current;
    if (content) {
      // 拖动期间关掉过渡，保证内容层严格跟手；松手时再恢复类上的过渡
      content.style.transition = "none";
      content.style.transform = `translateX(${baseOffsetRef.current}px)`;
    }
  }, [clearPressedRipple, open]);

  const handleDragMove = useCallback(
    (offsetX: number) => {
      const next = Math.min(
        0,
        Math.max(-ACTION_WIDTH, baseOffsetRef.current + offsetX),
      );
      dragOffsetRef.current = next;
      scheduleDragTransform();
    },
    [scheduleDragTransform],
  );

  const handleDragEnd = useCallback(
    (offsetX: number, velocityX: number, canceled = false) => {
      // touchcancel 属于「取消」：不按位移/速度判定，直接回到手势前的 open 状态
      const wasOpen = baseOffsetRef.current === -ACTION_WIDTH;
      const offset = baseOffsetRef.current + offsetX;
      let shouldOpen: boolean;
      if (canceled) {
        shouldOpen = wasOpen;
      } else if (velocityX <= -FLING_VELOCITY) {
        shouldOpen = true; // 快速左甩 → 展开
      } else if (velocityX >= FLING_VELOCITY) {
        shouldOpen = false; // 快速右甩 → 收起
      } else {
        shouldOpen = Math.abs(offset) > ACTION_WIDTH / 2;
      }

      cancelPendingFrame();
      dragOffsetRef.current = null;
      const content = contentRef.current;
      if (content) {
        // 恢复类上的 transition（内联清空后由 className 接管），直接吸附到目标位移。
        // 强制一次样式计算，确保恢复的过渡在 transform 变化前已生效，吸附才有动画。
        content.style.transition = "";
        void content.offsetWidth;
        content.style.transform = `translateX(${shouldOpen ? -ACTION_WIDTH : 0}px)`;
      }
      if (shouldOpen) openRow();
      else close();
    },
    [cancelPendingFrame, close, openRow],
  );

  // 卸载时清掉挂起的合帧，避免回调落到已卸载节点
  useEffect(() => cancelPendingFrame, [cancelPendingFrame]);

  // 非拖动时由 open 驱动内容层位移（点外部 / 滚动 / 他行 SWIPE_OPEN_EVENT 收起都走这里）。
  // 拖动中（dragOffsetRef 非空）不接管：外部 open 变化不得覆盖当前手指位移。
  // 内容层不再由 React 渲染 style，避免 React 用 open 的新值覆盖 rAF 写入的 transform。
  useLayoutEffect(() => {
    if (dragOffsetRef.current !== null) return;
    const content = contentRef.current;
    if (!content) return;
    content.style.transition = "";
    content.style.transform = `translateX(${open ? -ACTION_WIDTH : 0}px)`;
  }, [open]);

  // 任务 6b：展开时实测内容卡片边界，让动作面板的上下右内缩与右圆角跟卡片对齐。
  // 用 offsetLeft/offsetWidth 求右侧（不受内容层 translateX 影响），用 getBoundingClientRect
  // 求上下（只有横向位移，纵向不受影响），圆角直接取卡片 computed style。
  const measureActionsInset = useCallback(() => {
    const row = rowRef.current;
    const content = contentRef.current;
    const card = content?.firstElementChild as HTMLElement | null;
    if (!row || !content || !card) return;
    const rowRect = row.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const right = Math.max(
      0,
      row.clientWidth -
        (content.offsetLeft + card.offsetLeft + card.offsetWidth),
    );
    const top = Math.max(0, cardRect.top - rowRect.top);
    const bottom = Math.max(0, rowRect.bottom - cardRect.bottom);
    const radius = getComputedStyle(card).borderTopRightRadius || "0px";
    setActionsInset((prev) =>
      prev &&
      prev.top === top &&
      prev.right === right &&
      prev.bottom === bottom &&
      prev.radius === radius
        ? prev
        : { top, right, bottom, radius },
    );
  }, []);

  // 展开态里卡片几何还会变（旋转屏、字号缩放、图集图片撑高），只测一次会让面板错位，
  // 所以展开期间挂 ResizeObserver + resize/orientationchange，变了就重测。
  useLayoutEffect(() => {
    if (!open) return;
    measureActionsInset();
    const row = rowRef.current;
    const card = contentRef.current?.firstElementChild as HTMLElement | null;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measureActionsInset());
    if (observer && row) observer.observe(row);
    if (observer && card) observer.observe(card);
    window.addEventListener("resize", measureActionsInset);
    window.addEventListener("orientationchange", measureActionsInset);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureActionsInset);
      window.removeEventListener("orientationchange", measureActionsInset);
    };
  }, [open, measureActionsInset]);

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
      {/* 动作条：两种样式共用同一层；上下右内缩按内容卡片实测值内联，
          flat 另按卡片右圆角对齐（circle 是浮在底图上的圆形按钮，不套圆角） */}
      <div
        aria-hidden={!open}
        className={cn(
          "absolute z-0 flex overflow-hidden",
          isCircleAction
            ? "items-center justify-end gap-2 pr-1"
            : // rounded-[10px] 只是兜底类；真实圆角由下面内联样式按卡片实测覆盖（左侧始终 0）
              "rounded-[10px] border border-border/60 bg-item-hover",
          !open && "pointer-events-none",
        )}
        style={
          isCircleAction
            ? {
                width: ACTION_WIDTH,
                top: actionsInset?.top ?? 2,
                right: actionsInset?.right ?? 8,
                bottom: actionsInset?.bottom ?? 2,
              }
            : {
                width: ACTION_WIDTH,
                top: actionsInset?.top ?? 2,
                right: actionsInset?.right ?? 8,
                bottom: actionsInset?.bottom ?? 2,
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                borderTopRightRadius: actionsInset?.radius ?? 10,
                borderBottomRightRadius: actionsInset?.radius ?? 10,
              }
        }
        data-swipe-actions
        data-swipe-action-style={swipeActionStyle}
      >
        <button
          type="button"
          tabIndex={open ? 0 : -1}
          aria-label={t(readAction.labelKey)}
          onClick={() => {
            close();
            markAsRead({ id: entry.id, read: readAction.nextRead });
          }}
          className={cn(
            "group/act flex items-center justify-center",
            isCircleAction
              ? "size-9 rounded-full border border-border bg-card shadow-nf"
              : "w-1/2",
          )}
        >
          <span
            className={cn(
              "flex items-center justify-center transition-colors duration-150",
              isCircleAction
                ? "text-muted-foreground group-hover/act:text-foreground"
                : "size-7 rounded-full text-muted-foreground group-hover/act:bg-item-hover group-hover/act:text-foreground",
            )}
          >
            <ReadIcon className={isCircleAction ? "size-4" : "size-[15px]"} />
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
          className={cn(
            "group/act flex items-center justify-center",
            isCircleAction
              ? "size-9 rounded-full border border-border bg-card shadow-nf"
              : "w-1/2",
          )}
        >
          <span
            className={cn(
              "flex items-center justify-center transition-colors duration-150",
              isCircleAction
                ? isStarred
                  ? "text-amber-500"
                  : "text-muted-foreground group-hover/act:text-foreground"
                : cn(
                    "size-7 rounded-full",
                    isStarred
                      ? "text-amber-500"
                      : "text-muted-foreground group-hover/act:bg-item-hover group-hover/act:text-foreground",
                  ),
            )}
          >
            <Star
              className={cn(
                isCircleAction ? "size-4" : "size-[15px]",
                isStarred && "fill-amber-500 text-amber-500",
              )}
            />
          </span>
        </button>
      </div>

      {/* 内容层：不透明底盖住动作条；位移全程由 ref 直接写 DOM（rAF 跟手 + open 同步），
          不交给 React style，避免外部 open 变化覆盖拖动中的跟手位移 */}
      <div
        ref={contentRef}
        onClickCapture={handleContentClickCapture}
        data-swipe-content
        className={cn(
          "relative z-10 bg-background transition-transform duration-200 ease-out",
          open && "shadow-[-10px_0_18px_-8px_rgba(0,0,0,0.28)]",
        )}
      >
        {children}
      </div>
    </div>
  );
}
