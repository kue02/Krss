import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import gsap from "gsap";
import { ArticleContent } from "@/components/ui/article-content";
import { useTranslationStore } from "@/stores/translation-store";
import type { Entry } from "@/types/api";

/**
 * 通知视图 · 悬停正文浮块（29-1）。
 *
 * - 定位：进场用**鼠标进入卡片那一刻的坐标**（`anchor`）直接落到视口内并夹紧，
 *   不依赖后续 mousemove —— 否则指针停在卡片上不动时浮块会待在 (0,0) 左上角外；
 * - 跟随：`position: fixed` + `xPercent/yPercent: -50` + `gsap.quickTo`（照
 *   `components/block/hover-img.tsx`）；**指针一旦进入浮块就停止跟随**，
 *   否则浮块被指针顶着走，人移不进去（滚动/选中/点链接全废）；
 * - 鼠标可移进：`pointer-events: auto`，开关由上层用 250ms 延迟控制
 *  （照 `components/entry-list/RefreshTooltip.tsx` 同款：进入清 timer，离开起 timer）；
 * - 浮块卸载 = 直接从 DOM 撤掉，不留透明层；
 * - 正文用与卡片展开态同一套 `ArticleContent` 管道；
 * - 外观沿用项目浮层语言（圆角 / border / bg-card / 重投影），不自创新风格。
 */
/** 把浮块钉在视口内：半个浮块 + 8px 边距，指针贴边时也不会露出视口 */
function clampToViewport(node: HTMLElement, x: number, y: number): [number, number] {
  const halfW = node.offsetWidth / 2;
  const halfH = node.offsetHeight / 2;
  const maxX = window.innerWidth - halfW - 8;
  const maxY = window.innerHeight - halfH - 8;
  return [
    Math.min(Math.max(x, halfW + 8), Math.max(maxX, halfW + 8)),
    Math.min(Math.max(y, halfH + 8), Math.max(maxY, halfH + 8)),
  ];
}

export function NotificationBodyPreview({
  entry,
  anchor,
  feedName,
  autoTranslate,
  targetLanguage,
  onMouseEnter,
  onMouseLeave,
}: {
  entry: Entry;
  /** 进入卡片时的指针坐标（浮块的初始落点） */
  anchor: { x: number; y: number };
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
    // 先落到进入卡片那一刻的指针位置（夹紧在视口内），再 scaled 进场
    const [x0, y0] = clampToViewport(node, anchor.x, anchor.y);
    gsap.set(node, { x: x0, y: y0, scale: 0.96, xPercent: -50, yPercent: -50, opacity: 0 });
    const xTo = gsap.quickTo(node, "x", { duration: 0.4, ease: "power3.out" });
    const yTo = gsap.quickTo(node, "y", { duration: 0.4, ease: "power3.out" });
    const handleMove = (event: MouseEvent) => {
      // 指针已经进了浮块就不再跟随 —— 否则浮块永远被指针「顶着」走，
      // 人根本移不进去（滚轮也许还能滚，但拖选文字、点链接、拖滚动条全废）。
      if (event.target instanceof Node && node.contains(event.target)) return;
      const [x, y] = clampToViewport(node, event.clientX, event.clientY);
      xTo(x);
      yTo(y);
    };
    window.addEventListener("mousemove", handleMove);
    gsap.to(node, { scale: 1, opacity: 1, duration: 0.25, ease: "power2.out" });
    return () => window.removeEventListener("mousemove", handleMove);
    // anchor 只在挂载那一刻取用（换条目走 key 重新挂载）
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
