import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import gsap from "gsap";
import { ArticleContent } from "@/components/ui/article-content";
import { useTranslationStore } from "@/stores/translation-store";
import type { Entry } from "@/types/api";

/**
 * 通知视图 · 悬停正文浮块（29-1）。
 *
 * - 跟随指针：照 `components/block/hover-img.tsx` 那套（`position: fixed` +
 *   `xPercent/yPercent: -50` + `gsap.quickTo` + 进场 scale）；
 * - 鼠标可移进：`pointer-events: auto`，开关由上层用 250ms 延迟控制
 *  （照 `components/entry-list/RefreshTooltip.tsx` 同款：进入清 timer，离开起 timer）；
 * - 浮块卸载 = 直接从 DOM 撤掉，不留透明层；
 * - 正文用与卡片展开态同一套 `ArticleContent` 管道；
 * - 外观沿用项目浮层语言（圆角 / border / bg-card / 重投影），不自创新风格。
 */
export function NotificationBodyPreview({
  entry,
  feedName,
  autoTranslate,
  targetLanguage,
  onMouseEnter,
  onMouseLeave,
}: {
  entry: Entry;
  feedName: string;
  autoTranslate: boolean;
  targetLanguage: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const { t } = useTranslation();
  const floatRef = useRef<HTMLDivElement | null>(null);
  const translation = useTranslationStore((state) =>
    autoTranslate && targetLanguage
      ? state.getTranslation(entry.id, targetLanguage)
      : undefined,
  );
  const displayTitle = translation?.title ?? entry.title;

  useEffect(() => {
    const node = floatRef.current;
    if (!node) return;
    gsap.set(node, { scale: 0.96, xPercent: -50, yPercent: -50, opacity: 0 });
    const xTo = gsap.quickTo(node, "x", { duration: 0.4, ease: "power3.out" });
    const yTo = gsap.quickTo(node, "y", { duration: 0.4, ease: "power3.out" });
    // 首帧先落到当前指针位置，免得从 (0,0) 飞过来
    if (typeof window !== "undefined" && "_lastHoverXY" in window) {
      const xy = (window as unknown as { _lastHoverXY?: [number, number] })._lastHoverXY;
      if (xy) {
        xTo(xy[0]);
        yTo(xy[1]);
      }
    }
    const handleMove = (event: MouseEvent) => {
      // 指针已经进了浮块就不再跟随 —— 否则浮块永远被指针「顶着」走，
      // 人根本移不进去（滚轮也许还能滚，但拖选文字、点链接、拖滚动条全废）。
      if (event.target instanceof Node && node.contains(event.target)) return;
      (window as unknown as { _lastHoverXY?: [number, number] })._lastHoverXY = [
        event.clientX,
        event.clientY,
      ];
      xTo(event.clientX);
      yTo(event.clientY);
    };
    window.addEventListener("mousemove", handleMove);
    gsap.to(node, { scale: 1, opacity: 1, duration: 0.25, ease: "power2.out" });
    return () => window.removeEventListener("mousemove", handleMove);
  }, []);

  return (
    <div
      ref={floatRef}
      data-notification-body-preview=""
      data-preview-entry={entry.id}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(event) => event.stopPropagation()}
      className="fixed left-0 top-0 z-50 rounded-[10px] border border-border bg-card shadow-nf"
      style={{ width: "min(560px, 40vw)", maxHeight: "min(460px, 62vh)" }}
    >
      <div className="flex max-h-[inherit] flex-col p-3">
        <div className="shrink-0 text-[12px] font-medium text-muted-foreground">
          {feedName}
        </div>
        <div className="mt-0.5 shrink-0 text-[13.5px] font-semibold leading-5 text-foreground">
          {displayTitle || t("entry.untitled")}
        </div>
        {entry.content?.trim() ? (
          <div
            data-preview-body=""
            className="entry-content reading-prose prose prose-sm dark:prose-invert mt-2 min-h-0 max-w-none flex-1 overflow-y-auto break-words"
          >
            <ArticleContent content={entry.content} articleUrl={entry.url} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
