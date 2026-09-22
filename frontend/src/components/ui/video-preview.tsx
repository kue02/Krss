import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVideoPreviewStore } from "@/stores/video-preview-store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * 大屏视频播放器（点卡片/详情里的视频打开）。
 *
 * 用原生 controls：拖动进度条依赖后端代理对 Range 回 206
 * （上游 video.twimg.com 无视 Range，是我们在代理层切片的），否则一拖就弹回。
 * 关闭时暂停并把时间归零，避免后台继续播放。
 */
export function VideoPreview() {
  const { t } = useTranslation();
  const { isOpen, src, poster, close } = useVideoPreviewStore();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (isOpen) return;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        aria-describedby={undefined}
        className={cn(
          "flex w-auto max-w-[92vw] flex-col gap-0 overflow-hidden p-0",
          "rounded-[19.2px] border border-border bg-overlay/90 backdrop-blur-lg shadow-2xl",
        )}
      >
        <DialogTitle className="sr-only">{t("entry.video_preview")}</DialogTitle>
        {src && (
          <video
            key={src}
            ref={videoRef}
            src={src}
            poster={poster ?? undefined}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="max-h-[80vh] max-w-[90vw] rounded-[19.2px] bg-black"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
