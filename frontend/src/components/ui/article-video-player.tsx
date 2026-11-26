import "@videojs/react/video/skin.css";
import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import { I18nProvider } from "@videojs/react/i18n";
import { useCallback, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useInView } from "@/hooks/useInView";

/**
 * 正文视频播放器（Video.js 10 for React，与 NextFlux 同一套）。
 *
 * 这一层专门隔离 `@videojs/react` 的重依赖：`article-video.tsx` 用 `React.lazy`
 * 懒加载本模块，没有视频的文章不会把播放器打进首屏 chunk。
 *
 * 皮肤参数照抄 NextFlux 的 `VideoJsPlayer.jsx`：全宽、16 / 9、强调色走主题
 * `--accent`、圆角走 `--radius-lg`。`--media-*` 是 Video.js 皮肤自己的变量，
 * 见 `@videojs/react/video/skin.css`（`--media-video-border-radius` 默认 28px）。
 *
 * 另外两件事（2026-11 回归修复）：
 * - 悬停静音就地预览、移开暂停回封面（原生 `<video>` 时代的行为）；
 * - 进入视口把 `preload` 从 `metadata` 升到 `auto`，让浏览器自己把视频缓冲起来
 *   （不另发 fetch 预热，避免双倍流量）。
 */
export interface ArticleVideoPlayerProps {
  /** 已经过代理（App 构建下还是带鉴权的 blob URL）的可播放地址 */
  src: string;
  /** 已经过代理（/ 鉴权 blob）的封面地址 */
  poster?: string;
  /** 语言包：'zh-CN' | 'en'，交给播放器翻译控件 aria-label / tooltip */
  locale: string;
}

const skinStyle = {
  width: "100%",
  aspectRatio: "16 / 9",
  "--media-accent-color": "var(--accent)",
  "--media-accent-text-color": "var(--accent-foreground)",
  "--media-border-radius": "var(--radius-lg)",
} as CSSProperties;

/**
 * 离视口多远开始预缓冲。图片常用 200~600px，这里取偏小的 200px：
 * 视频体积远大于图片，提前一屏以上预取会在长文里同时拉动好几个视频。
 */
const PRELOAD_ROOT_MARGIN = "200px";

/** `matchMedia` 在 jsdom / 极老浏览器里不存在，统一走 fallback，避免测试与老环境直接崩。 */
function mediaMatches(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const matchMedia = window.matchMedia;
  if (typeof matchMedia !== "function") return fallback;
  return matchMedia.call(window, query).matches;
}

/** 只有真正带指针悬停的设备才做悬停预览（触摸屏 `pointerType === "touch"` 直接排除）。 */
function canHoverPreview(): boolean {
  return (
    mediaMatches("(hover: hover) and (pointer: fine)", true) &&
    !mediaMatches("(prefers-reduced-motion: reduce)", false)
  );
}

function isHoverPointer(pointerType: string): boolean {
  // 空字符串来自合成事件 / 老浏览器，按鼠标处理
  return pointerType === "" || pointerType === "mouse";
}

/**
 * 静音起播，返回取消函数。
 *
 * `play()` 的 rejection 必须当场吞掉：自动播放策略、还没缓冲够都会拒，
 * 拒了就在 `canplay` 时补一次，仍失败就静默放弃（不留 unhandled rejection、不卡 UI）。
 */
function startMutedPreview(video: HTMLVideoElement): () => void {
  let cancelled = false;

  const retry = () => {
    if (cancelled) return;
    const result = video.play();
    if (result && typeof result.catch === "function") result.catch(() => {});
  };

  const play = () => {
    if (cancelled) return;
    const result = video.play();
    if (result && typeof result.catch === "function") {
      result.catch(() => {
        // 已经有足够数据还失败，说明是被策略拒了，补播也没用
        if (cancelled || video.readyState >= 3) return;
        video.addEventListener("canplay", retry, { once: true });
      });
    }
  };

  play();

  return () => {
    cancelled = true;
    video.removeEventListener("canplay", retry);
  };
}

export function ArticleVideoPlayer({
  src,
  poster,
  locale,
}: ArticleVideoPlayerProps) {
  const { ref: containerRef, inView } = useInView<HTMLDivElement>(
    PRELOAD_ROOT_MARGIN,
  );
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** 正在悬停预览时记下用户原本的状态；`null` = 没在预览。 */
  const previewRef = useRef<{
    muted: boolean;
    userTookOver: boolean;
    stop: () => void;
  } | null>(null);

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isHoverPointer(event.pointerType)) return;
      if (previewRef.current) return;
      if (!canHoverPreview()) return;

      const video = videoRef.current;
      // 已经在播（可能是有声的），或用户已经看过一段（currentTime > 0）：
      // 用户在用播放器，悬停不要插手、更不要强行静音。
      if (!video || !video.paused || video.currentTime > 0) return;

      const muted = video.muted;
      // 先静音再 play：不静音的自动播放会被浏览器策略直接拒掉
      video.muted = true;
      previewRef.current = {
        muted,
        userTookOver: false,
        stop: startMutedPreview(video),
      };
    },
    [],
  );

  const handlePointerLeave = useCallback(() => {
    const preview = previewRef.current;
    if (!preview) return;
    previewRef.current = null;
    preview.stop();

    const video = videoRef.current;
    if (!video) return;
    // 用户在预览期间点过播放 / 暂停 / 进度：交还控制权，不暂停、不回封面。
    // 但静音是我们自己改的，得还回去；`video.muted` 已经不是 true 说明用户自己动过静音键，
    // 那就尊重他的选择，不再覆盖。
    if (preview.userTookOver) {
      if (video.muted) video.muted = preview.muted;
      return;
    }

    // 回封面：皮肤 Poster 的可见性由 playback.started（`!paused || currentTime > 0`）派生，
    // 只有「暂停 + currentTime 归零」它才会重新出现。
    // 先归零再暂停是有意的：暂停事件会重新同步 started，此刻 currentTime 已是 0，
    // 于是 started 一定是 false；反过来先暂停再归零的话，元数据还没到的视频
    // （currentTime 写不进去、也就没有 seeked 事件）会让 started 停在 true、封面再也不回来。
    // 另外这里直接写 currentTime，不走 store 的 seek()——seek() 会先 await loadedmetadata，
    // 元数据没到就会挂住。
    try {
      video.currentTime = 0;
    } catch {
      // 极短的悬停里元数据可能还没到：写不进去就算了，下面的 pause 仍会同步状态
    }
    video.pause();
    video.muted = preview.muted;
  }, []);

  const handleUserTakeOver = useCallback(() => {
    if (previewRef.current) previewRef.current.userTookOver = true;
  }, []);

  return (
    <div
      ref={containerRef}
      data-slot="article-video-player"
      className="w-full"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handleUserTakeOver}
      onKeyDown={handleUserTakeOver}
    >
      <I18nProvider locale={locale}>
        {/* poster 同时给 Player（皮肤的 Poster 用）和 Video（原生海报兜底）：
            Video.js 的 metadata feature 只从 player config 取海报，`<Video poster>`
            只影响原生 `<video>`，皮肤 Poster 拿不到。 */}
        <VideoPlayer poster={poster}>
          <VideoSkin className="article-video-skin" style={skinStyle}>
            <Video
              ref={videoRef}
              src={src}
              poster={poster}
              playsInline
              preload={inView ? "auto" : "metadata"}
              // 与 NextFlux 一致：不显示原生控件，用皮肤自带控制条
            />
          </VideoSkin>
        </VideoPlayer>
      </I18nProvider>
    </div>
  );
}
