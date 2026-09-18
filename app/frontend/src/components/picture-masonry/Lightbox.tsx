import { useImageZoom } from "@/hooks/useImageZoom";
import { useEffect, useCallback, useState, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import useEmblaCarousel from "embla-carousel-react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { isVideoThumbnail } from "@/lib/media-utils";
import { formatRelativeTime } from "@/lib/date-utils";
import { stripHtml } from "@/lib/html-utils";
import {
  useMarkAsRead,
  useMarkAsStarred,
  useRemoveFromUnreadList,
} from "@/hooks/useEntries";
import { useLightboxStore } from "@/stores/lightbox-store";
import { FeedIcon } from "@/components/ui/feed-icon";

export function Lightbox() {
  const { t } = useTranslation();
  const {
    isOpen,
    entry,
    feed,
    images,
    currentIndex,
    close,
    reset,
    setIndex,
    next,
    prev,
    gallery,
    galleryIndex,
    updateEntryStarred,
  } = useLightboxStore();
  const { mutate: markAsRead } = useMarkAsRead();
  const { mutate: markAsStarred } = useMarkAsStarred();
  const removeFromUnreadList = useRemoveFromUnreadList();

  // Track which entries have been marked as read to avoid duplicate calls
  const markedAsReadRef = useRef<Set<string>>(new Set());

  // Track pointer position to distinguish click from drag in carousel
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
  const scrollLockYRef = useRef(0);
  const touchMoveHandlerRef = useRef<((e: TouchEvent) => void) | null>(null);

  // Track if index change is from embla interaction (to avoid scrollTo interrupting animation)
  const isEmblaNavigatingRef = useRef(false);

  // Capture initial index when lightbox opens to avoid reInit on every currentIndex change
  const initialIndexRef = useRef(currentIndex);
  if (!isOpen) {
    initialIndexRef.current = currentIndex;
  }

  // Memoize options to prevent unnecessary reInit (which would skip animations)
  // iOS-style animation: smooth, natural deceleration
  const emblaOptions = useMemo(
    () => ({
      loop: false,
      startIndex: initialIndexRef.current,
      skipSnaps: false, // Snap to nearest slide (iOS behavior)
      duration: 25, // iOS-like snap duration (default 25, range 20-60)
    }),
    // Only recreate options when lightbox opens (images change)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images],
  );

  const [emblaRef, emblaApi] = useEmblaCarousel(emblaOptions);

  const [iconError, setIconError] = useState(false);
  const showIcon = feed?.iconPath && !iconError;

  // Mark entry as read when lightbox opens
  // This is done here instead of in PictureItem to avoid race condition
  // when unreadOnly filter is enabled (list item would disappear before lightbox opens)
  // Use skipInvalidate to prevent list refresh while lightbox is open
  useEffect(() => {
    if (
      isOpen &&
      entry &&
      !entry.read &&
      !markedAsReadRef.current.has(entry.id)
    ) {
      markedAsReadRef.current.add(entry.id);
      markAsRead({ id: entry.id, read: true, skipInvalidate: true });
    }
  }, [isOpen, entry, markAsRead]);

  // When lightbox closes, remove read entries from unreadOnly list
  // This deferred removal prevents white screen on mobile when unreadOnly is enabled
  useEffect(() => {
    if (!isOpen && markedAsReadRef.current.size > 0) {
      removeFromUnreadList(markedAsReadRef.current);
      markedAsReadRef.current.clear();
    }
  }, [isOpen, removeFromUnreadList]);

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
          // 与左箭头同语义：同条目内退一张，到条目开头就退到上一条目的最后一张
          if (currentIndex === 0 && galleryIndex > 0) {
            prev();
          } else {
            emblaApi?.scrollPrev();
          }
          break;
        case "ArrowRight":
          // 同条目内切一张，切到条目末尾就跳到下一条目
          if (
            currentIndex === images.length - 1 &&
            galleryIndex < gallery.length - 1
          ) {
            next();
          } else {
            emblaApi?.scrollNext();
          }
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    isOpen,
    close,
    emblaApi,
    currentIndex,
    gallery.length,
    galleryIndex,
    images.length,
    next,
    prev,
  ]);

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

  // 图片手势：滚轮 / 双击 / 捏合缩放，放大后拖动平移（换图自动复位）
  const zoom = useImageZoom(`${entry?.id ?? ""}:${currentIndex}`);

  const handleCarouselPointerDown = useCallback((e: React.PointerEvent) => {
    pointerDownPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleCarouselClick = useCallback(
    (e: React.MouseEvent) => {
      // Only close if pointer moved less than 5px (pure click, not drag)
      if (pointerDownPos.current) {
        const dx = Math.abs(e.clientX - pointerDownPos.current.x);
        const dy = Math.abs(e.clientY - pointerDownPos.current.y);
        if (dx < 5 && dy < 5) {
          close();
        }
      }
      pointerDownPos.current = null;
    },
    [close],
  );

  const handleOverlayClick = useCallback(() => {
    close();
  }, [close]);

  const handleToggleStarred = useCallback(() => {
    if (entry) {
      const newStarred = !entry.starred;
      markAsStarred(
        { id: entry.id, starred: newStarred },
        {
          onSuccess: () => {
            updateEntryStarred(newStarred);
          },
        },
      );
    }
  }, [entry, markAsStarred, updateEntryStarred]);

  const publishedAt = entry?.publishedAt
    ? formatRelativeTime(entry.publishedAt, t)
    : null;

  // Strip HTML for content preview
  const contentPreview = entry?.content
    ? stripHtml(entry.content).slice(0, 200)
    : null;

  /**
   * 切到下一条目时给一条简洁提示（来源 + 标题）。
   * 只在「画廊里跨条目」时出现 —— 同一条目内切图不需要提示（用户 2026-09-17 要求）。
   */
  const hasGallery = gallery.length > 1;
  const [switchHint, setSwitchHint] = useState<string | null>(null);
  const lastHintedEntryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !hasGallery || !entry) return;
    if (lastHintedEntryRef.current === null) {
      lastHintedEntryRef.current = entry.id;
      return;
    }
    if (lastHintedEntryRef.current === entry.id) return;
    lastHintedEntryRef.current = entry.id;
    const source = feed?.title ? `${feed.title} · ` : "";
    setSwitchHint(`${source}${entry.title || ""}`.trim());
    const timer = setTimeout(() => setSwitchHint(null), 1800);
    return () => clearTimeout(timer);
  }, [entry, feed, hasGallery, isOpen]);

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
          {/* Content container */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Top right buttons */}
            <div className="absolute right-[calc(1rem+env(safe-area-inset-right,0px))] top-[calc(1rem+env(safe-area-inset-top,0px))] z-10 flex gap-2">
              {/* Star button */}
              <button
                type="button"
                className={cn(
                  "flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20",
                  entry?.starred &&
                    "bg-amber-500/20 text-amber-500 hover:bg-amber-500/30",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleStarred();
                }}
                title={
                  entry?.starred
                    ? t("entry.remove_from_starred")
                    : t("entry.add_to_starred")
                }
              >
                <svg
                  className="size-5"
                  viewBox="0 0 24 24"
                  fill={entry?.starred ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                  />
                </svg>
              </button>
              {/* Open original page */}
              {entry?.url && (
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                  onClick={(e) => e.stopPropagation()}
                >
                  <svg
                    className="size-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </a>
              )}
              {/* Close button */}
              <button
                type="button"
                className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                onClick={close}
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

            {/* Image carousel */}
            <div className="flex min-h-0 flex-1 items-center justify-center safe-area-x">
              {images.length === 1 ? (
                <motion.div
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.9, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="relative flex size-full items-center justify-center"
                  ref={zoom.containerRef}
                  {...zoom.handlers}
                >
                  <img
                    src={images[0]}
                    alt=""
                    className="max-h-full max-w-full object-contain"
                    style={zoom.style}
                  />
                  {/* Video play overlay */}
                  {isVideoThumbnail(entry?.thumbnailUrl) && entry?.url && (
                    <a
                      href={entry.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="absolute flex items-center justify-center transition-transform hover:scale-110"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Play className="size-20 fill-white text-white drop-shadow-lg" />
                    </a>
                  )}
                </motion.div>
              ) : (
                <div
                  ref={zoom.containerRef}
                  className="size-full min-h-0"
                  onWheel={zoom.handlers.onWheel}
                  onDoubleClick={zoom.handlers.onDoubleClick}
                >
                <div
                  ref={emblaRef}
                  className="size-full min-h-0 overflow-hidden touch-manipulation"
                  onPointerDown={handleCarouselPointerDown}
                  onClick={handleCarouselClick}
                >
                  <div className="flex size-full min-h-0 touch-pan-y will-change-transform">
                    {images.map((src, index) => (
                      <div
                        key={src}
                        className="flex min-h-0 min-w-0 flex-[0_0_100%] items-center justify-center px-0 will-change-transform sm:px-2 lg:px-4"
                      >
                        <img
                          src={src}
                          alt=""
                          className="max-h-full max-w-full object-contain"
                          style={index === currentIndex ? zoom.style : undefined}
                          loading={
                            Math.abs(index - currentIndex) <= 1
                              ? "eager"
                              : "lazy"
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
                </div>
              )}

              {/* Navigation arrows —— 同条目多图，或画廊里还有别的条目时都要出现 */}
              {(images.length > 1 || gallery.length > 1) && (
                <>
                  <button
                    type="button"
                    className={cn(
                      "absolute left-4 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors",
                      currentIndex === 0 && galleryIndex === 0
                        ? "invisible"
                        : "hover:bg-white/20",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      // 画廊里退到尽头时，交给 store 切到上一个条目（embla 只管本条目的图）
                      if (currentIndex === 0 && galleryIndex > 0) {
                        prev();
                        return;
                      }
                      emblaApi?.scrollPrev();
                    }}
                    disabled={currentIndex === 0 && galleryIndex === 0}
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
                    className={cn(
                      "absolute right-4 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors",
                      currentIndex === images.length - 1 &&
                      galleryIndex === gallery.length - 1
                        ? "invisible"
                        : "hover:bg-white/20",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      // 图片切到头 → 跳到下一条目（用户要的就是这个）
                      if (
                        currentIndex === images.length - 1 &&
                        galleryIndex < gallery.length - 1
                      ) {
                        next();
                        return;
                      }
                      emblaApi?.scrollNext();
                    }}
                    disabled={
                      currentIndex === images.length - 1 &&
                      galleryIndex === gallery.length - 1
                    }
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

            {/* 跨条目切换的简洁提示（来源 · 标题），1.8s 自动消失 */}
            <AnimatePresence>
              {switchHint && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                  className="pointer-events-none absolute left-1/2 top-[calc(1rem+env(safe-area-inset-top,0px))] z-20 max-w-[min(80vw,32rem)] -translate-x-1/2 truncate rounded-full bg-black/70 px-4 py-1.5 text-sm text-white/90 backdrop-blur-sm"
                >
                  {switchHint}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Bottom info bar */}
            <div
              className="absolute bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-black/80 via-black/50 to-black/0 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom,0px))] backdrop-blur-sm sm:bg-black/50 sm:px-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mx-auto max-w-3xl">
                {/* Source and time */}
                <div className="mb-2 flex items-center gap-2 text-sm text-white/60">
                  {showIcon ? (
                    <img
                      src={`/icons/${feed.iconPath}`}
                      alt=""
                      className="size-4 shrink-0 rounded-[var(--ui-icon-radius,4px)] object-contain"
                      onError={() => setIconError(true)}
                    />
                  ) : (
                    <FeedIcon className="size-4 shrink-0" />
                  )}
                  <span>{feed?.title || t("entry.unknown_feed")}</span>
                  {publishedAt && (
                    <>
                      <span>·</span>
                      <span>{publishedAt}</span>
                    </>
                  )}
                  {images.length > 1 && (
                    <>
                      <span>·</span>
                      <span>
                        {currentIndex + 1} / {images.length}
                      </span>
                    </>
                  )}
                  {/* 画廊位置：能跨条目浏览时才有意义 */}
                  {gallery.length > 1 && (
                    <>
                      <span>·</span>
                      <span data-testid="gallery-counter">
                        {galleryIndex + 1} / {gallery.length}
                      </span>
                    </>
                  )}
                </div>

                {/* Title */}
                {entry?.title && (
                  <h2 className="mb-1 text-lg font-semibold text-white">
                    {entry.title}
                  </h2>
                )}

                {/* Content preview */}
                {contentPreview && (
                  <p className="line-clamp-2 text-sm text-white/70">
                    {contentPreview}
                  </p>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
