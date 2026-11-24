import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProgressBar } from "@heroui/react";
import { computeReadingProgress } from "@/lib/reading-progress";
import { cn } from "@/lib/utils";

/**
 * 23-4：正文阅读进度条 —— 锁在正文工具栏（h-12 = 48px）正下方。
 *
 * 三个关键点（都是真机量过才定的）：
 * 1. **跟着真实滚动容器走**：滚动节点由调用方给（`useEntryContentScroll().scrollNode`，
 *    即 `.entry-content-viewport` —— 元素滚动）。本项目的文档滚动只服务移动端列表，
 *    进详情时会锁住，所以正文永远是元素在滚。
 * 2. **进度条本身不参与命中**：`pointer-events-none`，免得盖住工具栏下沿的点击。
 * 3. 高度 3px：HeroUI `ProgressBar` 的默认轨道是 8px（`h-2`），这条要的是「一条线」，
 *    所以覆写轨道/Fill 的高度与圆角；颜色仍走组件自己的 `--progress-bar-fill`（默认 = 主题强调色）。
 *
 * 正文里图片、代码高亮、AI 摘要都会在渲染后把高度顶大，所以除了监听 scroll，
 * 还要 `ResizeObserver` 盯住滚动容器与它的内容节点的尺寸变化（否则「读完时进度不是 100%」）。
 */
export function ReadingProgressBar({
  scrollNode,
  resetKey,
  className,
  sticky = false,
  rangeRef,
}: {
  /** 正文的真实滚动节点 */
  scrollNode: HTMLElement | null;
  /** 换条目时重算（同一节点上 scrollTop 会被重置） */
  resetKey?: string | null;
  className?: string;
  /** 内联合列：吸在正文工具栏下方 */
  sticky?: boolean;
  /**
   * 文档滚动（手机内联合列）：进度按这段正文相对视口的位置算。
   * 传了它就不用 `scrollNode`（那个容器在文档滚动下不滚，永远 0%）。
   */
  rangeRef?: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    const range = rangeRef?.current ?? null;
    if (!scrollNode && !range) return;

    const measure = () => {
      let next: number;
      if (range) {
        const rect = range.getBoundingClientRect();
        const viewport = window.innerHeight || document.documentElement.clientHeight;
        const total = rect.height - viewport;
        next =
          total > 0
            ? Math.min(100, Math.max(0, (-rect.top / total) * 100))
            : rect.top <= 0
              ? 100
              : 0;
      } else {
        next = computeReadingProgress({
          scrollTop: scrollNode!.scrollTop,
          scrollHeight: scrollNode!.scrollHeight,
          clientHeight: scrollNode!.clientHeight,
        }).percent;
      }
      // 同样的值不必 setState：滚动时每帧都算，避免无意义的重渲染
      setPercent((prev) => (Math.abs(prev - next) < 0.05 ? prev : next));
    };

    measure();
    const scrollTarget: HTMLElement | Window = range ? window : scrollNode!;
    scrollTarget.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    if (range) {
      observer.observe(range);
    } else {
      observer.observe(scrollNode!);
      const content = scrollNode!.firstElementChild;
      if (content) observer.observe(content);
    }
    // 字体/图片落地后高度还会再变一次，兜一次
    const retry = window.setTimeout(measure, 400);

    return () => {
      scrollTarget.removeEventListener("scroll", measure);
      observer.disconnect();
      window.clearTimeout(retry);
    };
  }, [scrollNode, resetKey, rangeRef]);

  return (
    <div
      data-reading-progress=""
      className={cn(
        sticky
          ? "pointer-events-none sticky top-11 z-20 sm:top-12"
          : "pointer-events-none absolute inset-x-0 top-[calc(2.75rem+env(safe-area-inset-top))] z-20 sm:top-12",
        className,
      )}
    >
      <ProgressBar
        value={percent}
        minValue={0}
        maxValue={100}
        aria-label={t("entry.reading_progress")}
        // 根是 `grid` 两行（label / output / track），这里只要一条轨道
        className="block w-full"
      >
        <ProgressBar.Track
          className={cn("h-[3px] rounded-none", sticky && "bg-transparent")}
        >
          {/* 滚动时跟着手指走，不要 HeroUI 自带的 300ms 宽度过渡（会拖尾） */}
          <ProgressBar.Fill className="rounded-none transition-none" />
        </ProgressBar.Track>
      </ProgressBar>
    </div>
  );
}
