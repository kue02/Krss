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

interface Size {
  width: number;
  height: number;
}

interface PointerSample {
  x: number;
  y: number;
}

type Gesture =
  | {
      mode: "drag";
      pointerId: number;
      startX: number;
      startY: number;
      origin: Offset;
    }
  | {
      mode: "pinch";
      pointerIds: [number, number];
      startDistance: number;
      startScale: number;
      startOffset: Offset;
      /** 捏合开始时两指中点，相对容器中心 */
      anchor: Offset;
    };

/** 手势结束 / 双击缩放 / 回弹共用同一段短缓动 */
const ZOOM_TRANSITION = "transform 160ms ease-out";

function transformCss(scale: number, offset: Offset): string {
  return `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`;
}

function distanceBetween(a: PointerSample, b: PointerSample): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "button, a, input, textarea, select, [role='button'], [data-image-zoom-ignore]",
    ),
  );
}

/**
 * 图片查看器的手势：滚轮 / 双击 / 双指捏合缩放，放大后单指拖动平移。
 *
 * 手势状态机（pointer 事件）：
 * - 1 根手指且已放大 → drag；该手指就是平移的唯一来源
 * - 第 2 根手指按下 → 立即取消 drag，进入 pinch；pinch 期间 pointermove 只做缩放，
 *   绝不再叠加单指平移（这是之前「两股力打架」的根因）
 * - pinch 期间抬到只剩 1 根手指 → 以该手指当前位置为原点继续 drag
 * - 所有手指离开 → 清空 activePointers，提交 state，恢复 transition
 *
 * 跟手性：drag / pinch 期间只写 ref 与 `img.style.transform`，不触发 React setState；
 * 手势结束才 commit 到 state。transition 在按下时直接置 none、结束时直接恢复，
 * 避免 pointerup 与 React 渲染之间的空档把 transition 弄丢。
 */
export function useImageZoom(resetKey?: unknown) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  /** 仅用于渲染 cursor；每根手指按下/离开时才变一次，不参与逐帧更新 */
  const [isInteracting, setIsInteracting] = useState(false);

  const scaleRef = useRef(1);
  const offsetRef = useRef<Offset>({ x: 0, y: 0 });
  const pointersRef = useRef(new Map<number, PointerSample>());
  const gestureRef = useRef<Gesture | null>(null);

  const measureContainer = useCallback((): Size => {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect ? { width: rect.width, height: rect.height } : { width: 0, height: 0 };
  }, []);

  /** 图片的实际布局尺寸（受 max-w/max-h 约束后的值），letterbox 时用它算边界 */
  const measureImage = useCallback((): Size | undefined => {
    const image = imageRef.current;
    if (!image || image.clientWidth <= 0 || image.clientHeight <= 0) return undefined;
    return { width: image.clientWidth, height: image.clientHeight };
  }, []);

  const clampToBounds = useCallback(
    (next: Offset, targetScale: number): Offset =>
      clampOffset(next, targetScale, measureContainer(), measureImage()),
    [measureContainer, measureImage],
  );

  /** 屏幕坐标 → 相对容器中心的坐标；容器还没挂载时返回 undefined */
  const anchorFor = useCallback((clientX: number, clientY: number): Offset | undefined => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return undefined;
    return {
      x: clientX - (rect.left + rect.width / 2),
      y: clientY - (rect.top + rect.height / 2),
    };
  }, []);

  const setDomTransition = useCallback((value: string) => {
    const image = imageRef.current;
    if (image) image.style.transition = value;
  }, []);

  /** 逐帧路径：只写 ref + DOM，不 setState */
  const paint = useCallback((nextScale: number, nextOffset: Offset) => {
    scaleRef.current = nextScale;
    offsetRef.current = nextOffset;
    const image = imageRef.current;
    if (image) {
      image.style.transition = "none";
      image.style.transform = transformCss(nextScale, nextOffset);
    }
  }, []);

  const beginInteraction = useCallback(() => {
    setIsInteracting(true);
    setDomTransition("none");
  }, [setDomTransition]);

  /** 手势结束：提交 ref 里的最终值到 state，并把 transition 恢复 */
  const commit = useCallback(() => {
    setScale(scaleRef.current);
    setOffset(offsetRef.current);
    setDomTransition(ZOOM_TRANSITION);
  }, [setDomTransition]);

  const endInteraction = useCallback(() => {
    setIsInteracting(false);
    setDomTransition(ZOOM_TRANSITION);
  }, [setDomTransition]);

  const beginDrag = useCallback(
    (pointerId: number, sample: PointerSample) => {
      gestureRef.current = {
        mode: "drag",
        pointerId,
        startX: sample.x,
        startY: sample.y,
        origin: offsetRef.current,
      };
      beginInteraction();
    },
    [beginInteraction],
  );

  const beginPinch = useCallback(() => {
    const entries = [...pointersRef.current.entries()];
    const first = entries[0];
    const second = entries[1];
    if (!first || !second) return;
    const [firstId, firstSample] = first;
    const [secondId, secondSample] = second;
    const midX = (firstSample.x + secondSample.x) / 2;
    const midY = (firstSample.y + secondSample.y) / 2;
    const rect = containerRef.current?.getBoundingClientRect();
    gestureRef.current = {
      mode: "pinch",
      pointerIds: [firstId, secondId],
      startDistance: Math.max(distanceBetween(firstSample, secondSample), 1),
      startScale: scaleRef.current,
      startOffset: offsetRef.current,
      anchor: rect
        ? {
            x: midX - (rect.left + rect.width / 2),
            y: midY - (rect.top + rect.height / 2),
          }
        : { x: 0, y: 0 },
    };
    beginInteraction();
  }, [beginInteraction]);

  /** 双击 / 滚轮：提交到 state，并让 React 用 style 里的短缓动做动画 */
  const applyScale = useCallback(
    (next: number, anchor?: Offset) => {
      const from = scaleRef.current;
      const target = clampScale(next);
      const base = anchor
        ? offsetForZoomAt(anchor, from, target, offsetRef.current)
        : {
            x: (offsetRef.current.x * target) / from,
            y: (offsetRef.current.y * target) / from,
          };
      const nextOffset = clampToBounds(base, target);
      scaleRef.current = target;
      offsetRef.current = nextOffset;
      setScale(target);
      setOffset(nextOffset);
      const image = imageRef.current;
      if (image) {
        image.style.transition = ZOOM_TRANSITION;
        image.style.transform = transformCss(target, nextOffset);
      }
    },
    [clampToBounds],
  );

  const reset = useCallback(() => {
    pointersRef.current.clear();
    gestureRef.current = null;
    scaleRef.current = 1;
    offsetRef.current = { x: 0, y: 0 };
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setIsInteracting(false);
    const image = imageRef.current;
    if (image) {
      image.style.transition = ZOOM_TRANSITION;
      image.style.transform = transformCss(1, { x: 0, y: 0 });
    }
  }, []);

  // 换图 / 关闭时复位
  useEffect(() => {
    reset();
  }, [resetKey, reset]);

  const toggleZoomAt = useCallback(
    (clientX: number, clientY: number) => {
      if (scaleRef.current > 1) {
        reset();
        return;
      }
      applyScale(2, anchorFor(clientX, clientY));
    },
    [anchorFor, applyScale, reset],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (gestureRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      applyScale(
        nextScale(scaleRef.current, event.deltaY),
        anchorFor(event.clientX, event.clientY),
      );
    },
    [anchorFor, applyScale],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      toggleZoomAt(event.clientX, event.clientY);
    },
    [toggleZoomAt],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (isInteractiveTarget(event.target)) return;
      pointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      const count = pointersRef.current.size;
      if (count === 1) {
        // 未放大时单指只用来判定点击 / 为随后的第二根手指做准备
        if (scaleRef.current > 1) {
          beginDrag(event.pointerId, pointersRef.current.get(event.pointerId)!);
        }
        return;
      }

      // 第二根手指按下：立即作废单指拖动，进入纯捏合
      event.preventDefault();
      event.stopPropagation();
      beginPinch();
    },
    [beginDrag, beginPinch],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const sample = pointersRef.current.get(event.pointerId);
      if (!sample) return;
      sample.x = event.clientX;
      sample.y = event.clientY;

      const gesture = gestureRef.current;
      if (!gesture) return;

      if (gesture.mode === "drag") {
        if (gesture.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const next = clampToBounds(
          {
            x: gesture.origin.x + (event.clientX - gesture.startX),
            y: gesture.origin.y + (event.clientY - gesture.startY),
          },
          scaleRef.current,
        );
        paint(scaleRef.current, next);
        return;
      }

      // pinch：只按两指距离缩放，pointermove 绝不叠加平移
      const first = pointersRef.current.get(gesture.pointerIds[0]);
      const second = pointersRef.current.get(gesture.pointerIds[1]);
      if (!first || !second) return;
      event.preventDefault();
      event.stopPropagation();
      const targetScale = clampScale(
        gesture.startScale *
          (distanceBetween(first, second) / gesture.startDistance),
      );
      const next = clampToBounds(
        offsetForZoomAt(
          gesture.anchor,
          gesture.startScale,
          targetScale,
          gesture.startOffset,
        ),
        targetScale,
      );
      paint(targetScale, next);
    },
    [clampToBounds, paint],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (!pointersRef.current.delete(event.pointerId)) return;

      const gesture = gestureRef.current;
      if (!gesture) {
        if (pointersRef.current.size === 0) endInteraction();
        return;
      }

      if (gesture.mode === "drag") {
        if (gesture.pointerId !== event.pointerId) return;
        gestureRef.current = null;
        commit();
        if (pointersRef.current.size > 0 && scaleRef.current > 1) {
          const [restId, restSample] = [...pointersRef.current.entries()][0]!;
          beginDrag(restId, restSample);
          return;
        }
        endInteraction();
        return;
      }

      if (pointersRef.current.size >= 2) {
        // 三指抬一指：以剩下的两指重新取基准，避免跳变
        beginPinch();
        return;
      }

      if (pointersRef.current.size === 1) {
        gestureRef.current = null;
        if (scaleRef.current > 1) {
          const [restId, restSample] = [...pointersRef.current.entries()][0]!;
          beginDrag(restId, restSample);
        } else {
          commit();
          endInteraction();
        }
        return;
      }

      gestureRef.current = null;
      commit();
      endInteraction();
    },
    [beginDrag, beginPinch, commit, endInteraction],
  );

  const onPointerLeave = useCallback(
    (event: React.PointerEvent) => {
      // 鼠标拖出容器后收不到 pointerup，就地结束，避免手势卡死
      if (event.pointerType !== "mouse") return;
      if (gestureRef.current) onPointerUp(event);
    },
    [onPointerUp],
  );

  const isZoomed = scale > 1;

  return {
    containerRef,
    imageRef,
    scale,
    offset,
    isZoomed,
    isInteracting,
    reset,
    toggleZoomAt,
    handlers: {
      onWheel,
      onDoubleClick,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onPointerLeave,
    },
    /** 给图片元素用的 transform */
    style: {
      transform: transformCss(scale, offset),
      // 手势中即使因 isInteracting 重渲染，也不能把 transition 带回来
      transition: isInteracting ? "none" : ZOOM_TRANSITION,
      cursor: isZoomed ? (isInteracting ? "grabbing" : "grab") : "zoom-in",
      touchAction: "none" as const,
      transformOrigin: "center center",
      willChange: "transform",
      userSelect: "none" as const,
    },
  };
}