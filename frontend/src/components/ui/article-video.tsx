import {
  Children,
  cloneElement,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { getProxiedImageUrl } from "@/lib/image-proxy";
import { ArticleLinkContext } from "./article-image";
import { useVideoPreviewStore } from "@/stores/video-preview-store";

/**
 * 正文里的 <video>（社交源的视频几乎都是外链，例如 video.twimg.com）。
 *
 * 浏览器直接去拉那种地址在本机网络下基本拉不动（图床要靠后端代理，视频同理），
 * 所以这里把 src / poster / <source src> 都过一遍同一个代理。
 *
 * 代理侧要配合支持：Range 请求（拖动进度条）与 video/* 的内容类型，
 * 见 backend/internal/service/proxy_service.go 的 FetchMedia。
 */
interface ArticleVideoProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  src?: string;
  poster?: string;
}

export function ArticleVideo({
  src,
  poster,
  className,
  children,
  controls: _ignoredControls,
  ...props
}: ArticleVideoProps) {
  const articleUrl = useContext(ArticleLinkContext);
  const openVideoPreview = useVideoPreviewStore((state) => state.open);
  const [hasError, setHasError] = useState(false);

  const proxiedSrc = useMemo(
    () => (src ? (getProxiedImageUrl(src, articleUrl) ?? src) : undefined),
    [src, articleUrl],
  );
  const proxiedPoster = useMemo(
    () => (poster ? (getProxiedImageUrl(poster, articleUrl) ?? poster) : undefined),
    [poster, articleUrl],
  );

  // 换了条目就重置错误态
  useEffect(() => setHasError(false), [proxiedSrc]);

  // <source> 子节点也要走代理（有些源用 source 而不是 video 的 src）
  const childNodes = Children.map(children, (child) => {
    if (isValidElement<{ src?: string }>(child) && child.type === "source") {
      const childSrc = child.props.src;
      if (childSrc) {
        return cloneElement(child, {
          src: getProxiedImageUrl(childSrc, articleUrl) ?? childSrc,
        });
      }
    }
    return child;
  });

  const handleOpen = () => {
    if (!proxiedSrc || hasError) return;
    openVideoPreview(proxiedSrc, proxiedPoster ?? null, proxiedSrc);
  };

  return (
    <span className="my-2 block">
      {/* 就地只放封面 + 播放键，点开由大屏播放器播（用户反馈：卡片里的小视频没法拖动进度） */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          handleOpen();
        }}
        aria-label="播放视频"
        className="article-video group/video relative block w-full cursor-pointer overflow-hidden rounded-lg bg-black/90"
      >
        {/* 源 HTML 常带 controls，这里丢掉：就地只当封面，点了开大屏播放器 */}
        <video
          src={childNodes ? undefined : proxiedSrc}
          poster={proxiedPoster}
          muted
          playsInline
          preload="metadata"
          onError={() => setHasError(true)}
          className={cn("pointer-events-none size-full object-cover", className)}
          {...props}
        >
          {childNodes}
        </video>
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="article-video-badge flex size-11 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm transition-transform duration-200 group-hover/video:scale-105">
            <svg
              className="ml-0.5 size-5 text-white"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </span>
      </button>
      {hasError && (
        // 播放不了的兜底出口：至少能点开原站看
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block text-xs text-muted-foreground underline decoration-primary/40 underline-offset-2 hover:text-foreground"
        >
          视频加载失败，在新窗口打开
        </a>
      )}
    </span>
  );
}
