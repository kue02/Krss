import { useEffect, useRef, type MouseEvent, type TouchEvent } from "react";

const LONG_PRESS_MS = 520;
const MOVE_TOLERANCE_PX = 10;

/**
 * 移动端条目长按：按住约 0.5 秒触发 onLongPress；滑动超过 10px 取消，
 * 触发后吞掉随后那次 click，避免同时进入详情。
 */
export function useMobileLongPress(
  enabled: boolean,
  onLongPress?: () => void,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (target?.closest("a, button, input, textarea, select")) return;
    const touch = event.touches[0];
    if (!touch) return;
    startRef.current = { x: touch.clientX, y: touch.clientY };
    timerRef.current = setTimeout(() => {
      onLongPress();
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
    clear();
    onLongPress();
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
