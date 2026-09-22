import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
}

/** 标题离顶部留出的距离（正文顶部有留白，跳过去别贴边） */
const SCROLL_MARGIN_TOP = 72;

/**
 * 正文右侧的悬浮目录（标题 + 小标题）。
 * 平时完全隐藏，鼠标移到面板右缘的一条窄带上才出现；点标题跳到该段。
 */
export function EntryToc({ scrollNode, entryId }: EntryTocProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
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

  return (
    <div className="group/toc absolute inset-y-0 right-0 z-20 w-6">
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
}
