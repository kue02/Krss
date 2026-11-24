import { useEffect, useCallback, useRef, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import useEmblaCarousel from "embla-carousel-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useImagePreviewStore } from "@/stores/image-preview-store";
import { AuthedImage } from "@/components/ui/authed-image";
import { useImageZoom } from "@/hooks/useImageZoom";

export function ImagePreview() {
  const { t } = useTranslation();
  const { isOpen, images, currentIndex, close, reset, setIndex } =
    useImagePreviewStore();

  // Track pointer position to distinguish click from drag in carousel
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
  const scrollLockYRef = useRef(0);
  const touchMoveHandlerRef = useRef<((e: TouchEvent) => void) | null>(null);

  // Track if index change is from embla interaction (to avoid scrollTo interrupting animation)
  const isEmblaNavigatingRef = useRef(false);

  // Track previous isOpen state to detect when preview opens
  const wasOpenRef = useRef(isOpen);

  // Capture initial index when preview opens
  // We need to update this when isOpen changes from false to true
  const initialIndexRef = useRef(currentIndex);
  if (isOpen && !wasOpenRef.current) {
    // Preview just opened - capture the current index
    initialIndexRef.current = currentIndex;
  }
  wasOpenRef.current = isOpen;

  // 手势缩放 / 双指捏合 / 放大后拖动平移；换图或关闭时自动复位
  const zoom = useImageZoom(`${currentIndex}:${images[currentIndex] ?? ""}`);

  // 用 ref 暴露当前是否处于放大态，供 embla 的 watchDrag 实时判断，
  // 这样放大时禁用翻页、复位后自动恢复，无需 reInit。
  const isZoomedRef = useRef(zoom.isZoomed);
  useEffect(() => {
    isZoomedRef.current = zoom.isZoomed;
  }, [zoom.isZoomed]);

  // 手势进行中（捏合 / 放大后拖动）也不许 embla 抢走单指翻页
  const isInteractingRef = useRef(zoom.isInteracting);
  useEffect(() => {
    isInteractingRef.current = zoom.isInteracting;
  }, [zoom.isInteracting]);

  // Memoize options to prevent unnecessary reInit (which would skip animations)
  const emblaOptions = useMemo(
    () => ({
      loop: false,
      startIndex: initialIndexRef.current,
      skipSnaps: false,
      duration: 25,
      // 放大或手势进行中禁掉 embla 的单指拖拽翻页：此时拖动应该平移图片
      watchDrag: () => !isZoomedRef.current && !isInteractingRef.current,
    }),
    // Recreate options when preview opens (images change) or when initial index changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images, isOpen && initialIndexRef.current],
  );

  const [emblaRef, emblaApi] = useEmblaCarousel(emblaOptions);

  // Sync embla with store
  useEffect(() => {
    if (!emblaApi) return;

    const onSelect = () => {
      // Mark that this index change is from embla interaction
      isEmblaNavigatingRef.current = true;
      const index = emblaApi.selectedScrollSnap();
      setIndex(index);
    };

    emblaApi.on("select", onSelect);
    return () => {
      emblaApi.off("select", onSelect);
    };
  }, [emblaApi, setIndex]);

  // Scroll to index when store changes (from external source, not embla)
  useEffect(() => {
    // Skip if change is from embla navigation (would interrupt animation)
    if (isEmblaNavigatingRef.current) {
      isEmblaNavigatingRef.current = false;
      return;
    }
    if (emblaApi && emblaApi.selectedScrollSnap() !== currentIndex) {
      emblaApi.scrollTo(currentIndex);
    }
  }, [emblaApi, currentIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          close();
          break;
        case "ArrowLeft":
          emblaApi?.scrollPrev();
          break;
        case "ArrowRight":
          emblaApi?.scrollNext();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, close, emblaApi]);

  // Prevent body scroll when open. iOS PWA avoids position: fixed to prevent white bar.
  useEffect(() => {
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isStandalone =
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(display-mode: standalone)").matches) ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    // iOS PWA uses touchmove lock to avoid position: fixed viewport bugs.
    const isIOSPWA = isIOS && isStandalone;

    const unlockScroll = () => {
      const storedTop = document.body.style.top;
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.left = "";
      document.body.style.right = "";
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";

      if (touchMoveHandlerRef.current) {
        document.removeEventListener("touchmove", touchMoveHandlerRef.current);
        touchMoveHandlerRef.current = null;
      }

      if (isIOSPWA) {
        if (scrollLockYRef.current) {
          window.scrollTo(0, scrollLockYRef.current);
        }
        return;
      }

      if (storedTop) {
        window.scrollTo(0, parseInt(storedTop, 10) * -1);
      }
    };

    if (isOpen) {
      scrollLockYRef.current = window.scrollY;

      if (isIOSPWA) {
        document.documentElement.style.overflow = "hidden";
        document.body.style.overflow = "hidden";
        const handler = (e: TouchEvent) => {
          e.preventDefault();
        };
        touchMoveHandlerRef.current = handler;
        document.addEventListener("touchmove", handler, { passive: false });
      } else {
        document.body.style.position = "fixed";
        document.body.style.top = `-${scrollLockYRef.current}px`;
        document.body.style.left = "0";
        document.body.style.right = "0";
        document.body.style.overflow = "hidden";
      }
    } else {
      unlockScroll();
    }

    return () => {
      unlockScroll();
    };
  }, [isOpen]);

  // 打开时短暂显示一次操作提示（缩放用法），几秒后淡出
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    if (!isOpen) {
      setShowHint(false);
      return;
    }
    setShowHint(true);
    const timer = window.setTimeout(() => setShowHint(false), 2600);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  // 放大后隐藏提示
  useEffect(() => {
    if (zoom.isZoomed) setShowHint(false);
  }, [zoom.isZoomed]);

  const pointerTypeRef = useRef<string>("mouse");
  const handleCarouselPointerDown = useCallback((e: React.PointerEvent) => {
    pointerDownPos.current = { x: e.clientX, y: e.clientY };
    pointerTypeRef.current = e.pointerType || "mouse";
  }, []);

  // 等当次 click 处理完再清空按下坐标：pointercancel / 被原生拖拽打断时不会
  // 产生 click，若立刻清空或完全不清空，下一次干净点击会误判成拖动。
  const schedulePointerDownReset = useCallback(() => {
    window.setTimeout(() => {
      pointerDownPos.current = null;
    }, 0);
  }, []);

  const handleStagePointerUp = useCallback(
    (e: React.PointerEvent) => {
      zoom.handlers.onPointerUp?.(e);
      schedulePointerDownReset();
    },
    [schedulePointerDownReset, zoom.handlers.onPointerUp],
  );

  const handleStagePointerCancel = useCallback(
    (e: React.PointerEvent) => {
      zoom.handlers.onPointerCancel?.(e);
      schedulePointerDownReset();
    },
    [schedulePointerDownReset, zoom.handlers.onPointerCancel],
  );

  // 点击图片：仅在未放大且未发生拖动时关闭。
  // 用短延时关闭，以便和「双击放大」相区分（第二次点击会取消关闭）。
  // 双击判定自己按 tap 间隔做，不依赖原生 dblclick —— iOS Safari 对非表单元素
  // 常不派发 dblclick，原来「双击缩放」在真机上会失效，慢一点的第二次点按还会
  // 被 280ms 的关闭定时器抢先触发，表现为「想缩放却把大图关了」。
  const tapTimerRef = useRef<number | null>(null);
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const suppressDblClickRef = useRef(0);
  const TAP_CLOSE_DELAY = 320;
  const DOUBLE_TAP_MS = 320;
  const DOUBLE_TAP_SLOP = 30;
  const clearTapTimer = useCallback(() => {
    if (tapTimerRef.current !== null) {
      window.clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearTapTimer, [clearTapTimer]);

  const handleTapClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // 拖动 / 滑动超过 5px 视为滑动手势，不当作点击
      if (pointerDownPos.current) {
        const dx = Math.abs(e.clientX - pointerDownPos.current.x);
        const dy = Math.abs(e.clientY - pointerDownPos.current.y);
        pointerDownPos.current = null;
        if (dx >= 5 || dy >= 5) return;
      }

      const now = performance.now();
      const last = lastTapRef.current;
      const isDoubleTap =
        !!last &&
        now - last.t <= DOUBLE_TAP_MS &&
        Math.hypot(e.clientX - last.x, e.clientY - last.y) <= DOUBLE_TAP_SLOP;

      if (isDoubleTap) {
        clearTapTimer();
        lastTapRef.current = null;
        // 手动双击已处理，压掉随后浏览器补发的原生 dblclick，避免二次切换
        suppressDblClickRef.current = now;
        zoom.toggleZoomAt(e.clientX, e.clientY);
        return;
      }

      lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };

      // 放大状态下单击不关闭（只记录，等第二次点按做复位）
      if (zoom.isZoomed) return;

      // 延迟关闭：给双击缩放留出取消窗口
      if (tapTimerRef.current !== null) {
        clearTapTimer();
        return;
      }
      tapTimerRef.current = window.setTimeout(() => {
        tapTimerRef.current = null;
        close();
      }, TAP_CLOSE_DELAY);
    },
    [close, clearTapTimer, zoom],
  );

  // 统一 click：图片内沿用上面的点按语义；图片外（stage/letterbox 空白）立即关闭。
  // 放大态也关闭，但仍要求按下到抬起没有拖动，避免拖完图后误关。
  const handleStageClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest("img")) {
        handleTapClose(e);
        return;
      }

      e.stopPropagation();
      if (pointerDownPos.current) {
        const dx = Math.abs(e.clientX - pointerDownPos.current.x);
        const dy = Math.abs(e.clientY - pointerDownPos.current.y);
        pointerDownPos.current = null;
        if (dx >= 5 || dy >= 5) return;
      }

      clearTapTimer();
      lastTapRef.current = null;
      close();
    },
    [close, clearTapTimer, handleTapClose],
  );

  // 原生 dblclick 兜底（鼠标/触控板）；触屏双击已被上面的 tap 逻辑处理时忽略。
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (performance.now() - suppressDblClickRef.current < 500) return;
      zoom.toggleZoomAt(e.clientX, e.clientY);
    },
    [zoom],
  );

  const handleOverlayClick = useCallback(() => {
    close();
  }, [close]);

  return (
    <AnimatePresence onExitComplete={reset}>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex flex-col bg-black/90 h-dvh"
          onClick={handleOverlayClick}
        >
          {/* Close button */}
          <div className="absolute right-[calc(1rem+env(safe-area-inset-right,0px))] top-[calc(1rem+env(safe-area-inset-top,0px))] z-10">
            <button
              type="button"
              className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              onClick={close}
              aria-label={t("entry.image_close")}
              title={t("entry.image_close")}
            >
              <svg
                className="size-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Image counter */}
          {images.length > 1 && (
            <div className="absolute left-[calc(1rem+env(safe-area-inset-left,0px))] top-[calc(1rem+env(safe-area-inset-top,0px))] z-10">
              <div className="rounded-full bg-white/10 px-3 py-1.5 text-sm text-white">
                {currentIndex + 1} / {images.length}
              </div>
            </div>
          )}

          {/* Zoom hint */}
          <div
            className={cn(
              "pointer-events-none absolute bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] left-1/2 z-10 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/90 backdrop-blur-sm transition-opacity duration-500",
              showHint ? "opacity-100" : "opacity-0",
            )}
          >
            {t("entry.image_zoom_hint")}
          </div>

          {/* Image carousel */}
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {images.length === 1 ? (
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="relative flex size-full touch-none items-center justify-center safe-area-x"
                ref={zoom.containerRef}
                {...zoom.handlers}
                onDoubleClick={handleDoubleClick}
                onPointerDown={(e) => {
                  // 记录起点以区分点击/拖动；同时保留缩放平移的 pointer 处理
                  handleCarouselPointerDown(e);
                  zoom.handlers.onPointerDown?.(e);
                }}
                onPointerUp={handleStagePointerUp}
                onPointerCancel={handleStagePointerCancel}
                onClick={handleStageClick}
              >
                <AuthedImage
                  ref={zoom.imageRef}
                  src={images[0]}
                  alt=""
                  draggable={false}
                  className="max-h-full max-w-full object-contain"
                  style={zoom.style}
                />
              </motion.div>
            ) : (
              // 外层挂缩放容器与手势（滚轮 / 双击 / 捏合 / 放大后拖动平移），
              // 内层保留 embla 的指针记录与点击关闭。
              <div
                ref={zoom.containerRef}
                className="size-full min-h-0 touch-none"
                {...zoom.handlers}
                onDoubleClick={handleDoubleClick}
                onPointerUp={handleStagePointerUp}
                onPointerCancel={handleStagePointerCancel}
              >
                <div
                  ref={emblaRef}
                  className="size-full min-h-0 overflow-hidden touch-manipulation"
                  style={{ touchAction: "none" }}
                  onPointerDown={handleCarouselPointerDown}
                  onClick={handleStageClick}
                >
                  <div className="flex size-full min-h-0 touch-pan-y will-change-transform">
                    {images.map((src, index) => (
                      <div
                        key={src}
                        className="flex min-h-0 min-w-0 flex-[0_0_100%] items-center justify-center will-change-transform"
                      >
                        <AuthedImage
                          ref={index === currentIndex ? zoom.imageRef : undefined}
                          src={src}
                          alt=""
                          draggable={false}
                          className="max-h-full max-w-full object-contain"
                          style={
                            index === currentIndex ? zoom.style : undefined
                          }
                          loading={
                            Math.abs(index - currentIndex) <= 1 ? "eager" : "lazy"
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Navigation arrows */}
            {images.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label={t("entry.image_prev")}
                  className={cn(
                    "absolute left-4 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors",
                    currentIndex === 0 ? "invisible" : "hover:bg-white/20",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    emblaApi?.scrollPrev();
                  }}
                  disabled={currentIndex === 0}
                >
                  <svg
                    className="size-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label={t("entry.image_next")}
                  className={cn(
                    "absolute right-4 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors",
                    currentIndex === images.length - 1
                      ? "invisible"
                      : "hover:bg-white/20",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    emblaApi?.scrollNext();
                  }}
                  disabled={currentIndex === images.length - 1}
                >
                  <svg
                    className="size-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
