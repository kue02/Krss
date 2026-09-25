import {
  Children,
  cloneElement,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ProgressBar } from "@heroui/react";
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
 *
 * 封面 + 悬停（§2.25）：
 * - 有 poster → poster 当封面，`preload="none"`（进页面零请求）；
 * - 无 poster → `preload="metadata"` 只拉头部、浏览器自动渲染首帧当封面
 *   （完整视频流仍是首次悬停才拉，不是进页面全量下载）；
 * - 两者都拿不到（error）→ 中性底 + 「新窗口打开」出口，绝不纯黑/纯白空框。
 * - 悬停 → 静音就地播放 + 底部细进度条；移开 → 暂停并 `load()` 回到封面。
 * - 点击保持现状：打开大屏播放器（顺手把就地这路先 pause）。
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
  const [hovering, setHovering] = useState(false);
  const [progress, setProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const hasPoster = Boolean(poster);

  const proxiedSrc = useMemo(
    () => (src ? (getProxiedImageUrl(src, articleUrl) ?? src) : undefined),
    [src, articleUrl],
  );
  const proxiedPoster = useMemo(
    () => (poster ? (getProxiedImageUrl(poster, articleUrl) ?? poster) : undefined),
    [poster, articleUrl],
  );

  // 换了条目就重置错误态与悬停态
  useEffect(() => {
    setHasError(false);
    setHovering(false);
    setProgress(0);
  }, [proxiedSrc]);

  // 悬停：静音就地播（首次悬停才拉流）；移开：暂停并回到封面。
  // load() 会把视频重置回 poster/首帧；有 poster 时回到 poster，无 poster 回到首帧。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || hasError) return;
    if (hovering) {
      video.muted = true;
      void video.play().catch(() => {
        // 自动播放被拦就保持封面态，不报错打扰用户
      });
    } else {
      video.pause();
      // 之前播过（currentTime > 0 或进度 > 0）才 load() 回封面；
      // 刚挂载没播过时不调，避免无 poster 的 metadata 首帧被冲掉。
      if (video.currentTime > 0 || progress > 0) {
        setProgress(0);
        video.load();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovering]);

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
    videoRef.current?.pause();
    setHovering(false);
    openVideoPreview(proxiedSrc, proxiedPoster ?? null, proxiedSrc);
  };

  const handleTimeUpdate = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (video.duration > 0 && Number.isFinite(video.duration)) {
      setProgress(video.currentTime / video.duration);
    }
  };

  return (
    <span className="my-2 block">
      {/* 就地只放封面 + 播放键，点开由大屏播放器播（用户反馈：卡片里的小视频没法拖动进度） */}
      <button
        type="button"
        onMouseEnter={() => {
          if (!hasError && proxiedSrc) setHovering(true);
        }}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => {
          if (!hasError && proxiedSrc) setHovering(true);
        }}
        onBlur={() => setHovering(false)}
        onClick={(event) => {
          event.stopPropagation();
          handleOpen();
        }}
        aria-label="播放视频"
        className="article-video group/video relative block w-full cursor-pointer overflow-hidden rounded-lg bg-secondary"
      >
        {/* 源 HTML 常带 controls，这里丢掉：就地只当封面/悬停预览，点了开大屏播放器 */}
        <video
          ref={videoRef}
          src={childNodes ? undefined : proxiedSrc}
          poster={proxiedPoster}
          muted
          playsInline
          disablePictureInPicture
          preload={hasPoster ? "none" : "metadata"}
          onError={() => setHasError(true)}
          onTimeUpdate={handleTimeUpdate}
          className={cn("pointer-events-none size-full object-cover", className)}
          {...props}
        >
          {childNodes}
        </video>
        {/* 悬停播放中的底部细进度条（HeroUI ProgressBar） */}
        {hovering && !hasError && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 px-0">
            <ProgressBar
              aria-label="视频播放进度"
              className="w-full"
              size="sm"
              maxValue={1}
              value={progress}
              data-slot="article-video-progress"
            >
              <ProgressBar.Track className="rounded-none bg-black/40">
                <ProgressBar.Fill className="bg-white/90" />
              </ProgressBar.Track>
            </ProgressBar>
          </span>
        )}
        {/* 播放键：播起来就淡出，回到封面再出现 */}
        <span
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-200",
            hovering && !hasError ? "opacity-0" : "opacity-100",
          )}
        >
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
