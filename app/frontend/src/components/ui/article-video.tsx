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
import { cn } from "@/lib/utils";
import { getProxiedImageUrl } from "@/lib/image-proxy";
import { ArticleLinkContext } from "./article-image";

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
  ...props
}: ArticleVideoProps) {
  const articleUrl = useContext(ArticleLinkContext);
  const [hasError, setHasError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

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

  return (
    <span className="my-3 block">
      <video
        ref={videoRef}
        src={childNodes ? undefined : proxiedSrc}
        poster={proxiedPoster}
        controls
        playsInline
        preload="metadata"
        onError={() => setHasError(true)}
        className={cn(
          "mx-auto block max-h-[70vh] w-full rounded-lg bg-black/90",
          className,
        )}
        {...props}
      >
        {childNodes}
      </video>
      {hasError && proxiedSrc && (
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
