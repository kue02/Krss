import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { getEntryImages } from "@/lib/extract-images";
import { getProxiedImageUrl } from "@/lib/image-proxy";
import { isVideoThumbnail } from "@/lib/media-utils";
import { formatRelativeTime } from "@/lib/date-utils";
import {
  useLightboxStore,
  type LightboxGalleryItem,
} from "@/stores/lightbox-store";
import {
  useImageDimension,
  useImageDimensionsStore,
  useImageFailed,
} from "@/stores/image-dimensions-store";
import { FeedIcon } from "@/components/ui/feed-icon";
import type { Entry, Feed } from "@/types/api";

interface PictureItemProps {
  entry: Entry;
  feed?: Feed;
  /** 网格模式：强制 1:1 正方格（图片视图设置里的「网格」） */
  square?: boolean;
  /** 图片视图里已加载的整条画廊：交给灯箱做「同条目内切图 → 切到头跳下一条目」 */
  gallery?: LightboxGalleryItem[];
}

// Default 3:4 vertical aspect ratio for uncached images
const DEFAULT_RATIO = 3 / 4;
export const PictureItem = memo(function PictureItem({
  entry,
  feed,
  square = false,
  gallery,
}: PictureItemProps) {
  const { t } = useTranslation();
  const openLightbox = useLightboxStore((state) => state.open);
  const setDimension = useImageDimensionsStore((state) => state.setDimension);
  const markFailed = useImageDimensionsStore((state) => state.markFailed);

  // Get cached dimension from store
  const thumbnailUrl = entry.thumbnailUrl;
  const cachedDimension = useImageDimension(thumbnailUrl);
  const isFailed = useImageFailed(thumbnailUrl);
  // 网格模式一律 1:1（等高正方格），瀑布流模式用缓存的真实比例
  const aspectRatio = square ? 1 : (cachedDimension?.ratio ?? DEFAULT_RATIO);
  const isVideo = isVideoThumbnail(thumbnailUrl);

  const [imageLoaded, setImageLoaded] = useState(false);
  const [iconError, setIconError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const showIcon = feed?.iconPath && !iconError;

  /**
   * 缓存命中的图片不会再触发 onLoad（浏览器直接给 complete=true），
   * 于是真实宽高永远没被记录 → 所有格子都退回默认 3:4 → 瀑布流看着「一样高」。
   * 挂载时补记一次，保证「缓存图」也参与不规则排布（2026-09-17 用户反馈）。
   */
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !thumbnailUrl) return;
    if (img.complete && img.naturalWidth && img.naturalHeight) {
      setDimension(thumbnailUrl, img.naturalWidth, img.naturalHeight);
      setImageLoaded(true);
    }
  }, [setDimension, thumbnailUrl]);

  const handleImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      if (img.naturalWidth && img.naturalHeight && thumbnailUrl) {
        // Save dimensions to store (which also persists to IndexedDB)
        setDimension(thumbnailUrl, img.naturalWidth, img.naturalHeight);
      }
      setImageLoaded(true);
    },
    [thumbnailUrl, setDimension],
  );

  const handleClick = useCallback(() => {
    // Open lightbox (for both image and video)
    // Note: markAsRead is handled inside Lightbox to avoid race condition
    // when unreadOnly filter is enabled (item would disappear before lightbox opens)
    const images = getEntryImages(
      entry.thumbnailUrl,
      entry.content,
      entry.url ?? undefined,
    );
    if (images.length > 0) {
      openLightbox(entry, feed, images, 0, gallery);
    }
  }, [entry, feed, gallery, openLightbox]);

  const publishedAt = entry.publishedAt
    ? formatRelativeTime(entry.publishedAt, t)
    : null;

  if (!thumbnailUrl || isFailed) {
    return null;
  }

  return (
    <div className="p-1 sm:p-1.5">
      <div
        className="cursor-pointer overflow-hidden bg-card shadow-sm transition-shadow hover:shadow-md"
        onClick={handleClick}
      >
        {/* Image container with aspect ratio */}
        <div
          className="relative overflow-hidden bg-secondary"
          style={{ aspectRatio }}
        >
          <img
            ref={imgRef}
            src={getProxiedImageUrl(thumbnailUrl, entry.url ?? undefined)}
            alt={entry.title || ""}
            className={cn(
              "size-full object-cover transition-opacity duration-300",
              imageLoaded ? "opacity-100" : "opacity-0",
            )}
            loading="lazy"
            onLoad={handleImageLoad}
            onError={() => thumbnailUrl && markFailed(thumbnailUrl)}
          />
          {!imageLoaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
            </div>
          )}
          {/* Video play icon overlay */}
          {isVideo && imageLoaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Play className="size-12 fill-white text-white drop-shadow-lg" />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex h-10 items-center px-2 text-xs text-muted-foreground">
          {/* Unread indicator */}
          <div
            className={cn(
              "mr-1.5 size-1.5 shrink-0 rounded-full bg-orange-500 transition-all duration-200",
              entry.read && "mr-0 w-0",
            )}
          />
          {showIcon ? (
            <img
              src={`/icons/${feed.iconPath}`}
              alt=""
              className="mr-1.5 size-4 shrink-0 rounded-[var(--ui-icon-radius,4px)] object-contain"
              onError={() => setIconError(true)}
            />
          ) : (
            <FeedIcon className="mr-1.5 size-4 shrink-0 text-muted-foreground/50" />
          )}
          <span className="truncate">
            {feed?.title || t("entry.unknown_feed")}
          </span>
          {publishedAt && (
            <>
              <span className="mx-1.5 text-muted-foreground/50">·</span>
              <span className="shrink-0">{publishedAt}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
