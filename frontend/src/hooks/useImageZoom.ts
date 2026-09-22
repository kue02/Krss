import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampOffset,
  clampScale,
  nextScale,
  offsetForZoomAt,
} from "@/lib/image-zoom";

interface Offset {
  x: number;
  y: number;
}

/**
 * 图片查看器的手势：滚轮 / 双击 / 捏合缩放，放大后拖动平移。
 *
 * 刻意做得很薄——只维护 transform，交给调用方去渲染；
 * 判定与夹取逻辑都在 lib/image-zoom 里，单独可测。
 */
export function useImageZoom(resetKey?: unknown) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: Offset;
  } | null>(null);
  const pinchRef = useRef<{
    distance: number;
    scale: number;
    center: Offset;
  } | null>(null);

  // 换图 / 关闭时复位
  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
    pinchRef.current = null;
  }, [resetKey]);

  const containerSize = useCallback(() => {
    const node = containerRef.current;
    if (!node) return { width: 0, height: 0 };
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }, []);

  const applyScale = useCallback(
    (next: number, anchor?: Offset) => {
      const target = clampScale(next);
      setScale((current) => {
        if (target === current) return current;
        setOffset((prev) => {
          const base = anchor
            ? offsetForZoomAt(anchor, current, target)
            : { x: (prev.x * target) / current, y: (prev.y * target) / current };
          return clampOffset(base, target, containerSize());
        });
        return target;
      });
    },
    [containerSize],
  );

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      event.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      const anchor = rect
        ? {
            x: event.clientX - (rect.left + rect.width / 2),
            y: event.clientY - (rect.top + rect.height / 2),
          }
        : undefined;
      applyScale(nextScale(scale, event.deltaY), anchor);
    },
    [applyScale, scale],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (scale > 1) {
        reset();
        return;
      }
      const rect = containerRef.current?.getBoundingClientRect();
      const anchor = rect
        ? {
            x: event.clientX - (rect.left + rect.width / 2),
            y: event.clientY - (rect.top + rect.height / 2),
          }
        : undefined;
      applyScale(2, anchor);
    },
    [applyScale, reset, scale],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (scale <= 1) return;
      event.stopPropagation();
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: offset,
      };
    },
    [offset, scale],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.stopPropagation();
      setOffset(
        clampOffset(
          {
            x: drag.origin.x + (event.clientX - drag.startX),
            y: drag.origin.y + (event.clientY - drag.startY),
          },
          scale,
          containerSize(),
        ),
      );
    },
    [containerSize, scale],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  // 双指捏合（触屏 / 触控板）
  const onTouchStart = useCallback(
    (event: React.TouchEvent) => {
      if (event.touches.length !== 2) return;
      const [a, b] = [event.touches[0], event.touches[1]];
      if (!a || !b) return;
      pinchRef.current = {
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        scale,
        center: offset,
      };
    },
    [offset, scale],
  );

  const onTouchMove = useCallback(
    (event: React.TouchEvent) => {
      const pinch = pinchRef.current;
      if (!pinch || event.touches.length !== 2) return;
      const [a, b] = [event.touches[0], event.touches[1]];
      if (!a || !b) return;
      event.preventDefault();
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinch.distance <= 0) return;
      applyScale(pinch.scale * (distance / pinch.distance));
    },
    [applyScale],
  );

  const onTouchEnd = useCallback(() => {
    pinchRef.current = null;
  }, []);

  const isZoomed = scale > 1;

  return {
    containerRef,
    scale,
    offset,
    isZoomed,
    reset,
    handlers: {
      onWheel,
      onDoubleClick,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onTouchStart,
      onTouchMove,
      onTouchEnd,
    },
    /** 给图片元素用的 transform */
    style: {
      transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
      transition: dragRef.current ? "none" : "transform 160ms ease-out",
      cursor: isZoomed ? "grab" : "zoom-in",
      touchAction: "none" as const,
    },
  };
}
