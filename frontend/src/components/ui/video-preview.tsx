import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Maximize, Minimize, X } from "lucide-react";
import { useVideoPreviewStore } from "@/stores/video-preview-store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useAuthedImageUrl } from "@/lib/use-authed-image";

/**
 * 大屏视频播放器（点卡片/详情里的视频打开）。
 *
 * 用原生 controls：拖动进度条依赖后端代理对 Range 回 206
 * （上游 video.twimg.com 无视 Range，是我们在代理层切片的），否则一拖就弹回。
 * 关闭时暂停并把时间归零，避免后台继续播放。
 * 移动端尽量铺满可用视口（扣掉安全区），桌面端保持有界不撑爆。
 */
export function VideoPreview() {
  const { t } = useTranslation();
  const { isOpen, src, poster, close } = useVideoPreviewStore();
  const authedSrc = useAuthedImageUrl(src ?? undefined);
  const authedPoster = useAuthedImageUrl(poster ?? undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  // 全屏请求打在包裹 video 与自定义按钮的容器上，这样全屏后自建按钮仍在全屏子树内、可点。
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 是否支持对容器请求全屏（iOS 等不支持时隐藏按钮，避免「点了没反应」）
  const [canFullscreen, setCanFullscreen] = useState(false);

  useEffect(() => {
    setCanFullscreen(
      typeof document !== "undefined" &&
        Boolean(document.fullscreenEnabled) &&
        typeof document.createElement("div").requestFullscreen === "function",
    );
  }, []);

  useEffect(() => {
    if (isOpen) return;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
  }, [isOpen]);

  // 跟随浏览器全屏状态（用户也可能用原生 controls / Esc 退出）
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen?.();
      } else if (container?.requestFullscreen) {
        // 对包裹容器（含关闭/全屏按钮）全屏，按钮在全屏内仍可见可点
        await container.requestFullscreen();
      }
    } catch {
      // 某些环境不支持容器全屏：静默忽略，用户仍可用原生 controls
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        aria-describedby={undefined}
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          "w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)]",
          "sm:w-auto sm:max-w-[92vw]",
          "rounded-[19.2px] border border-border bg-overlay/90 backdrop-blur-lg shadow-2xl",
        )}
      >
        <DialogTitle className="sr-only">{t("entry.video_preview")}</DialogTitle>
        {authedSrc && (
          <div
            ref={containerRef}
            className="relative flex items-center justify-center bg-black"
          >
            <video
              key={authedSrc}
              ref={videoRef}
              src={authedSrc}
              poster={authedPoster ?? undefined}
              controls
              autoPlay
              playsInline
              preload="metadata"
              className={cn(
                "block w-full rounded-[19.2px] bg-black object-contain",
                // 手机：接近整屏（高度去掉上下安全区与一点边距）
                "max-h-[calc(100dvh-2rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))]",
                // 桌面：有界
                "sm:w-auto sm:max-h-[80vh] sm:max-w-[90vw]",
              )}
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                close();
              }}
              aria-label={t("entry.video_close")}
              title={t("entry.video_close")}
              className="absolute left-3 top-3 z-10 flex size-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70 active:scale-95"
            >
              <X className="size-5" />
            </button>
            {canFullscreen && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleFullscreen();
                }}
                aria-label={
                  isFullscreen
                    ? t("entry.video_exit_fullscreen")
                    : t("entry.video_fullscreen")
                }
                title={
                  isFullscreen
                    ? t("entry.video_exit_fullscreen")
                    : t("entry.video_fullscreen")
                }
                className="absolute right-3 top-3 z-10 flex size-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70 active:scale-95"
              >
                {isFullscreen ? (
                  <Minimize className="size-5" />
                ) : (
                  <Maximize className="size-5" />
                )}
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
