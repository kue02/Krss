import { useRef, useCallback, useEffect } from "react";

export type SwipeDirection = "left" | "right" | "up" | "down";

interface UseSwipeGestureOptions {
  onSwipe?: (direction: SwipeDirection) => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  /**
   * 逐帧跟手回调（可选）。仅在传入时生效：横向手势一旦被判定为滑动（非纵向滚动）
   * 就会从 onDragStart 起，每次 touchmove 触发 onDragMove，松手时触发 onDragEnd。
   * 不传这些回调时，行为与旧版完全一致（只在手势结束时回调 onSwipe*）。
   */
  onDragStart?: () => void;
  /** offsetX/offsetY 为相对起点的位移（px），velocityX 为瞬时横向速度（px/ms，向右为正） */
  onDragMove?: (offsetX: number, offsetY: number, velocityX: number) => void;
  /** 松手时的位移与横向速度（px/ms，向右为正）；速度在采样过短时按 0 处理；canceled=true 表示 touchcancel */
  onDragEnd?: (offsetX: number, velocityX: number, canceled?: boolean) => void;
  threshold?: number; // Minimum distance for a swipe (px)
  velocityThreshold?: number; // Minimum velocity for a swipe (px/ms)
  enabledDirections?: SwipeDirection[]; // Which directions to detect
  preventScroll?: boolean; // Prevent default scroll behavior during horizontal swipe
  startFrom?: {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
  }; // Restrict gesture start area, useful for edge swipes on mobile
  enabled?: boolean; // Whether to register touch listeners (default true)
}

interface TouchState {
  startX: number;
  startY: number;
  startTime: number;
  currentX: number;
  currentY: number;
  prevX: number; // 上一次采样点（用于瞬时速度）
  prevTime: number;
  /** 最近一次 touchmove 采样到的瞬时横向速度（px/ms，向右为正） */
  lastVelocityX: number;
  /** 最近一次采样的时间戳，用于 touchend 判断该速度是否仍然新鲜 */
  lastMoveTime: number;
  isScrolling: boolean | null; // null = undetermined, true = vertical scroll, false = horizontal swipe
  dragging: boolean; // 是否已进入逐帧跟手阶段（仅在判定为横向后置真）
}

const DIRECTION_LOCK_RATIO = 1.2;

/** 速度采样间隔过短（同一 tick 内的合成事件）时速度不可信，按 0 处理 */
const MIN_VELOCITY_SAMPLE_MS = 8;

/**
 * touchend 距最后一次 touchmove 的时长上限：超过则视为手指已停稳，速度按 0 处理。
 * 手指停住后才松手不该被判成「甩动」。
 */
const FLING_SAMPLE_WINDOW_MS = 80;

export function useSwipeGesture(
  elementRef: React.RefObject<HTMLElement | null>,
  options: UseSwipeGestureOptions = {},
) {
  const {
    onSwipe,
    onSwipeLeft,
    onSwipeRight,
    onSwipeUp,
    onSwipeDown,
    onDragStart,
    onDragMove,
    onDragEnd,
    threshold = 50,
    velocityThreshold = 0.3,
    enabledDirections = ["left", "right", "up", "down"],
    preventScroll = true,
    startFrom,
    enabled = true,
  } = options;

  const touchState = useRef<TouchState | null>(null);

  // 逐帧回调放进 ref，避免每次渲染都因回调引用变化而重挂监听
  const dragHandlers = useRef({ onDragStart, onDragMove, onDragEnd });
  dragHandlers.current = { onDragStart, onDragMove, onDragEnd };

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;

      const element = elementRef.current;
      if (element && startFrom) {
        const rect = element.getBoundingClientRect();
        const withinLeft =
          startFrom.left === undefined ||
          touch.clientX <= rect.left + startFrom.left;
        const withinRight =
          startFrom.right === undefined ||
          touch.clientX >= rect.right - startFrom.right;
        const withinTop =
          startFrom.top === undefined ||
          touch.clientY <= rect.top + startFrom.top;
        const withinBottom =
          startFrom.bottom === undefined ||
          touch.clientY >= rect.bottom - startFrom.bottom;

        if (!withinLeft || !withinRight || !withinTop || !withinBottom) {
          touchState.current = null;
          return;
        }
      }

      const now = Date.now();
      touchState.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        startTime: now,
        currentX: touch.clientX,
        currentY: touch.clientY,
        prevX: touch.clientX,
        prevTime: now,
        lastVelocityX: 0,
        lastMoveTime: now,
        isScrolling: null,
        dragging: false,
      };
    },
    [elementRef, startFrom],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!touchState.current) return;

      const touch = e.touches[0];
      if (!touch) return;

      const state = touchState.current;
      state.currentX = touch.clientX;
      state.currentY = touch.clientY;

      // Determine if this is a scroll or swipe on first significant move
      if (state.isScrolling === null) {
        const deltaX = Math.abs(touch.clientX - state.startX);
        const deltaY = Math.abs(touch.clientY - state.startY);

        // Need at least 10px movement to determine direction
        if (deltaX > 10 || deltaY > 10) {
          if (deltaX > deltaY * DIRECTION_LOCK_RATIO) {
            state.isScrolling = false;
          } else if (deltaY > deltaX * DIRECTION_LOCK_RATIO) {
            state.isScrolling = true;
          }
        }
      }

      // If determined to be horizontal swipe and preventScroll is enabled, prevent default
      if (
        preventScroll &&
        state.isScrolling === false &&
        (enabledDirections.includes("left") ||
          enabledDirections.includes("right"))
      ) {
        e.preventDefault();
      }

      // 逐帧跟手：仅在判定为横向滑动后触发（纵向滚动不进入）
      if (state.isScrolling === false) {
        const handlers = dragHandlers.current;
        if (handlers.onDragStart || handlers.onDragMove) {
          if (!state.dragging) {
            state.dragging = true;
            handlers.onDragStart?.();
          }
          const now = Date.now();
          const elapsed = now - state.prevTime;
          const velocityX =
            elapsed >= MIN_VELOCITY_SAMPLE_MS
              ? (touch.clientX - state.prevX) / elapsed
              : 0;
          // 在更新 prevX/prevTime 之前把本次瞬时速度留档：touchend 时 currentX 已等于 prevX，
          // 再算只会得到 0，快速甩动分支就永远不生效（本次修复的核心缺陷）。
          state.lastVelocityX = velocityX;
          state.lastMoveTime = now;
          state.prevX = touch.clientX;
          state.prevTime = now;
          handlers.onDragMove?.(
            touch.clientX - state.startX,
            touch.clientY - state.startY,
            velocityX,
          );
        }
      }
    },
    [preventScroll, enabledDirections],
  );

  const handleTouchEnd = useCallback(() => {
    if (!touchState.current) return;

    const state = touchState.current;

    // 逐帧跟手：松手交给调用方决定吸附到哪个位置
    if (state.dragging) {
      const handlers = dragHandlers.current;
      const now = Date.now();
      // 用最后一次 move 采样到的瞬时速度；手指已停稳（距上次采样超过 80ms）则视为 0。
      // 注意这里不能再拿 currentX - prevX 计算：move 已把 prevX 同步为 currentX，结果恒为 0。
      const velocityX =
        now - state.lastMoveTime <= FLING_SAMPLE_WINDOW_MS
          ? state.lastVelocityX
          : 0;
      handlers.onDragEnd?.(state.currentX - state.startX, velocityX);
      touchState.current = null;
      return;
    }

    // Don't trigger swipe if it's a scroll gesture
    if (state.isScrolling === true) {
      touchState.current = null;
      return;
    }

    const deltaX = state.currentX - state.startX;
    const deltaY = state.currentY - state.startY;
    const deltaTime = Math.max(1, Date.now() - state.startTime); // Prevent division by zero

    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const velocity = Math.max(absX, absY) / deltaTime;

    let direction: SwipeDirection | null = null;

    // Horizontal swipe detection
    if (absX > absY * DIRECTION_LOCK_RATIO) {
      if (absX > threshold || velocity > velocityThreshold) {
        if (deltaX > 0 && enabledDirections.includes("right")) {
          direction = "right";
          onSwipeRight?.();
        } else if (deltaX < 0 && enabledDirections.includes("left")) {
          direction = "left";
          onSwipeLeft?.();
        }
      }
    }
    // Vertical swipe detection
    else if (absY > absX * DIRECTION_LOCK_RATIO) {
      if (absY > threshold || velocity > velocityThreshold) {
        if (deltaY > 0 && enabledDirections.includes("down")) {
          direction = "down";
          onSwipeDown?.();
        } else if (deltaY < 0 && enabledDirections.includes("up")) {
          direction = "up";
          onSwipeUp?.();
        }
      }
    }

    if (direction) {
      onSwipe?.(direction);
    }

    touchState.current = null;
  }, [
    threshold,
    velocityThreshold,
    enabledDirections,
    onSwipe,
    onSwipeLeft,
    onSwipeRight,
    onSwipeUp,
    onSwipeDown,
  ]);

  const handleTouchCancel = useCallback(() => {
    const state = touchState.current;
    if (!state) return;
    if (state.dragging) {
      // 取消按「取消」结算：调用方应回到手势前状态，而不是按位移/速度展开
      dragHandlers.current.onDragEnd?.(
        state.currentX - state.startX,
        0,
        true,
      );
    }
    touchState.current = null;
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !enabled) {
      touchState.current = null;
      return;
    }

    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: false });
    element.addEventListener("touchend", handleTouchEnd, { passive: true });
    element.addEventListener("touchcancel", handleTouchCancel, {
      passive: true,
    });

    return () => {
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("touchend", handleTouchEnd);
      element.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, [
    elementRef,
    enabled,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
  ]);
}
