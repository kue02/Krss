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
 * - 位置挂在指针**右下角**（横竖各留 20px；x 取中心 `xPercent: -50`、y 取上沿 `yPercent: 0`）：
 *   右侧放不下翻到左侧、下方放不下翻到上方，最后整体夹进视口。指针永远在浮块外
 *   ⇒ 跟随不中断、所悬停条目的标题不被遮、指针可斜着移进浮块滚正文 / 选文字；
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

/**
 * 浮块落点：挂指针**右下角**（指针恒在面板外 ⇒ 跟随不中断，可斜着移进去滚正文/选文字）。
 *
 * 竖直方向加一条硬约束：**不许盖住所悬停的这张卡片**（含它的标题）——
 * 起点取 `max(指针 y + GAP, 卡片下沿 + 12)`。真机实测过：只按指针算时，
 * 指针停在卡片上半部（来源行/标题上）会让面板从标题中间压下去，标题就看不见了。
 *
 *  - 右侧放不下（x + GAP + w > vw - 8）翻到指针左侧（x = 指针 x - GAP - w）；
 *  - 下方放不下（且卡片上方能放下）翻到卡片上方（y = 卡片上沿 - 12 - h），
 *    上方也放不下就贴视口底；
 *  - 最后整体夹进视口；极端窗口下若仍让指针落进面板，跟随里的 contains 冻结兜底。
 *  返回 `[水平中心, 上沿]`：x 用中心（`xPercent: -50`），y 用**上沿**（`yPercent: 0`）。
 *  顶部锚定而不是中心锚定，是因为换条目后正文高度会变 —— 中心锚定会让面板向上长，
 *  真机实测直接盖住所悬停的卡片。
 *
 *  为什么不挂指针正下方（试过，真机实测有问题）：面板会占住指针正下方的空间，
 *  鼠标往下换下一条卡片时一头扎进面板里 ⇒ 卡片 hover 丢失、内容不换、跟随冻结。
 */
/**
 * 落点模式：
 *  - `card-safe`（默认，通知视图）：挂指针右下 20px、竖直到卡片下沿之下 —— 不遮标题；
 *  - `pointer`（32-2，文章视图）：以指针为中心（图片视图那个浮块的样子）。
 */
export type AnchorMode = "card-safe" | "pointer";

function placeBesidePointer(
  node: HTMLElement,
  x: number,
  y: number,
  cardTop: number | null,
  cardBottom: number | null,
  mode: AnchorMode,
): [number, number] {
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const GAP = 20;
  if (mode === "pointer") {
    /* 32-2：照图片视图那个浮块（hover-img 原件）——**以指针为中心**，
     * 指针正好落在面板中间，`xPercent/yPercent: -50` 配合；只夹进视口，
     * 不再让位于卡片下沿（用户明确要「鼠标还在中间，效果跟图片视图一样」）。 */
    return [
      Math.min(Math.max(x, 8 + w / 2), Math.max(vw - w / 2 - 8, 8 + w / 2)),
      Math.min(Math.max(y, 8 + h / 2), Math.max(vh - h / 2 - 8, 8 + h / 2)),
    ];
  }
  let left = x + GAP;
  if (left + w > vw - 8) left = x - GAP - w;
  // 竖直：指针下方，但至少落到卡片下沿之下 —— 标题永远不被遮
  let top =
    cardBottom !== null ? Math.max(y + GAP, cardBottom + 12) : y + GAP;
  if (top + h > vh - 8) {
    const above = cardTop !== null ? cardTop - 12 - h : Number.NEGATIVE_INFINITY;
    top = above >= 8 ? above : vh - h - 8;
  }
  left = Math.min(Math.max(left, 8), Math.max(vw - w - 8, 8));
  top = Math.min(Math.max(top, 8), Math.max(vh - h - 8, 8));
  return [left + w / 2, top];
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
  anchorMode = "card-safe",
  interactive = true,
}: {
  /** null = 无悬停条目：浮块隐藏但不卸载 */
  entry: Entry | null;
  visible: boolean;
  /** 进入卡片时的指针坐标 + 该卡片的上下沿（首帧落点兜底；卡片沿用于「不许盖住标题」） */
  anchor: { x: number; y: number; cardTop: number | null; cardBottom: number | null };
  feedName: string;
  autoTranslate: boolean;
  targetLanguage: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** 32-2：落点模式（默认通知视图那套「不遮卡片」） */
  anchorMode?: AnchorMode;
  /**
   * 33-1：浮块吃不吃指针。
   *  - `true`（默认，通知档）：`pointer-events: auto` —— 可以移进浮块滚正文/选文字；
   *  - `false`（文章档）：**纯预览、彻底不吃指针** —— 指针永远落在下面的卡片上，
   *    所以「一行一行扫过去」每次都能换内容，也不会因为浮块盖住而冻结/抢滚轮焦点；
   *    要读全文/滚动/选中，点卡片进阅读区（那里有滚动条）。
   */
  interactive?: boolean;
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
    const [x0, y0] = placeBesidePointer(
      node,
      pointerRef.current.x,
      pointerRef.current.y,
      pointerRef.current.cardTop,
      pointerRef.current.cardBottom,
      anchorMode,
    );
    gsap.set(node, {
      x: x0,
      y: y0,
      scale: 0,
      xPercent: -50,
      /* pointer 模式两个方向都居中（指针在面板正中）；card-safe 只水平居中、顶部锚定 */
      yPercent: anchorMode === "pointer" ? -50 : 0,
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
      const target = event.target instanceof Element ? event.target : null;
      // 顺带把「所悬停卡片」的上下沿带上：指针停在卡片上半部时，
      // 落点要退到卡片下沿之下，别把标题压掉。
      const card = target?.closest?.("[data-timeline-card]");
      const cardRect = card?.getBoundingClientRect();
      pointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        cardTop: cardRect ? cardRect.top : pointerRef.current.cardTop,
        cardBottom: cardRect ? cardRect.bottom : pointerRef.current.cardBottom,
      };
      if (node.contains(event.target as Node)) return;
      const [x, y] = placeBesidePointer(
        node,
        event.clientX,
        event.clientY,
        pointerRef.current.cardTop,
        pointerRef.current.cardBottom,
        anchorMode,
      );
      xTo(x);
      yTo(y);
    };
    window.addEventListener("mousemove", handleMove);
    /* 面板高度会随内容/图片陆续渲染而变化：变了就按当前指针重算落点（顶部锚定，
     * 只向下长），否则内容变高会向上撑、盖住所悬停的卡片。 */
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            // 指针已经移进面板（冻结态）时不动，免得把人正在看的面板拽走
            if (node.matches(":hover")) return;
            const [x, y] = placeBesidePointer(
              node,
              pointerRef.current.x,
              pointerRef.current.y,
              pointerRef.current.cardTop,
              pointerRef.current.cardBottom,
              anchorMode,
            );
            gsap.set(node, { x, y });
          })
        : null;
    observer?.observe(node);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      observer?.disconnect();
    };
    // 挂载一次：换条目只换 entry，不重建跟随
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 显隐：只播 scale/透明（hover-img 同参数），不卸载、不重定位
  useEffect(() => {
    const node = floatRef.current;
    if (!node) return;
    if (visible) {
      const [x, y] = placeBesidePointer(
        node,
        pointerRef.current.x,
        pointerRef.current.y,
        pointerRef.current.cardTop,
        pointerRef.current.cardBottom,
        anchorMode,
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
    // 换条目（visible 不变）时也要按新内容重算落点：内容高度不同
  }, [visible, entry?.id, anchorMode]);

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
        pointerEvents: visible && interactive ? "auto" : "none",
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
      {!interactive && (
        /* 33-1：不吃指针 ⇒ 正文到底部会「截断」，给渐隐 + 一行说明，告诉用户点卡片去读 */
        <div className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-[10px] bg-gradient-to-t from-card via-card/95 to-transparent px-3 pb-2 pt-6 text-center text-[11.5px] text-muted-foreground">
          {t("entry.preview_click_hint")}
        </div>
      )}
    </div>
  );
}
