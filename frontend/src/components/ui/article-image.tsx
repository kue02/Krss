import {
  memo,
  useState,
  useCallback,
  useContext,
  createContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { cn } from "@/lib/utils";
import { getProxiedImageUrl } from "@/lib/image-proxy";
import {
  isRecoverableProxyUrl,
  renewProxyCookie,
  withProxyCacheBust,
} from "@/lib/proxy-image-recovery";
import { ImagePreviewContext } from "./article-content";
import { useFittedImageBox } from "@/hooks/useFittedImageBox";
import {
  useImageDimension,
  useImageDimensionsStore,
} from "@/stores/image-dimensions-store";

// Context for passing article URL to resolve relative URLs and set Referer
// eslint-disable-next-line react-refresh/only-export-components
export const ArticleLinkContext = createContext<string | undefined>(undefined);

// Global cache to track loaded images - prevents flash when component remounts
const loadedImagesCache = new Set<string>();

interface ArticleImageProps {
  src?: string;
  alt?: string;
  width?: string | number;
  height?: string | number;
  srcset?: string;
  sizes?: string;
  className?: string;
  /**
   * 42-9：按容器宽 + 原图比例自适应（引文与社交正文开启）。
   *
   * 与「外层那个引文框」无关 —— 引文内外的 `<img>` 走同一个组件，逻辑从此一套。
   * 文章视图不传（保持 prose 的 `max-w-full h-auto` 原样）。
   */
  fit?: boolean;
}

/**
 * Proxy srcset URLs
 */
function proxySrcset(srcset: string, articleUrl?: string): string {
  return srcset
    .split(",")
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts.length >= 1 && parts[0]) {
        parts[0] = getProxiedImageUrl(parts[0], articleUrl);
      }
      return parts.join(" ");
    })
    .join(", ");
}

/**
 * Article image component with lazy loading and error handling
 * Uses memo to prevent re-rendering when parent content changes
 */
export const ArticleImage = memo(function ArticleImage({
  src,
  alt = "",
  width,
  height,
  srcset,
  sizes,
  className,
  fit = false,
  priority = false,
  ...props
}: ArticleImageProps &
  React.ImgHTMLAttributes<HTMLImageElement> & {
    /** 50-2：首屏头几张图 —— 立刻开始请求、给高优先级，别等 lazy 的判定 */
    priority?: boolean;
  }) {
  const articleUrl = useContext(ArticleLinkContext);
  const imagePreviewContext = useContext(ImagePreviewContext);

  // 42-9：自适应盒子（fit 关闭时 hook 内部全部短路，零开销）
  const { containerRef, box, handleLoad: handleFitLoad } = useFittedImageBox({
    src,
    declaredWidth: width ? Number(width) : undefined,
    declaredHeight: height ? Number(height) : undefined,
    enabled: fit,
  });

  // Compute proxied URLs first so we can check the cache
  const proxiedSrc = useMemo(
    () => (src ? getProxiedImageUrl(src, articleUrl) : ""),
    [src, articleUrl],
  );
  const proxiedSrcset = useMemo(
    () => (srcset ? proxySrcset(srcset, articleUrl) : undefined),
    [srcset, articleUrl],
  );

  // Initialize isLoaded based on cache - prevents flash on remount
  const [isLoaded, setIsLoaded] = useState(() =>
    loadedImagesCache.has(proxiedSrc),
  );
  const [isError, setIsError] = useState(false);
  // 24-4：cookie 掉了代理图会 401 —— 先续期再重载一次，不行才进破图占位
  const [recoveredSrc, setRecoveredSrc] = useState<string | null>(null);
  const recoveredRef = useRef<string | null>(null);

  // 同一挂载换了 src（列表复用节点）：上一张的救济状态不能带过来
  useEffect(() => {
    recoveredRef.current = null;
    setRecoveredSrc(null);
    setIsError(false);
  }, [proxiedSrc]);

  const handleLoad = useCallback(() => {
    loadedImagesCache.add(proxiedSrc);
    // 无源尺寸图：解码后回写 dimension-store（key 用原始 src，与
    // SocialMediaGallery 同一侧），同源复用、二次打开直接有预占。
    // fit=true 路径不动 —— fit 有自己的 box 测量，这里只管预占。
    // 用 containerRef 直读（event.currentTarget 在 React 18 回调里不可靠）。
    const img = containerRef.current;
    if (src && img?.naturalWidth && img?.naturalHeight) {
      useImageDimensionsStore
        .getState()
        .setDimension(src, img.naturalWidth, img.naturalHeight);
    }
    setIsLoaded(true);
  }, [proxiedSrc, src]);

  const handleError = useCallback(() => {
    const current = recoveredRef.current ?? proxiedSrc;
    if (isRecoverableProxyUrl(current) && recoveredRef.current === null) {
      recoveredRef.current = withProxyCacheBust(current);
      void renewProxyCookie().finally(() => {
        const next = recoveredRef.current;
        if (next) {
          loadedImagesCache.delete(next);
          setRecoveredSrc(next);
        }
      });
      return;
    }
    setIsError(true);
  }, [proxiedSrc]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (src && imagePreviewContext) {
        e.preventDefault();
        e.stopPropagation();
        imagePreviewContext.openPreview(src);
      }
    },
    [src, imagePreviewContext],
  );

  // fit=true 路径不动（自适应盒子自己管尺寸）；以下只管 fit=false 的文章视图。
  // 有源尺寸 → 原行为（skeleton + width/height 属性）不变。
  // 注意：hook 必须在 early return 之前调用 —— fit=true 时查了也不用，
  // 开销只是一次 map 读取。
  const hasDeclaredSize = Boolean(width && height);
  // 无源尺寸 → 查 dimension-store（同源复用：本篇或其他视图解码后回写的）。
  const cachedDim = useImageDimension(fit ? undefined : src);
  const reserveDim = !hasDeclaredSize && cachedDim ? cachedDim : undefined;

  if (!src) return null;

  if (isError) {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center bg-secondary/50 text-muted-foreground rounded",
          className,
        )}
        style={{
          width: width ? Number(width) : "auto",
          height: height ? Number(height) : 80,
        }}
      >
        <svg
          className="size-5 opacity-40"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
      </span>
    );
  }

  // 兜底预占：既无源尺寸、store 里也没有 → aspect-ratio 16/10 + 最小高度，
  // 图片解码后回写 store，下次同源直接按真实比例预占。
  // CLS 收益：加载前容器已有固定高度，不再是 0 高 → 图片撑开跳动。

  // Only show skeleton placeholder if we have dimensions
  const showSkeleton = !isLoaded && (hasDeclaredSize || reserveDim);

  // 无源尺寸 + 无缓存：包一层预占容器（图片本身保持 h-auto 原样）。
  // 解码完成后容器高度由图片自然高度接管（minHeight 只在加载前生效）。
  if (!fit && !hasDeclaredSize && !isLoaded) {
    const ratio = reserveDim
      ? `${reserveDim.width} / ${reserveDim.height}`
      : "16 / 10";
    return (
      <span
        data-slot="article-image-reserve"
        className={cn(
          "block w-full overflow-hidden rounded bg-secondary/30",
          className,
        )}
        style={{ aspectRatio: ratio, minHeight: 120 }}
      >
        <img
          ref={containerRef}
          src={recoveredSrc ?? proxiedSrc}
          srcSet={proxiedSrcset}
          sizes={sizes}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : undefined}
          decoding="async"
          onLoad={() => {
            handleLoad();
          }}
          onError={handleError}
          onClick={handleClick}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-200",
            isLoaded ? "opacity-100" : "opacity-70",
            imagePreviewContext && "cursor-zoom-in",
          )}
          {...props}
        />
      </span>
    );
  }

  return (
    <img
      ref={containerRef}
      src={recoveredSrc ?? proxiedSrc}
      srcSet={proxiedSrcset}
      sizes={sizes}
      alt={alt}
      width={width}
      height={height}
      // 50-2：首屏那几张走 eager + 高优先级（文字是 HTML 里现成的所以秒出，
      // 图片原来全 lazy ⇒ 要等浏览器判定进度才发请求，正是「图片要等很久」）
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding="async"
      onLoad={(event) => {
        handleFitLoad(event);
        handleLoad();
      }}
      onError={handleError}
      onClick={handleClick}
      className={cn(
        "max-w-full h-auto rounded transition-opacity duration-200",
        showSkeleton && "bg-secondary/30",
        isLoaded ? "opacity-100" : "opacity-70",
        imagePreviewContext && "cursor-zoom-in",
        className,
      )}
      style={
        box
          ? {
              width: `${box.width}px`,
              height: `${box.height}px`,
              maxWidth: "100%",
              objectFit: "contain",
            }
          : undefined
      }
      {...props}
    />
  );
});
