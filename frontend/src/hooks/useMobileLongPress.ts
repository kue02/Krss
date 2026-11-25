import { useEffect, useRef, type MouseEvent, type TouchEvent } from "react";

const LONG_PRESS_MS = 520;
const MOVE_TOLERANCE_PX = 10;

/**
 * 移动端条目长按：按住约 0.5 秒触发 onLongPress；滑动超过 10px 取消，
 * 触发后吞掉随后那次 click，避免同时进入详情。
 */
export type LongPressPoint = { x: number; y: number };

export interface MobileLongPressOptions {
  /**
   * 行根本身就是 `<button>` 时（如 Inoreader 列表行）传 true：
   * 只放行带 `data-long-press-root` 的那一个根按钮，行内嵌套按钮/链接仍不触发长按。
   */
  allowButtonRoot?: boolean;
}

export function useMobileLongPress(
  enabled: boolean,
  onLongPress?: (point: LongPressPoint) => void,
  options: MobileLongPressOptions = {},
) {
  const allowButtonRoot = options.allowButtonRoot ?? false;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);

  const clear = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  };

  const armSuppressClick = () => {
    suppressClickRef.current = true;
    if (suppressResetRef.current !== null) {
      clearTimeout(suppressResetRef.current);
    }
    suppressResetRef.current = setTimeout(() => {
      suppressClickRef.current = false;
      suppressResetRef.current = null;
    }, 450);
  };

  useEffect(() => {
    return () => {
      clear();
      if (suppressResetRef.current !== null) clearTimeout(suppressResetRef.current);
    };
  }, []);

  const onTouchStart = (event: TouchEvent<HTMLElement>) => {
    if (!enabled || !onLongPress) return;
    const target = event.target as HTMLElement | null;
    const interactive = target?.closest("a, button, input, textarea, select");
    if (
      interactive &&
      !(
        allowButtonRoot &&
        interactive instanceof HTMLElement &&
        interactive.hasAttribute("data-long-press-root")
      )
    ) {
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    firedRef.current = false;
    startRef.current = { x: touch.clientX, y: touch.clientY };
    timerRef.current = setTimeout(() => {
      if (firedRef.current) return;
      firedRef.current = true;
      const point = startRef.current;
      if (point) onLongPress(point);
      armSuppressClick();
      timerRef.current = null;
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (event: TouchEvent<HTMLElement>) => {
    const start = startRef.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    if (
      Math.abs(touch.clientX - start.x) > MOVE_TOLERANCE_PX ||
      Math.abs(touch.clientY - start.y) > MOVE_TOLERANCE_PX
    ) {
      clear();
    }
  };

  const onTouchEnd = () => clear();
  const onTouchCancel = () => clear();

  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!enabled || !onLongPress) return;
    event.preventDefault();
    const target = event.target as HTMLElement | null;
    const interactive = target?.closest("a, button, input, textarea, select");
    if (
      interactive &&
      !(
        allowButtonRoot &&
        interactive instanceof HTMLElement &&
        interactive.hasAttribute("data-long-press-root")
      )
    ) {
      return;
    }
    if (firedRef.current) {
      // 同一手势里 timer 已触发过（suppress click 窗口内）就不再重复打开；
      // 窗口外的 contextmenu（鼠标右键 / 外接设备）仍应正常工作。
      if (suppressClickRef.current) return;
      firedRef.current = false;
    }
    firedRef.current = true;
    const fallback = startRef.current;
    const point = {
      x: event.clientX || fallback?.x || 0,
      y: event.clientY || fallback?.y || 0,
    };
    clear();
    onLongPress(point);
    armSuppressClick();
  };

  const consumeClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    if (suppressResetRef.current !== null) {
      clearTimeout(suppressResetRef.current);
      suppressResetRef.current = null;
    }
    return true;
  };

  return {
    consumeClick,
    touchHandlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel,
      onContextMenu,
    },
  };
}
