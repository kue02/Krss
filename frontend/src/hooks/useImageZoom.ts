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
  /** 按下时的真实 target，用于把 pointer capture 放在 click 会到达的元素上 */
  target: Element | null;
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

/**
 * 手势结束 / 双击缩放 / 回弹共用同一段短缓动。
 * 1x→2x 这种大幅缩放用更长的减速尾段（近似 easeOutQuint），
 * 避免 160ms ease-out 在末段被人眼读成「顿一下 / 有阻力」。
 */
const ZOOM_TRANSITION = "transform 240ms cubic-bezier(0.22, 1, 0.36, 1)";

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
  /** 手势开始前已提交的 scale/offset，系统意外取消时恢复到这里 */
  const gestureStartRef = useRef<{ scale: number; offset: Offset } | null>(null);
  /**
   * 手势期间复用的容器 / 图片尺寸缓存。
   * 之前每次 pointermove 都经 clampToBounds → measureContainer/measureImage 读
   * getBoundingClientRect / clientWidth，逐帧强制同步布局，是移动端缩放「顿感」的根因。
   * 现在只在手势开始、图片 onLoad、窗口 resize 时刷新，move 期间只读缓存。
   */
  const metricsRef = useRef<{ container: Size; image: Size | undefined } | null>(
    null,
  );
  /** 实时多指状态（>=2 根手指）：第二指按下即置真，所有指抬起后置假 */
  const isMultiTouchRef = useRef(false);

  const measureContainer = useCallback((): Size => {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect ? { width: rect.width, height: rect.height } : { width: 0, height: 0 };
  }, []);

  /** 图片的实际布局尺寸（受 max-w/max-h 约束后的值），letterbox 时用它算边界 */
  const measureImage = useCallback((): Size | undefined => {
    const image = imageRef.current;
    if (!image) return undefined;
    // 图片还没解码完时没有布局尺寸：此时宁可禁止平移，也不能按容器尺寸放行
    if (image.clientWidth <= 0 || image.clientHeight <= 0) {
      return { width: 0, height: 0 };
    }
    return { width: image.clientWidth, height: image.clientHeight };
  }, []);

  const measureMetrics = useCallback(
    (): { container: Size; image: Size | undefined } => ({
      container: measureContainer(),
      image: measureImage(),
    }),
    [measureContainer, measureImage],
  );

  /** 只在手势开始 / 图片 onLoad / resize 时刷新缓存，逐帧路径绝不触发强制布局 */
  const refreshMetrics = useCallback(() => {
    metricsRef.current = measureMetrics();
  }, [measureMetrics]);

  /** 取缓存；首次访问（尚未刷新）时才测量一次 */
  const getMetrics = useCallback(() => {
    if (!metricsRef.current) metricsRef.current = measureMetrics();
    return metricsRef.current;
  }, [measureMetrics]);

  const clampToBounds = useCallback(
    (next: Offset, targetScale: number): Offset => {
      const { container, image } = getMetrics();
      // image 为 undefined 时 clampOffset 退回按容器尺寸计算（保持旧语义）
      return clampOffset(next, targetScale, container, image);
    },
    [getMetrics],
  );

  /**
   * 容器 / 图片尺寸发生变化（ResizeObserver / window.resize）时统一入口：
   * - 总是刷新尺寸缓存（手势中 move 会读到最新值，符合「容器变化后 clamp 用新值」）；
   * - 手势进行中只刷新缓存，绝不动 DOM / transition，避免打断当前手势；
   * - 非手势状态下如果已有缩放/平移，按新边界重新夹紧，防止尺寸变化后图片停在越界位置。
   */
  const handleMetricsChanged = useCallback(() => {
    refreshMetrics();
    if (gestureRef.current) return;
    const targetScale = scaleRef.current;
    const next =
      targetScale > 1
        ? clampToBounds(offsetRef.current, targetScale)
        : { x: 0, y: 0 };
    if (
      next.x === offsetRef.current.x &&
      next.y === offsetRef.current.y
    ) {
      return;
    }
    offsetRef.current = next;
    setOffset(next);
    const image = imageRef.current;
    if (image) image.style.transform = transformCss(targetScale, next);
  }, [clampToBounds, refreshMetrics]);

  /** 惰性同步多指标记：仅在指针集合变化时调用，不在逐帧路径里 */
  const syncMultiTouch = useCallback(() => {
    isMultiTouchRef.current = pointersRef.current.size >= 2;
  }, []);

  /**
   * 记录「本次手势最初」的 scale/offset。
   * 只在一次连续手势开始时写一次：beginPinch 会在三指 / 重取基准时被反复调用，
   * 若每次都覆盖，pointercancel 就会回滚到中途快照而不是手势最初的快照。
   */
  const ensureGestureStart = useCallback(() => {
    if (gestureStartRef.current) return;
    gestureStartRef.current = {
      scale: scaleRef.current,
      offset: { ...offsetRef.current },
    };
  }, []);

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
    gestureStartRef.current = null;
    setDomTransition(ZOOM_TRANSITION);
  }, [setDomTransition]);

  const endInteraction = useCallback(() => {
    setIsInteracting(false);
    setDomTransition(ZOOM_TRANSITION);
  }, [setDomTransition]);

  const capturePointer = useCallback(
    (pointerId: number, target: Element | null) => {
      const element = target ?? containerRef.current;
      if (!element || typeof element.setPointerCapture !== "function") return;
      try {
        element.setPointerCapture(pointerId);
      } catch {
        // 某些浏览器在默认行为取消后拒绝捕获，走 pointerleave 兜底
      }
    },
    [],
  );

  const beginDrag = useCallback(
    (pointerId: number, sample: PointerSample) => {
      // 手势开始即缓存容器/图片尺寸，之后 move 只读缓存
      refreshMetrics();
      ensureGestureStart();
      gestureRef.current = {
        mode: "drag",
        pointerId,
        startX: sample.x,
        startY: sample.y,
        origin: offsetRef.current,
      };
      capturePointer(pointerId, sample.target);
      beginInteraction();
    },
    [beginInteraction, capturePointer, ensureGestureStart, refreshMetrics],
  );

  const beginPinch = useCallback(() => {
    const entries = [...pointersRef.current.entries()];
    const first = entries[0];
    const second = entries[1];
    if (!first || !second) return;
    refreshMetrics();
    const [firstId, firstSample] = first;
    const [secondId, secondSample] = second;
    // 三指 / 重取基准会重复调用 beginPinch，这里只记「本次手势最初」的快照
    ensureGestureStart();
    capturePointer(firstId, firstSample.target);
    capturePointer(secondId, secondSample.target);
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
  }, [beginInteraction, capturePointer, ensureGestureStart, refreshMetrics]);

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
    gestureStartRef.current = null;
    isMultiTouchRef.current = false;
    refreshMetrics();
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
  }, [refreshMetrics]);

  // 换图 / 关闭时复位
  useEffect(() => {
    reset();
  }, [resetKey, reset]);

  // 尺寸缓存失效：window.resize 只覆盖「窗口」尺寸；侧栏展开、软键盘、父容器动画、
  // 横竖屏切换等不触发 window.resize 的变化，交给 ResizeObserver 观察容器与图片节点。
  // 换图（resetKey 变化）后重新 observe 当前节点；无 ResizeObserver（SSR / jsdom）时安全降级为 window.resize。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const container = containerRef.current;
    const image = imageRef.current;
    if (typeof ResizeObserver === "undefined") {
      const handleResize = () => handleMetricsChanged();
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }
    const observer = new ResizeObserver(() => {
      // 手势中只刷新缓存（move 会读到新值），不在这里改 DOM / transition
      handleMetricsChanged();
    });
    if (container) observer.observe(container);
    if (image) observer.observe(image);
    return () => observer.disconnect();
  }, [handleMetricsChanged, resetKey]);

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
        target: event.target instanceof Element ? event.target : null,
      });
      syncMultiTouch();

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
    [beginDrag, beginPinch, syncMultiTouch],
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
      syncMultiTouch();

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
    [beginDrag, beginPinch, commit, endInteraction, syncMultiTouch],
  );

  /** capture 意外丢失或系统取消：恢复到手势开始前的已提交状态 */
  const abortInterruptedGesture = useCallback(() => {
    if (pointersRef.current.size === 0 && !gestureRef.current) return;
    const snapshot = gestureStartRef.current;
    pointersRef.current.clear();
    gestureRef.current = null;
    gestureStartRef.current = null;
    isMultiTouchRef.current = false;
    if (snapshot) {
      scaleRef.current = snapshot.scale;
      offsetRef.current = snapshot.offset;
      setScale(snapshot.scale);
      setOffset(snapshot.offset);
      const image = imageRef.current;
      if (image) {
        image.style.transition = ZOOM_TRANSITION;
        image.style.transform = transformCss(snapshot.scale, snapshot.offset);
      }
    }
    setIsInteracting(false);
    setDomTransition(ZOOM_TRANSITION);
  }, [setDomTransition]);

  const onPointerCancel = useCallback(
    (event: React.PointerEvent) => {
      // 系统取消（如浏览器接管原生图片拖拽）时回滚到手势开始前的快照，
      // 不能把中间位移/缩放当成最终值提交；只有正常 pointerup 才 commit。
      if (!pointersRef.current.has(event.pointerId)) return;
      abortInterruptedGesture();
    },
    [abortInterruptedGesture],
  );

  const onLostPointerCapture = useCallback(
    (event: React.PointerEvent) => {
      // pointerup 自动释放 capture 时指针已经从 map 中移除，这里只处理意外丢失
      if (!pointersRef.current.has(event.pointerId)) return;
      abortInterruptedGesture();
    },
    [abortInterruptedGesture],
  );

  const onPointerLeave = useCallback(
    (event: React.PointerEvent) => {
      // 已成功 capture 时 pointerup 会回到被捕获元素，不能因为移出边界就提前结束拖动
      const sample = pointersRef.current.get(event.pointerId);
      const captureElement = sample?.target ?? containerRef.current;
      if (
        captureElement &&
        typeof captureElement.hasPointerCapture === "function" &&
        captureElement.hasPointerCapture(event.pointerId)
      ) {
        return;
      }
      // capture 不可用时，鼠标拖出容器后收不到 pointerup，就地结束，避免手势卡死
      if (event.pointerType !== "mouse") return;
      if (gestureRef.current) onPointerUp(event);
      // 兜底结束后确保缓动恢复，避免鼠标拖出容器时 transition 卡在 none
      if (!gestureRef.current) setDomTransition(ZOOM_TRANSITION);
    },
    [onPointerUp, setDomTransition],
  );

  /** 图片 onLoad 后重新测量并夹紧 offset（未加载时边界为 0，不允许拖出） */
  const onImageLoad = useCallback(() => {
    refreshMetrics();
    const targetScale = scaleRef.current;
    const next =
      targetScale > 1
        ? clampToBounds(offsetRef.current, targetScale)
        : { x: 0, y: 0 };
    offsetRef.current = next;
    setOffset(next);
    const image = imageRef.current;
    if (!image) return;
    // 图片若在手势进行中才解码完，不能把 transition 带回来打断逐帧跟手；
    // 只同步当前几何值，缓动仍留到手势结束再恢复。
    if (gestureRef.current) {
      image.style.transition = "none";
    } else {
      image.style.transition = ZOOM_TRANSITION;
    }
    image.style.transform = transformCss(targetScale, next);
  }, [clampToBounds, refreshMetrics]);

  const isZoomed = scale > 1;

  // 手势期间逐帧只更新 ref + DOM，不触发 state；若此刻父组件因任何原因
  // （图片 onLoad、已读状态、翻译…）重渲染，React 会用 style 重写 transform。
  // 因此手势中必须读 ref 的实时值，否则会把刚 paint 的值覆盖回手势开始前的旧 state，
  // 表现为「放大/拖动时画面瞬间回跳、顿一下」。
  const renderedScale = isInteracting ? scaleRef.current : scale;
  const renderedOffset = isInteracting ? offsetRef.current : offset;

  return {
    containerRef,
    imageRef,
    scale,
    offset,
    isZoomed,
    isInteracting,
    /** 实时多指状态：供 embla 的 watchDrag 判断，第二指按下即为 true */
    isMultiTouchRef,
    /** 当前按下的指针数量（含非主指） */
    getPointerCount: () => pointersRef.current.size,
    reset,
    toggleZoomAt,
    onImageLoad,
    handlers: {
      onWheel,
      onDoubleClick,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onPointerLeave,
    },
    /** 给图片元素用的 transform */
    style: {
      transform: transformCss(renderedScale, renderedOffset),
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