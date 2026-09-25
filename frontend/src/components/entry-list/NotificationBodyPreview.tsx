import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import gsap from "gsap";
import { ArticleContent } from "@/components/ui/article-content";
import { useTranslationStore } from "@/stores/translation-store";
import type { Entry } from "@/types/api";

/**
 * 通知视图 · 悬停正文浮块。
 *
 * - 父级常挂（无 key、不卸载）：换条目只换 `entry`，无悬停时 `entry=null` +
 *   `visible=false` 藏起（scale 0 + 透明 + 点穿），不重播进场、不闪；
 * - 位置挂在指针下方：`y = 指针 y + 16`（`yPercent: 0`），水平居中并夹紧视口
 *   （左右各留 8px）；下方放不下（`y + 高 > innerHeight - 8`）翻到指针上方
 *   （`y = 指针 y - 16 - 高`）。指针永远在浮块外 ⇒ 跟随不中断、标题不被遮、
 *   指针可主动移进浮块滚正文 / 选文字；
 * - 跟随与动效与 `components/block/hover-img.tsx` 同参数：`gsap.quickTo`
 *   （0.4s + power3.out），进场 scale .96→1 + 透明→实（0.25s power2.out），
 *   退场 scale→0 + 透明（0.3s power2.out，退场完不卸载）；
 * - 首帧用卡片 mouseenter 自带的 `anchor` 坐标 —— 指针停着不动时也落在正确
 *   位置，不等下一次 mousemove；
 * - 开关沿用 250ms 延迟（RefreshTooltip 同款：浮块 mouseenter 取消、
 *   mouseleave 起延时，由父级控制 `visible`）；
 * - 不劫持滚轮：浮块内滚轮就是原生滚动（`overflow-y:auto`，无 preventDefault）；
 * - 正文用与卡片展开态同一套 `ArticleContent` 管道；
 * - 外观沿用项目浮层语言（圆角 / border / bg-card / 重投影），不自创新风格。
 */

/** 浮块落点：指针下方 16px，水平居中夹紧视口；下方放不下翻到指针上方 */
function placeBelowPointer(
  node: HTMLElement,
  x: number,
  y: number,
): [number, number] {
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = Math.min(
    Math.max(x, w / 2 + 8),
    Math.max(vw - w / 2 - 8, w / 2 + 8),
  );
  let top = y + 16;
  if (top + h > vh - 8) top = y - 16 - h;
  return [cx, Math.max(8, top)];
}

export function NotificationBodyPreview({
  entry,
  visible,
  anchor,
  feedName,
  autoTranslate,
  targetLanguage,
  onMouseEnter,
  onMouseLeave,
}: {
  /** null = 无悬停条目：浮块隐藏但不卸载 */
  entry: Entry | null;
  visible: boolean;
  /** 进入卡片时的指针坐标（首帧落点兜底） */
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
    entry && autoTranslate && targetLanguage
      ? state.getTranslation(entry.id, targetLanguage)
      : undefined,
  );
  const displayTitle = entry ? (translation?.title ?? entry.title) : "";

  // 最新指针位置：anchor 变化（进新卡片）与每次 mousemove 都更新；
  // 显示瞬间按它落点，指针停着不动也不等下一次 mousemove。
  const pointerRef = useRef(anchor);
  useEffect(() => {
    pointerRef.current = anchor;
  }, [anchor]);

  // 跟随：挂载一次，quickTo 与 hover-img 同参数。浮块挂在指针下方，
  // 指针平时根本不在浮块里，跟随不中断；指针移进浮块（滚正文/选文字）
  // 时冻结跟随，不把浮块顶走。
  useEffect(() => {
    const node = floatRef.current;
    if (!node) return;
    const [x0, y0] = placeBelowPointer(
      node,
      pointerRef.current.x,
      pointerRef.current.y,
    );
    gsap.set(node, {
      x: x0,
      y: y0,
      scale: 0,
      xPercent: -50,
      yPercent: 0,
      opacity: 0,
    });
    const xTo = gsap.quickTo(node, "x", {
      duration: 0.4,
      ease: "power3.out",
    });
    const yTo = gsap.quickTo(node, "y", {
      duration: 0.4,
      ease: "power3.out",
    });
    const handleMove = (event: MouseEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      if (event.target instanceof Node && node.contains(event.target)) return;
      const [x, y] = placeBelowPointer(node, event.clientX, event.clientY);
      xTo(x);
      yTo(y);
    };
    window.addEventListener("mousemove", handleMove);
    return () => window.removeEventListener("mousemove", handleMove);
    // 挂载一次：换条目只换 entry，不重建跟随
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 显隐：只播 scale/透明（hover-img 同参数），不卸载、不重定位
  useEffect(() => {
    const node = floatRef.current;
    if (!node) return;
    if (visible) {
      const [x, y] = placeBelowPointer(
        node,
        pointerRef.current.x,
        pointerRef.current.y,
      );
      gsap.set(node, { x, y });
      gsap.fromTo(
        node,
        { scale: 0.96, opacity: 0 },
        {
          scale: 1,
          opacity: 1,
          duration: 0.25,
          ease: "power2.out",
          overwrite: "auto",
        },
      );
    } else {
      gsap.to(node, {
        scale: 0,
        opacity: 0,
        duration: 0.3,
        ease: "power2.out",
        overwrite: "auto",
      });
    }
  }, [visible]);

  return (
    <div
      ref={floatRef}
      data-notification-body-preview=""
      data-preview-entry={entry?.id ?? ""}
      data-preview-visible={visible ? "true" : "false"}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={(event) => event.stopPropagation()}
      className="fixed left-0 top-0 z-50 rounded-[10px] border border-border bg-card shadow-nf"
      style={{
        width: "min(560px, 40vw)",
        maxHeight: "min(460px, 62vh)",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <div className="flex max-h-[inherit] flex-col p-3">
        <div className="shrink-0 text-[12px] font-medium text-muted-foreground">
          {feedName}
        </div>
        <div className="mt-0.5 shrink-0 text-[13.5px] font-semibold leading-5 text-foreground">
          {displayTitle || t("entry.untitled")}
        </div>
        {entry?.content?.trim() ? (
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
