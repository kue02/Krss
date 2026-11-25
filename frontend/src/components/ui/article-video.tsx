import {
  Children,
  Suspense,
  isValidElement,
  lazy,
  useContext,
  useMemo,
} from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProxiedImageUrl } from "@/lib/image-proxy";
import { API_BASE_URL } from "@/lib/server-url";
import { useAuthedImageUrl } from "@/lib/use-authed-image";
import { ArticleLinkContext } from "./article-image";

/**
 * 正文里的 `<video>`。播放器换成 NextFlux 同款的 Video.js 10 for React
 * （`@videojs/react`），带完整控制条（播放 / 进度 / 音量 / 全屏 / 倍速）。
 *
 * 这一层只做「地址解析 + 代理 / 鉴权」：
 * - `src` / `<source src>` / `poster` 都过一遍同一个图片 / 媒体代理
 *   （浏览器直连外站图床 / 视频在部分网络下拉不动，见 `proxy_service.go` 的 FetchMedia，
 *   代理对 Range 回 206，拖动进度条可用）；
 * - App（自定义 scheme）里 `<video src>` 带不上 Authorization，用带 token 的 fetch
 *   换成 blob URL 交给播放器（`useAuthedImageUrl`，同源网页构建直接透传不增加请求）；
 * - 播放器重依赖走 `React.lazy`，没视频的文章不进首屏 chunk。
 *
 * 播放器下面按 NextFlux 的做法挂一个居中的来源药丸（hostname + ↗），外链打开原视频。
 */
interface ArticleVideoProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  src?: string;
  poster?: string;
}

const LazyArticleVideoPlayer = lazy(() =>
  import("./article-video-player").then((mod) => ({
    default: mod.ArticleVideoPlayer,
  })),
);

/** 只对 http(s) 原始地址给外链药丸；data: / blob: / 相对地址不给。 */
function getHttpHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

export function ArticleVideo({
  src,
  poster,
  className,
  children,
}: ArticleVideoProps) {
  const articleUrl = useContext(ArticleLinkContext);
  const { i18n } = useTranslation();

  // 有些源把地址写在 `<source src>` 里，`video[src]` 是空的：用第一个 source 当主地址。
  const sourceChildren = useMemo(() => {
    const list: { src: string; type?: string }[] = [];
    Children.forEach(children, (child) => {
      if (
        isValidElement<{ src?: string; type?: string }>(child) &&
        child.type === "source" &&
        child.props.src
      ) {
        list.push({ src: child.props.src, type: child.props.type });
      }
    });
    return list;
  }, [children]);

  const primarySrc = src || sourceChildren[0]?.src;

  const proxiedSrc = useMemo(
    () => (primarySrc ? getProxiedImageUrl(primarySrc, articleUrl) : undefined),
    [primarySrc, articleUrl],
  );
  const proxiedPoster = useMemo(
    () => (poster ? getProxiedImageUrl(poster, articleUrl) : undefined),
    [poster, articleUrl],
  );

  // 同源网页构建：直接透传代理地址（可流式 + Range 拖动）。
  // App 构建：带 token fetch 成 blob（整段下载，受 §2.61 Range 限制，属既有取舍）。
  const authedSrc = useAuthedImageUrl(proxiedSrc, {
    enabled: Boolean(API_BASE_URL),
  });
  const authedPoster = useAuthedImageUrl(proxiedPoster);

  const locale = i18n.language?.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en";
  const hostname = getHttpHostname(primarySrc);

  if (!primarySrc) return null;

  return (
    <div
      data-slot="article-video"
      className={cn(
        "article-media-player not-prose my-4 w-full",
        className,
      )}
    >
      <Suspense
        fallback={
          <div
            aria-hidden="true"
            className="w-full rounded-[var(--radius-lg)] bg-secondary"
            style={{ aspectRatio: "16 / 9" }}
          />
        }
      >
        {authedSrc ? (
          <LazyArticleVideoPlayer
            src={authedSrc}
            poster={authedPoster}
            locale={locale}
          />
        ) : (
          <div
            aria-hidden="true"
            className="w-full rounded-[var(--radius-lg)] bg-secondary"
            style={{ aspectRatio: "16 / 9" }}
          />
        )}
      </Suspense>

      {hostname && primarySrc && (
        <div className="mt-2 flex justify-center">
          <a
            href={primarySrc}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent bg-secondary px-2 py-0.5 text-xs font-medium whitespace-nowrap text-secondary-foreground transition-colors hover:bg-secondary/80 focus-visible:border-ring focus-visible:ring-[3px]"
          >
            {hostname}
            <ArrowUpRight className="size-3 opacity-70" aria-hidden="true" />
          </a>
        </div>
      )}
    </div>
  );
}
