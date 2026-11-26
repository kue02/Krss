import "@videojs/react/video/skin.css";
import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import { I18nProvider } from "@videojs/react/i18n";
import { useCallback, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useInViewNow } from "@/hooks/useInViewNow";

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
 * 悬停预览（2026-11 回归修复）：
 * - 鼠标悬停 → 静音就地播放；移开 → 回到预览前的位置（起始在封面就回封面，
 *   起始在中途就还原到那个时刻），只有「用户接管后正在有声播放」才保留。
 * - 预载分级：离屏 `none`、进视口 `metadata`、悬停才 `auto`。鼠标不动、不悬停时
 *   不会有任何视频持续下载——`preload` 语义靠可回退的 `useInViewNow`，不是
 *   「滚过一次就永远 auto」。
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

/** 离视口多远算「进入视口」开始预载 metadata。视频远大于图片，只给一小圈。 */
const PRELOAD_ROOT_MARGIN = "200px";

/**
 * 视为「还在封面」的容差。预览开始时 `currentTime` 在这以内，就算是从封面起的；
 * 移开时归零让皮肤 Poster 重新出现。超过它说明用户之前看到一半，移开时还原位置。
 */
const COVER_EPSILON = 0.25;

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

/** 一次悬停预览的会话状态。`null` = 没在预览。 */
interface PreviewSession {
  /** 进入预览前的播放位置，用来在移开时还原（封面 → 0；中途 → 原位置） */
  startTime: number;
  /** 进入预览前的静音状态，移开时还原 */
  wasMuted: boolean;
  /** 用户在预览期间是否主动改变了播放状态 / 位置（暂停、拖动进度等） */
  userTookOver: boolean;
  /** 取消起播重试并摘掉事件监听 */
  stop: () => void;
}

/**
 * 静音起播，返回取消函数。
 *
 * `play()` 的 rejection 必须当场吞掉：自动播放策略、还没缓冲够都会拒，
 * 拒了就在 `canplay` 时补一次，仍失败就静默放弃（不留 unhandled rejection、不卡 UI）。
 *
 * 同时挂 `pause` / `seeking` / `seeked` 监听：这些事件只会在**用户主动暂停或
 * 拖动进度**时出现（我们自己起播只会有 `play`/`playing`，`play` 故意不监听，
 * 免得把自己起播误判成「用户接管」）。命中即标记 `userTookOver`。
 */
function startMutedPreview(
  video: HTMLVideoElement,
  session: PreviewSession,
): () => void {
  let cancelled = false;

  const markUserAction = () => {
    session.userTookOver = true;
  };
  video.addEventListener("pause", markUserAction);
  video.addEventListener("seeking", markUserAction);
  video.addEventListener("seeked", markUserAction);

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
    video.removeEventListener("pause", markUserAction);
    video.removeEventListener("seeking", markUserAction);
    video.removeEventListener("seeked", markUserAction);
  };
}

export function ArticleVideoPlayer({
  src,
  poster,
  locale,
}: ArticleVideoPlayerProps) {
  const { ref: containerRef, inView } = useInViewNow<HTMLDivElement>(
    PRELOAD_ROOT_MARGIN,
  );
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<PreviewSession | null>(null);
  const [hovering, setHovering] = useState(false);

  // 预载分级：悬停 auto → 进视口 metadata → 离屏 none。鼠标不动就不会下载。
  const preload = hovering ? "auto" : inView ? "metadata" : "none";

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isHoverPointer(event.pointerType)) return;
      if (sessionRef.current) return;
      if (!canHoverPreview()) return;

      const video = videoRef.current;
      // 正在播放（可能是有声的、用户自己在看）时不插手。
      // 暂停状态即使看到中途（currentTime > 0）也允许预览——不再把「看过一段」
      // 当成永久不能预览的理由。
      if (!video || !video.paused) return;

      const session: PreviewSession = {
        startTime: video.currentTime,
        wasMuted: video.muted,
        userTookOver: false,
        stop: () => {},
      };
      // 先静音再 play：不静音的自动播放会被浏览器策略直接拒掉
      video.muted = true;
      setHovering(true);
      session.stop = startMutedPreview(video, session);
      sessionRef.current = session;
    },
    [],
  );

  const handlePointerLeave = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    // 先摘监听再动 video：否则下面自己的 pause()/写 currentTime 会被记成用户操作
    session.stop();
    setHovering(false);

    const video = videoRef.current;
    if (!video) return;

    // 唯一保留播放的情况：用户接管后正在有声播放（真的在看）。
    // 只点了一下静音键导致 muted=false 仍在播不算接管——那种也回封面。
    if (session.userTookOver && !video.paused && !video.muted) return;

    // 其余一律回到「预览前的位置」：起始在封面 → 归零让皮肤 Poster 重新出现；
    // 起始在中途（用户之前看到一半）→ 还原到那一刻，不丢进度。
    // 先写 currentTime 再 pause 是有意的：暂停事件会重新同步 playback.started，
    // 此刻 currentTime 已归位，started 才能正确变回 false（封面才回来）。
    // 不走 store.seek()：它先 await loadedmetadata，元数据没到会挂住。
    const backToCover = session.startTime <= COVER_EPSILON;
    try {
      video.currentTime = backToCover ? 0 : session.startTime;
    } catch {
      // 极短的悬停里元数据可能还没到：写不进去就算了，下面的 pause 仍会同步状态
    }
    video.pause();
    video.muted = session.wasMuted;
  }, []);

  return (
    <div
      ref={containerRef}
      data-slot="article-video-player"
      className="w-full"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
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
              preload={preload}
              // 与 NextFlux 一致：不显示原生控件，用皮肤自带控制条
            />
          </VideoSkin>
        </VideoPlayer>
      </I18nProvider>
    </div>
  );
}
