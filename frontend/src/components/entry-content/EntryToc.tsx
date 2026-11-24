import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ListTree, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TocItem {
  id: string;
  text: string;
  level: number;
}

interface EntryTocProps {
  /** 正文的滚动容器；目录从它里面找标题 */
  scrollNode?: HTMLDivElement | null;
  /** 换条目时重算 */
  entryId?: string | null;
  /** 移动端：右缘 44px 热区入口 + 全高目录抽屉（桌面保持 hover 面板） */
  isMobile?: boolean;
  /** 内联合列：目录锚定屏幕右侧而不是文章中心 */
  fixedInline?: boolean;
}

/** 标题离顶部留出的距离（正文顶部有留白，跳过去别贴边） */
const SCROLL_MARGIN_TOP = 72;

/**
 * 正文右侧的悬浮目录（标题 + 小标题）。
 * 平时完全隐藏，鼠标移到面板右缘的一条窄带上才出现；点标题跳到该段。
 */
export function EntryToc({
  scrollNode,
  entryId,
  isMobile = false,
  fixedInline = false,
}: EntryTocProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  // 移动端抽屉打开时锁背景滚动，和 MobileActionSheet 同一口径。
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      root.style.overflow = previousOverflow;
    };
  }, [isMobile, mobileOpen]);
  const signatureRef = useRef("");
  // id → 标题元素：跳转/高亮直接查这张表，避免用 CSS.escape（jsdom 里没有这个 API）
  const elementsRef = useRef<Map<string, HTMLElement>>(new Map());

  // 收集正文里的标题（正文是异步渲染的：翻译/Readability 切换都会换一批节点）
  useEffect(() => {
    if (!scrollNode) {
      signatureRef.current = "";
      setItems([]);
      return;
    }

    let frame = 0;
    const collect = () => {
      const scope = scrollNode.querySelector<HTMLElement>(".entry-content");
      if (!scope) {
        if (signatureRef.current !== "") {
          signatureRef.current = "";
          setItems([]);
        }
        return;
      }

      // 只取「标题（文章 h1）+ 正文里的小标题」，界面自带的块（AI 摘要等）不算
      const headerTitle = scope.querySelector<HTMLElement>("header h1");
      const contentHeadings = Array.from(
        scope.querySelectorAll<HTMLElement>(".prose h1, .prose h2, .prose h3, .prose h4"),
      );
      const headings = [headerTitle, ...contentHeadings].filter(
        (el): el is HTMLElement => !!el && (el.textContent ?? "").trim().length > 0,
      );

      const seen = new Set<Element>();
      const next: TocItem[] = [];
      const elements = new Map<string, HTMLElement>();
      for (const el of headings) {
        if (seen.has(el)) continue;
        seen.add(el);

        const id = el.id || `entry-toc-${next.length}`;
        if (!el.id) el.id = id;
        if (!el.style.scrollMarginTop) {
          el.style.scrollMarginTop = `${SCROLL_MARGIN_TOP}px`;
        }
        elements.set(id, el);
        next.push({
          id,
          text: (el.textContent ?? "").trim(),
          level: Number(el.tagName.slice(1)) || 2,
        });
      }
      elementsRef.current = elements;

      const signature = next.map((item) => `${item.id}:${item.text}`).join("|");
      if (signature === signatureRef.current) return;
      signatureRef.current = signature;
      setItems(next);
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        collect();
      });
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(scrollNode, { childList: true, subtree: true });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [entryId, scrollNode]);

  // 当前读到哪一节（取最后一个已滚过顶部的标题）
  useEffect(() => {
    if (!scrollNode || items.length === 0) {
      setActiveId(null);
      return;
    }

    const handleScroll = () => {
      const viewportTop = scrollNode.getBoundingClientRect().top;
      // 容差：跳转后目标标题正好停在 SCROLL_MARGIN_TOP 处，严格相等会差一两像素
      const threshold = SCROLL_MARGIN_TOP + 12;
      let current: string | null = null;
      for (const item of items) {
        const el = elementsRef.current.get(item.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - viewportTop <= threshold) {
          current = item.id;
        } else {
          break;
        }
      }
      setActiveId(current ?? items[0]?.id ?? null);
    };

    handleScroll();
    scrollNode.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollNode.removeEventListener("scroll", handleScroll);
  }, [items, scrollNode]);

  const handleJump = useCallback(
    (id: string) => {
      if (!scrollNode) return;
      const el = elementsRef.current.get(id);
      if (!el) return;

      // 直接在滚动容器上算目标位置：容器是嵌套的，scrollIntoView 不一定听使唤
      const target =
        scrollNode.scrollTop +
        (el.getBoundingClientRect().top - scrollNode.getBoundingClientRect().top) -
        SCROLL_MARGIN_TOP;

      scrollNode.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      // 平滑滚动结束时不一定还有 scroll 事件，先把高亮给到刚点的这一节
      setActiveId(id);
    },
    [scrollNode],
  );

  const minLevel = useMemo(
    () => items.reduce((min, item) => Math.min(min, item.level), 6),
    [items],
  );

  if (items.length === 0) return null;

  if (isMobile) {
    return (
      <>
        {/* 右缘竖轨：视觉只有 6px，热区仍是 44px；不压正文可读宽度 */}
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label={t("entry.toc")}
          className={cn(
            "right-0 top-1/2 z-20 flex h-24 w-11 -translate-y-1/2 items-center justify-end pr-0.5 active:opacity-60",
            fixedInline ? "fixed" : "absolute",
          )}
        >
          <span className="flex h-16 w-1.5 flex-col items-center justify-center gap-1 rounded-full bg-foreground/15">
            <span className="size-0.5 rounded-full bg-foreground/40" />
            <span className="size-0.5 rounded-full bg-foreground/40" />
            <span className="size-0.5 rounded-full bg-foreground/40" />
          </span>
        </button>

        {createPortal(
          <AnimatePresence>
            {mobileOpen && (
              <div className="fixed inset-0 z-50">
                <motion.button
                  type="button"
                  aria-label={t("actions.close")}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  onClick={() => setMobileOpen(false)}
                  className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
                />
                <motion.div
                  role="dialog"
                  aria-modal="true"
                  aria-label={t("entry.toc")}
                  initial={{ x: "100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "100%" }}
                  transition={{ type: "tween", duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
                  className="absolute inset-y-0 right-0 flex w-[min(84vw,320px)] flex-col border-l border-border/60 bg-background shadow-2xl"
                >
                  <div className="flex items-center justify-between gap-3 border-b border-border/50 px-5 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
                        <ListTree className="size-4 text-muted-foreground" />
                        {t("entry.toc")}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {items.length} {t("entry.toc_sections")}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMobileOpen(false)}
                      aria-label={t("actions.close")}
                      className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-item-hover"
                    >
                      <X className="size-5" />
                    </button>
                  </div>
                  <nav className="flex-1 overflow-y-auto px-3 py-3">
                    <ul className="space-y-1 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
                      {items.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => {
                              handleJump(item.id);
                              setMobileOpen(false);
                            }}
                            style={{ paddingLeft: `${(item.level - minLevel) * 14 + 12}px` }}
                            className={cn(
                              "flex min-h-11 w-full items-center rounded-xl pr-3 text-left text-sm transition-colors duration-150",
                              item.id === activeId
                                ? "bg-item-active font-medium text-foreground"
                                : "text-muted-foreground active:bg-item-hover",
                            )}
                          >
                            <span className="truncate">{item.text}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </nav>
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body,
        )}
      </>
    );
  }

  const tocPanel = (
    <div
      className={cn(
        "group/toc z-20 w-6",
        fixedInline
          ? "fixed bottom-0 right-0 top-12"
          : "absolute inset-y-0 right-0",
      )}
    >
      {/* 常驻提示：右缘一小段竖条 + 三个刻度点，让人知道这里藏着东西；悬浮时变亮变长 */}
      <div className="pointer-events-none absolute inset-y-0 right-0 flex w-6 items-center justify-center">
        <div className="flex h-28 w-1.5 flex-col items-center justify-center gap-1 rounded-full bg-foreground/[0.06] opacity-90 transition-all duration-200 group-hover/toc:h-36 group-hover/toc:bg-foreground/10">
          <span className="size-0.5 rounded-full bg-foreground/30 transition-colors duration-200 group-hover/toc:bg-foreground/60" />
          <span className="size-0.5 rounded-full bg-foreground/30 transition-colors duration-200 group-hover/toc:bg-foreground/60" />
          <span className="size-0.5 rounded-full bg-foreground/30 transition-colors duration-200 group-hover/toc:bg-foreground/60" />
        </div>
      </div>

      <nav
        aria-label={t("entry.toc")}
        className={cn(
          "pointer-events-none absolute right-1 top-1/2 w-56 max-h-[70%] -translate-y-1/2 translate-x-2 overflow-y-auto rounded-xl border border-border/60 bg-card/85 p-2 opacity-0 shadow-nf backdrop-blur-xl",
          "transition-[opacity,transform] duration-200 ease-out",
          "group-hover/toc:pointer-events-auto group-hover/toc:translate-x-0 group-hover/toc:opacity-100",
        )}
      >
        <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {t("entry.toc")}
        </div>
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => handleJump(item.id)}
                style={{ paddingLeft: `${(item.level - minLevel) * 10 + 8}px` }}
                className={cn(
                  "block w-full truncate rounded-lg py-1 pr-2 text-left text-xs transition-colors duration-150",
                  item.id === activeId
                    ? "bg-item-active font-medium text-foreground"
                    : "text-muted-foreground hover:bg-item-hover hover:text-foreground",
                )}
                title={item.text}
              >
                {item.text}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );

  // 内联合列时正文栏用了圆角裁剪（卡片档 overflow:clip，原样档 clip-path），
  // 会把内部 fixed 目录一起裁掉；目录改为挂到 body，独立于正文卡片的裁剪区域。
  return fixedInline ? createPortal(tocPanel, document.body) : tocPanel;
}
