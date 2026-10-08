import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Slider, Skeleton } from "@heroui/react";
import { Pause, Play, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { getProxiedImageUrl } from "@/lib/image-proxy";
import { ArticleLinkContext } from "./article-image";
import { useVideoPreviewStore } from "@/stores/video-preview-store";

/** 秒 → `m:ss`（视频控件两侧的时间；`0:07` 这种，不补零到时分） */
function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

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
 * - 无 poster → 走 `/api/proxy` 拉视频，同时：
 *   a) `preload="metadata"` 只拉头部（不是进页面就整段下载）；
 *   b) src 加 `#t=0.1` 让浏览器**明确 seek 到 0.1s**，逼它解码首帧 ——
 *      `preload="metadata"` 并不保证渲染首帧（Chromium 要等数据到齐才画），
 *      实测清缓存后首次打开有 4~8s 只有空底、没有画面。
 *   c) 帧没到之前压一层 HeroUI `Skeleton`，**不露纯白/纯黑空框**；帧到了再淡入。
 * - 两者都拿不到（error）→ 中性底 + 「新窗口打开」出口。
 * - 悬停 → 静音就地播放；底部控制条可**点击跳转 / 拖拽快进**（第四十二批 · §2.40-42-7）。
 * - 点击画面（不是控制条）保持现状：打开大屏播放器（顺手把就地这路先 pause）。
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
  // 只为了从 props 里摘掉 controls：源 HTML 常带它，就地只当封面/悬停预览
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  controls: _ignoredControls,
  ...props
}: ArticleVideoProps) {
  const articleUrl = useContext(ArticleLinkContext);
  const { t } = useTranslation();
  const openVideoPreview = useVideoPreviewStore((state) => state.open);
  const [hasError, setHasError] = useState(false);
  const [hovering, setHovering] = useState(false);
  /** 播放头（秒）。就地播放的实际位置；拖拽中由 Slider 的 onChange 先改它 */
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  /** 用户正在拖进度：这段时间不让 timeupdate 回写 position，否则两个值打架 */
  const [scrubbing, setScrubbing] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const hasPoster = Boolean(poster);
  const [frameReady, setFrameReady] = useState(false);

  const proxiedSrc = useMemo(
    () => (src ? (getProxiedImageUrl(src, articleUrl) ?? src) : undefined),
    [src, articleUrl],
  );

  // 无 poster 时补 `#t=0.1`：让浏览器 seek 到 0.1s 解码出首帧当封面。
  // 已经带片段（#t=）的不重复加；有 poster 的也不需要。
  const playableSrc = useMemo(() => {
    if (!proxiedSrc || hasPoster) return proxiedSrc;
    if (/#t=|#.*\bt=/.test(proxiedSrc)) return proxiedSrc;
    return `${proxiedSrc}#t=0.1`;
  }, [proxiedSrc, hasPoster]);
  const proxiedPoster = useMemo(
    () => (poster ? (getProxiedImageUrl(poster, articleUrl) ?? poster) : undefined),
    [poster, articleUrl],
  );

  // 换了条目就重置错误态、悬停态与播放头
  useEffect(() => {
    setHasError(false);
    setHovering(false);
    setPosition(0);
    setDuration(0);
    setPaused(true);
    setScrubbing(false);
    setFrameReady(false);
  }, [proxiedSrc]);

  // 悬停：静音就地播（首次悬停才拉流）；移开：暂停并回到封面。
  // load() 会把视频重置回 poster/首帧；有 poster 时回到 poster，无 poster 回到首帧。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || hasError) return;
    if (hovering) {
      video.muted = true;
      // 首次 play() 可能因为元素刚挂载、还没数据可播而 reject（AbortError）。
      // 这种「不是用户拦的」失败要等 canplay 再补一次，否则用户明明悬停在上面
      // 却永远停在封面、控制条也不出（真机复现：reading 页 hover 6s 毫无反应）。
      const retry = () => {
        if (!hovering) return;
        void video.play().then(
          () => setPaused(false),
          () => setPaused(true),
        );
      };
      void video.play().then(
        () => setPaused(false),
        () => {
          setPaused(true);
          video.addEventListener("canplay", retry, { once: true });
        },
      );
    } else {
      video.pause();
      setPaused(true);
      // 之前播过（currentTime > 0）才 load() 回封面；
      // 刚挂载没播过时不调，避免无 poster 的 metadata 首帧被冲掉。
      if (video.currentTime > 0) {
        setPosition(0);
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

  /** duration 元数据到齐（首次 loadedmetadata / load() 之后也会再触发） */
  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      setDuration(video.duration);
    }
  };

  const handleTimeUpdate = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      setDuration(video.duration);
    }
    // 拖拽中不跟随播放头回写，否则把手会被拽回去
    if (!scrubbing) setPosition(video.currentTime);
  };

  /**
   * 拖拽/点按进度条：HeroUI Slider 的 onChange 在**按下即跳、拖动持续**触发，
   * 所以这里直接 seek —— 代理层对 Range 回 206（`proxy_service.go` FetchMedia），
   * 边拖边播。`onChangeEnd` 只用来解 dragging 标志。
   */
  const seekTo = useCallback((next: number | number[]) => {
    const value = Array.isArray(next) ? next[0] : next;
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    setPosition(value);
    const video = videoRef.current;
    if (!video) return;
    try {
      video.currentTime = Math.min(value, video.duration || value);
    } catch {
      // 元数据还没到，currentTime 赋值会抛；忽略，等 loadedmetadata 后自然对齐
    }
  }, []);

  /** 控制条上的播放/暂停：就地静音播 ↔ 暂停（不用回到封面）。
   *
   * 用 React 的 `paused` 状态判档，不读 `video.paused`：后者的真值只有在
   * play/pause 事件真正派发后才更新，状态更新与事件之间有窗口；
   * jsdom 下更是不随 mock 变化。状态是这个组件自己的真相，稳。 */
  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || hasError) return;
    if (paused) {
      video.muted = true;
      void video.play().then(
        () => setPaused(false),
        () => setPaused(true),
      );
    } else {
      video.pause();
      setPaused(true);
    }
  }, [hasError, paused]);

  const handleExternalOpen = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      window.open(src, "_blank", "noopener,noreferrer");
    },
    [src],
  );

  return (
    <span className="my-2 block">
      {/* 就地只放封面 + 播放键，点开由大屏播放器播（用户反馈：卡片里的小视频没法拖动进度）。

          容器是 `div[role=button]` 而不是 `<button>`：控制条里有真正的 `<button>`
          （播放/暂停）与 `<a>`（新窗口），嵌在 `<button>` 里是**非法 HTML**，
          键盘与读屏语义也会坏（React 也会就此告警）。role + tabIndex + Enter/Space
          保留可点击与可聚焦的外层语义。 */}
      <div
        role="button"
        tabIndex={0}
        onMouseEnter={() => {
          if (!hasError && proxiedSrc) setHovering(true);
        }}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => {
          if (!hasError && proxiedSrc) setHovering(true);
        }}
        onBlur={(event) => {
          // 焦点在控制条内部移动（点进度条/播放钮时焦点从容器转到里面的 input/button）
          // 不算「离开」：否则一点进度条就把 hovering 关掉，控制条卸载、video 被 load() 冲回起点
          const next = event.relatedTarget as HTMLElement | null;
          if (next && event.currentTarget.contains(next)) return;
          setHovering(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const target = event.target as HTMLElement;
          // 焦点在控制条里时不劫持（让 Space 能滚、Enter 能点里面的按钮）
          if (target.closest("[data-slot='article-video-controls']")) return;
          event.preventDefault();
          handleOpen();
        }}
        onClick={(event) => {
          // 点控制条（进度条/播放钮）不当作「打开大屏」——那些控件自己吃掉事件
          const target = event.target as HTMLElement;
          if (target.closest("[data-slot='article-video-controls']")) return;
          event.stopPropagation();
          handleOpen();
        }}
        aria-label="播放视频"
        className="article-video group/video relative block w-full cursor-pointer overflow-hidden rounded-lg bg-secondary"
      >
        {/* 源 HTML 常带 controls，这里丢掉：就地只当封面/悬停预览，点了开大屏播放器 */}
        <video
          ref={videoRef}
          src={childNodes ? undefined : playableSrc}
          poster={proxiedPoster}
          muted
          playsInline
          disablePictureInPicture
          preload={hasPoster ? "none" : "metadata"}
          onLoadedData={() => setFrameReady(true)}
          onLoadedMetadata={handleLoadedMetadata}
          onError={() => setHasError(true)}
          onTimeUpdate={handleTimeUpdate}
          className={cn(
            "pointer-events-none size-full object-cover",
            // 无 poster 时等首帧画出来再淡入，避免闪一下空底
            !hasPoster && !frameReady ? "opacity-0" : "opacity-100",
            "transition-opacity duration-300",
            className,
          )}
          {...props}
        >
          {childNodes}
        </video>
        {/* 首帧没到之前压一层骨架：不露纯白/纯黑空框（用户 §2.25 的原话就是嫌白/黑） */}
        {!hasPoster && !frameReady && !hasError && (
          <span
            className="pointer-events-none absolute inset-0"
            aria-hidden="true"
            data-slot="article-video-skeleton"
          >
            {/* 底色用 HeroUI 文档推荐的 neutral 档：默认骨架色（oklab 0.9373/70%）压在纯白
                卡片（--surface = oklch(100%)）上实测亮度 249，和纯白 253 肉眼分不出，
                用户看到的还是「白框」。neutral-200/800 明暗自适应、对比明显。 */}
            <Skeleton className="size-full rounded-none bg-zinc-300/90 dark:bg-zinc-700/90" />
          </span>
        )}
        {/* 悬停控制条（第四十二批 42-7 · HeroUI Slider）：可点击跳转 + 可拖拽快进。
            之前这层是 `pointer-events-none` 的纯展示 ProgressBar（只有进度、没有手柄），
            用户要「点/拖都能快进」。形态取草图「形态 2」：播放钮 + 常驻手柄 + 左右时间 +
            新窗口出口，整条只占画面底部 ~44px。
            duration 未知（metadata 没到）时不渲染 Slider —— 空的 range 没有可跳的刻度。 */}
        {hovering && !hasError && duration > 0 && (
          <span
            data-slot="article-video-controls"
            onClick={(event) => event.stopPropagation()}
            className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-3"
          >
            <button
              type="button"
              onClick={togglePlayback}
              aria-label={paused ? t("entry.video_play") : t("entry.video_pause")}
              className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius)] text-white/90 transition-colors duration-200 hover:bg-white/20"
            >
              {paused ? (
                <Play className="size-3.5 fill-current" />
              ) : (
                <Pause className="size-3.5 fill-current" />
              )}
            </button>

            <Slider
              className="min-w-0 flex-1"
              minValue={0}
              maxValue={duration}
              step={0.1}
              value={Math.min(position, duration)}
              onChange={(next) => {
                // HeroUI Slider 没有 onChangeStart；按下即跳、拖动持续都走 onChange，
                // 所以在这里把 scrubbing 置 true，由 onChangeEnd 解开（见 seekTo 上方注释）
                setScrubbing(true);
                seekTo(next);
              }}
              onChangeEnd={(next) => {
                setScrubbing(false);
                seekTo(next);
              }}
              aria-label={t("entry.video_scrub_label")}
              data-slot="article-video-progress"
            >
              {/* HeroUI v3 的 Slider 必须自己挂 Track/Fill/Thumb，只写 props 会渲染成空轨道 */}
              <Slider.Track className="h-1 rounded-full bg-white/30">
                <Slider.Fill className="rounded-full bg-white" />
                <Slider.Thumb className="size-2.5 rounded-full bg-white shadow-md after:hidden" />
              </Slider.Track>
            </Slider>

            <span className="shrink-0 text-[11px] leading-none tabular-nums text-white/90">
              {formatClock(position)} / {formatClock(duration)}
            </span>

            {src && (
              <a
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                title={t("entry.video_open_window")}
                onClick={handleExternalOpen}
                aria-label={t("entry.video_open_window")}
                className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius)] text-white/90 transition-colors duration-200 hover:bg-white/20"
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
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
      </div>
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
