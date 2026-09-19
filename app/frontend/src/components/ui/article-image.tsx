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
  ...props
}: ArticleImageProps & React.ImgHTMLAttributes<HTMLImageElement>) {
  const articleUrl = useContext(ArticleLinkContext);
  const imagePreviewContext = useContext(ImagePreviewContext);

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
    setIsLoaded(true);
  }, [proxiedSrc]);

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

  // Only show skeleton placeholder if we have dimensions
  const showSkeleton = !isLoaded && width && height;

  return (
    <img
      src={recoveredSrc ?? proxiedSrc}
      srcSet={proxiedSrcset}
      sizes={sizes}
      alt={alt}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      onLoad={handleLoad}
      onError={handleError}
      onClick={handleClick}
      className={cn(
        "max-w-full h-auto rounded transition-opacity duration-200",
        showSkeleton && "bg-secondary/30",
        isLoaded ? "opacity-100" : "opacity-70",
        imagePreviewContext && "cursor-zoom-in",
        className,
      )}
      {...props}
    />
  );
});
