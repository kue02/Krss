import "@videojs/react/video/skin.css";
import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import { I18nProvider } from "@videojs/react/i18n";
import type { CSSProperties } from "react";

/**
 * 正文视频播放器（Video.js 10 for React，与 NextFlux 同一套）。
 *
 * 这一层专门隔离 `@videojs/react` 的重依赖：`article-video.tsx` 用 `React.lazy`
 * 懒加载本模块，没有视频的文章不会把播放器打进首屏 chunk。
 *
 * 皮肤参数照抄 NextFlux 的 `VideoJsPlayer.jsx`：全宽、16 / 9、强调色走主题
 * `--accent`、圆角走 `--radius-lg`。`--media-*` 是 Video.js 皮肤自己的变量，
 * 见 `@videojs/react/video/skin.css`（`--media-video-border-radius` 默认 28px）。
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

export function ArticleVideoPlayer({
  src,
  poster,
  locale,
}: ArticleVideoPlayerProps) {
  return (
    <I18nProvider locale={locale}>
      <VideoPlayer>
        <VideoSkin className="article-video-skin" style={skinStyle}>
          <Video
            src={src}
            poster={poster}
            playsInline
            preload="metadata"
            // 与 NextFlux 一致：不显示原生控件，用皮肤自带控制条
          />
        </VideoSkin>
      </VideoPlayer>
    </I18nProvider>
  );
}
