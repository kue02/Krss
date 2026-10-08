import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { getProxiedImageUrl } from "@/lib/image-proxy";
import {
  computeSingleBox,
  gridColumns,
  isSameRatio,
  rowItemWidth,
  type ContentMedia,
} from "@/lib/extract-content-media";
import {
  isRecoverableProxyUrl,
  renewProxyCookie,
  withProxyCacheBust,
} from "@/lib/proxy-image-recovery";
import { useImageDimensionsStore } from "@/stores/image-dimensions-store";

/**
 * 社交媒体视图的图片区（第四十二批 · §2.40）。
 *
 * 解决的是「一张图也显示不清楚」：原来写死 `size-28 object-cover`
 * （112×112 正方形），2048×570 的横图被压成一条细带、940×1474 的竖图被
 * 裁掉上下。这里按原图比例算盒子（Folo 的 `MediaGallery` 口径）。
 *
 * 三条排版分支（与 Folo `media-gallery.tsx` 同）：
 *  - **同比例 → 横排** `flex + overflow-x-auto`：1 张满宽 / 2 张半宽 / 3+ 张 1/3 宽，
 *    每张高度按自己的真实比例算。超过 3 张**全给**（原实现 `slice(0,3)` 会丢图）。
 *  - **比例不一致 → grid**：2~4 张两列、5+ 三列。
 *  - **单图封顶**：高度超 `2/3 屏高` 时按高度反算宽度、两侧留边，**零裁切**。
 *
 * 与 Folo 的两处**故意不同**（用户 2026-10-08 拍板「先按推荐的来，对齐 Folo 以后再说」）：
 *  1. **grid 每格用 `object-contain` 而非 Folo 的 `object-cover`** —— 零裁切。
 *     实测库里 23 条混合比例的条目，`cover` 会把 1316×980 那张上下共裁 28%。
 *  2. 尺寸第一级（Folo 服务端入库解析）krss 没有，走「store 缓存 → onLoad 实测」，
 *     无尺寸时先按 3:4 占位。这是 Folo `Media.tsx:245` 的同一条路。
 *
 * store 的 key 是**原始 URL**（`media.src`），与 `PictureItem.tsx` 用的
 * `entry.thumbnailUrl` 同一侧 —— 见 `extract-content-media.ts` 顶部注释。
 */

/** 首屏占位比例（与图片视图 `PictureItem.tsx` 的 `DEFAULT_RATIO` 同值） */
const DEFAULT_RATIO = 3 / 4;
/** Folo 单图上限：`window.innerHeight * 2/3`（`media-gallery.tsx:59`） */
const SINGLE_MAX_HEIGHT_RATIO = 2 / 3;
/** 容器宽还没量到时的兜底（社交卡片内容区 ≈ 600px） */
const FALLBACK_CONTAINER_WIDTH = 600;
const FALLBACK_VIEWPORT_HEIGHT = 900;

export interface SocialMediaGalleryProps {
  media: ContentMedia[];
  /** 条目地址：作图片代理的 referer */
  articleUrl?: string;
  /** 点图开大图查看器，参数是代理后的 URL 列表与被点的那张下标 */
  onOpenImage?: (urls: string[], index: number) => void;
  className?: string;
}

interface GalleryImageProps {
  item: ContentMedia;
  /** 代理后的 URL（给 `<img src>`） */
  proxied: string;
  /**
   * 横排分支的盒子宽高。grid 分支传 undefined —— 那里尺寸由 CSS
   * `aspect-square` 给，内容用 `object-contain` 落在中间。
   */
  box?: { width: number; height: number };
  onOpen?: () => void;
}

const GalleryImage = memo(function GalleryImage({
  item,
  proxied,
  box,
  onOpen,
}: GalleryImageProps) {
  const setDimension = useImageDimensionsStore((state) => state.setDimension);
  const markFailed = useImageDimensionsStore((state) => state.markFailed);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [failed, setFailed] = useState(false);

  const measure = useCallback(
    (img: HTMLImageElement) => {
      if (img.naturalWidth && img.naturalHeight) {
        setDimension(item.src, img.naturalWidth, img.naturalHeight);
      }
    },
    [item.src, setDimension],
  );

  /**
   * 浏览器缓存命中的图**不再触发 `load`**（直接 `complete = true`），
   * 只在 `onLoad` 里量尺寸的话，回访用户的这张图永远量不到 ⇒ 永远退回 3:4
   * 占位。挂载时补记一次（与 `PictureItem.tsx:62-69` 同一个坑、同一个修法）。
   */
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete) measure(img);
  }, [measure]);

  const handleError = useCallback(() => {
    // 24-4：代理 cookie 掉了先续期、再换个 URL 重载一次；仍失败才隐藏
    if (isRecoverableProxyUrl(proxied) && !recovered) {
      setRecovered(true);
      void renewProxyCookie();
      return;
    }
    markFailed(item.src);
    setFailed(true);
  }, [proxied, recovered, markFailed, item.src]);

  if (failed) return null;

  const src = recovered ? withProxyCacheBust(proxied) : proxied;

  return (
    <button
      type="button"
      onClick={onOpen}
      data-slot="social-media-gallery-item"
      className={cn(
        "relative shrink-0 cursor-zoom-in overflow-hidden rounded-lg bg-secondary",
        // grid 分支没有 inline 盒子 —— 尺寸交给 CSS aspect-square
        !box && "aspect-square w-full",
      )}
      style={box ? { width: box.width, height: box.height } : undefined}
      aria-label="查看大图"
    >
      <img
        ref={imgRef}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={(event) => measure(event.currentTarget)}
        onError={handleError}
        // 盒子就是原图比例（横排分支）或正方形（grid 分支），
        // 两种情况都用 contain：零裁切，不为正方形去切偏竖/偏横的图。
        className="size-full object-contain"
      />
    </button>
  );
});

export const SocialMediaGallery = memo(function SocialMediaGallery({
  media,
  articleUrl,
  onOpenImage,
  className,
}: SocialMediaGalleryProps) {
  const failedImages = useImageDimensionsStore(
    useShallow((state) => state.failedImages),
  );
  const loadFromDB = useImageDimensionsStore((state) => state.loadFromDB);
  // 尺寸表整体进依赖：任何一张量到新尺寸都会重排（无尺寸那批靠这条生效）
  const dimensions = useImageDimensionsStore(
    useShallow((state) => state.dimensions),
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const visible = useMemo(
    () => media.filter((m) => !failedImages.has(m.src)),
    [media, failedImages],
  );

  const proxiedUrls = useMemo(
    () => visible.map((m) => getProxiedImageUrl(m.src, articleUrl)),
    [visible, articleUrl],
  );

  /**
   * 首屏先查 IndexedDB —— 上次量过的图同步命中，渲染即正确高度，
   * 不经历「3:4 占位 → 重排」。key 用原始 URL（`media.src`）。
   */
  useEffect(() => {
    if (visible.length > 0) void loadFromDB(visible.map((m) => m.src));
  }, [visible, loadFromDB]);

  /** 量容器宽 + 视口高：横排分支算盒子、封顶要用 `2/3 屏高` */
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const measure = () => {
      setContainerWidth(node.clientWidth);
      setViewportHeight(window.innerHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  /** 这张图现在知不知道比例：HTML 属性 → store 缓存 */
  const resolveKnown = useCallback(
    (item: ContentMedia) => {
      if (item.width && item.height) {
        return { width: item.width, height: item.height };
      }
      const dim = dimensions[item.src];
      return dim ? { width: dim.width, height: dim.height } : null;
    },
    [dimensions],
  );

  if (visible.length === 0) return null;

  const width = containerWidth || FALLBACK_CONTAINER_WIDTH;
  const viewport = viewportHeight || FALLBACK_VIEWPORT_HEIGHT;
  // 比例是否一致只看**已知**尺寸：某张还没量到就退回 grid 之外的保守排法，
  // 等它量到之后重渲染即可（store 变化会触发）
  const sameRatio = isSameRatio(visible, false);

  const open = (index: number) => onOpenImage?.(proxiedUrls, index);

  if (!sameRatio) {
    const cols = gridColumns(visible.length);
    return (
      <div
        ref={containerRef}
        data-slot="social-media-gallery"
        data-branch="grid"
        className={cn(
          "mt-3 grid gap-2",
          cols === 3 ? "grid-cols-3" : "grid-cols-2",
          className,
        )}
      >
        {visible.map((item, i) => (
          <GalleryImage
            key={item.src}
            item={item}
            proxied={proxiedUrls[i] ?? item.src}
            onOpen={() => open(i)}
          />
        ))}
      </div>
    );
  }

  const itemWidth = rowItemWidth(visible.length, width);
  const maxHeight = viewport * SINGLE_MAX_HEIGHT_RATIO;

  return (
    <div
      ref={containerRef}
      data-slot="social-media-gallery"
      data-branch="row"
      className={cn(
        "mt-3 flex items-start gap-2 overflow-x-auto pb-1",
        className,
      )}
    >
      {visible.map((item, i) => {
        const known = resolveKnown(item);
        const ratio = known ? known.height / known.width : DEFAULT_RATIO;
        // 单图才封顶（Folo 口径）；多图按各自的真实比例算高
        const box =
          visible.length === 1 && known
            ? computeSingleBox(itemWidth, known.width, known.height, maxHeight)
            : { width: itemWidth, height: itemWidth * ratio };
        return (
          <GalleryImage
            key={item.src}
            item={item}
            proxied={proxiedUrls[i] ?? item.src}
            box={box}
            onOpen={() => open(i)}
          />
        );
      })}
    </div>
  );
});