import { memo, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Star } from "lucide-react";
import { Ripple } from "m3-ripple";
import { Chip } from "@heroui/react";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/server-url";
import { stripHtml } from "@/lib/html-utils";
import { FeedIcon } from "@/components/ui/feed-icon";
import { useEntrySourceJump } from "./entry-source-jump";
import { EntryToc } from "@/components/entry-content/EntryToc";
import { NotificationBodyPreview } from "./NotificationBodyPreview";
import { MachineTranslatedBadge } from "./machine-translated-badge";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  EntryContextMenuContent,
  SOCIAL_CLIPPED_SLACK_PX,
  SOCIAL_COLLAPSED_PX,
} from "./EntryListItem";
import { useFeedMenuActions } from "@/hooks/useFeedMenuActions";
import { useInView } from "@/hooks/useInView";
import { useFolders } from "@/hooks/useFolders";
import { UnreadIndicator, unreadRowClass } from "./unread-indicator";
import { useMarkAsRead } from "@/hooks/useEntries";
import { deferEntryRemoval } from "./deferred-removal";
import { useUISettingKey } from "@/hooks/useUISettings";
import { useTranslationStore } from "@/stores/translation-store";
import { resolveEntryAutoTranslate } from "@/lib/auto-translate";
import {
  buildTimelineRows,
  expandTimelineRows,
  isSingleSideWidth,
  pickStuckDateKeys,
  resolveTimelineTimeBasis,
  splitTimelineSections,
  timelineCollapseClampLines,
  type TimelineCollapse,
  type TimelineGranularity,
  type TimelineRow,
  type TimelineSide,
  type TimelineTimeBasis,
} from "@/lib/timeline-model";
import type { Entry, Feed } from "@/types/api";

/**
 * 通知视图 · 时间线（第十五批 15-1~15-4）。
 *
 * 形态（用户已拍板，效果图 `mockups/notification-timeline.html`（本地草图，未入库））：
 *   - 只作用于 `contentType === "notification"`，其余视图一行不动；
 *   - 中间一条竖轴，卡片左右交替；时间戳**紧贴节点**；最新在最上（数据本来就是 DESC）；
 *   - 同一个时间桶太密集时，多出来的条目吸成一个**小节点 + 计数**，点一下就地展开；
 *   - 跨天插一条日期分隔；容器宽度 **< 768px（移动端断点）真退化成单侧**（左时间列 + 右卡片）；
 *   - 卡片**默认折叠**（档位 1/2/3/全文由设置给），点「展开全文」**就地展开**，
 *     节点仍钉在卡片顶部 ⇒ 轴的位置不动、也不改滚动位置；
 *   - 键盘只在**轴上的卡片**之间吸附（被吸进小节点的条目不算节点），见 EntryList 的 useEntryHotkeys；
 *     滚轮不做任何拦截 —— 手感仍归浏览器。
 */

/** 单侧（退化）布局：时间列宽度 = 轴的位置（与 grid 第一列的 76px 必须一致，改就一起改） */
const SINGLE_SIDE_TIME_COLUMN = 76;
/** 节点与行的顶部间距（卡片上下都有内边距，节点对齐卡片第一行文字） */
const NODE_TOP_OFFSET = 12;
/** 交替布局下「时间戳紧贴节点」的间距（节点下缘 → 时间戳上缘） */
const TIME_GAP_AFTER_NODE = 3;
/** 节点直径（px）—— 头节点 9 / 小节点 6，与效果图一致，时间戳的落位也按它算 */
const TIMELINE_DOT_MAJOR = 9;
const TIMELINE_DOT_MINOR = 6;
/** 空集合常量：让 `useMemo` 在「开关关」时返回同一个引用，不至于每次渲染都造新 Set */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();
/**
 * 40-2：「点空白收起所有展开容器」的自定义事件名。
 * 触发方是 `EntryList` 的滚动视口（卡片列两侧的留白在时间线根之外，挂在那里才收得到），
 * 监听方是本组件的根容器。导出成常量是为了两边不写错字符串。
 */
export const COLLAPSE_ALL_EVENT = "krss:notification-collapse-all";

/**
 * 39-1：展开容器里挂的是**完整的正文页**（`EntryContent`），不是另做一套。
 * 用 `lazy` 保持 `App.tsx` 原本的代码分割（`LazyEntryContent`），别把阅读器拖进首屏包。
 */
const LazyEntryContent = lazy(async () => {
  const module = await import("@/components/entry-content");
  return { default: module.EntryContent };
});

function cnRow(singleSide: boolean): string {
  return cn(
    "relative grid items-start",
    singleSide
      ? "grid-cols-[76px_minmax(0,1fr)]"
      : "grid-cols-[minmax(0,1fr)_64px_minmax(0,1fr)]",
  );
}

/** 轴上的节点：major = 桶的头节点，minor = 同桶里的后续条目（小节点） */
function TimelineDot({
  node,
  unread,
  left,
}: {
  node: "major" | "minor";
  unread: boolean;
  left: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-timeline-dot={node}
      data-timeline-dot-size={node === "major" ? TIMELINE_DOT_MAJOR : TIMELINE_DOT_MINOR}
      style={{ left, top: NODE_TOP_OFFSET }}
      className={cn(
        "absolute z-[1] -translate-x-1/2 rounded-full bg-background",
        // 档位照效果图：头节点 9px/2px 描边，小节点 6px/1.5px（密集条目吸成的小节点）
        node === "major"
          ? "size-[9px] border-2"
          : "size-[6px] border-[1.5px]",
        unread ? "border-primary" : "border-border",
        unread && node === "major" && "bg-primary",
      )}
    />
  );
}

/**
 * 中栏宽度（判断窄栏退化用）。
 *
 * 量的是**中栏自己**的宽度而不是 `window.innerWidth`：用户可以把第二栏拖窄，
 * 那时窗口很宽但时间线已经放不下左右交替了（效果图里也是按栏宽说的 350px）。
 */
function useContainerWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const measure = () => {
      const next = node.getBoundingClientRect().width;
      setWidth((current) => (Math.abs(current - next) < 1 ? current : next));
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

interface TimelineCardProps {
  entry: Entry;
  feed?: Feed;
  feedUnreadCount?: number;
  isSelected: boolean;
  side: TimelineSide;
  node: "major" | "minor";
  /** 同桶里的条目数（> 1 时头节点上挂一个「N 条」计数） */
  bucketCount: number;
  clampLines: number | null;
  expanded: boolean;
  /** 29-1：正文悬停档 —— 卡片只留来源行 + 标题，不渲染正文/展开按钮/拖高手柄 */
  bodyOnHover?: boolean;
  onHoverEnter?: (
    entryId: string,
    x: number,
    y: number,
    cardTop: number,
    cardBottom: number,
  ) => void;
  onHoverLeave?: () => void;
  /** 「长贴自动展开」：该条目是长贴时不钳制（与社交视图同一开关语义） */
  autoExpandLongEntry?: boolean;
  /** 把预览正文的自然高度上报给父级（= 不钳制时的渲染高度，长贴判据用） */
  onNaturalHeightChange?: (entryId: string, height: number) => void;
  onToggleExpand: (entryId: string) => void;
  onSelect: (entryId: string) => void;
  /** 52-4：点源名/图标 → 第一栏选中该订阅 */
  onSelectFeedFromEntry?: (feedId: string) => void;
  /** 24-5：右键「标记上方为已读」（与卡片列表同一套菜单） */
  onMarkAbove?: () => void;
  /** 24-8：展开的正文容器高度（默认 380，右下角手柄可拖，钳制 200~70vh） */
  fullHeight: number;
  onFullHeightChange: (entryId: string, height: number) => void;
  /** 24-8：收起（选中展开时还要把选中交回列表） */
  onCollapse: (entryId: string) => void;
  autoTranslate: boolean;
  targetLanguage: string;
}

/** 24-8：时间线内展开的正文容器默认高度 */
export const TIMELINE_FULL_DEFAULT_HEIGHT = 380;
/** 钳制：最小 200px，最大 70vh */
export const TIMELINE_FULL_MIN_HEIGHT = 200;
export function timelineFullMaxHeight(): number {
  if (typeof window === "undefined") return 1200;
  return Math.floor(window.innerHeight * 0.7);
}

/**
 * 第四十三批（移动端性能）：正文自然高度上报 / 截断判定只在卡片接近视口时测量。
 *
 * 通知 tab 一屏几十张卡，两个 effect 无条件读 `scrollHeight` 会强制布局每一张
 * 离屏卡，正好抵消卡片根节点上的 `content-visibility:auto`。这里用
 * IntersectionObserver（rootMargin 200px）观察测量节点：进入视口附近才跑一次 +
 * 400ms 复测，离开时清掉复测定时器（避免给离屏卡留定时器）。
 *
 * 没有 IntersectionObserver（jsdom / 老浏览器）时退回原来的立即测量 + 400ms
 * 复测，现有单测语义不变。
 */
function observeMeasureWhenVisible(
  node: HTMLElement | null,
  run: () => void,
): () => void {
  if (!node) {
    run();
    return () => {};
  }
  const Observer = globalThis.IntersectionObserver;
  if (typeof Observer !== "function") {
    run();
    const retryNoIO = setTimeout(run, 400);
    return () => clearTimeout(retryNoIO);
  }
  let retry: ReturnType<typeof setTimeout> | null = null;
  const clearRetry = () => {
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
  };
  const measureNow = () => {
    run();
    clearRetry();
    retry = setTimeout(run, 400);
  };
  const observer = new Observer(
    (entries) => {
      for (const item of entries) {
        if (item.isIntersecting) measureNow();
        else clearRetry();
      }
    },
    { rootMargin: "200px" },
  );
  observer.observe(node);
  return () => {
    observer.disconnect();
    clearRetry();
  };
}

const TimelineCard = memo(function TimelineCard({
  entry,
  feed,
  feedUnreadCount,
  isSelected,
  side,
  node,
  bucketCount,
  clampLines,
  expanded,
  bodyOnHover = false,
  onHoverEnter,
  onHoverLeave,
  autoExpandLongEntry = false,
  onNaturalHeightChange,
  onToggleExpand,
  onSelect,
  onSelectFeedFromEntry,
  onMarkAbove,
  fullHeight,
  onFullHeightChange,
  onCollapse,
  autoTranslate,
  targetLanguage,
}: TimelineCardProps) {
  const { t } = useTranslation();
  const [iconError, setIconError] = useState(false);
  /**
   * 卡 B：订阅组行为 —— 唯一一份实现（`useFeedMenuActions`），与第一栏/条目列表同一份。
   * folders 按这条订阅的类型过滤（与条目列表同口径）。
   */
  const feedMenu = useFeedMenuActions();
  const { data: allFolders = [] } = useFolders();
  const feedMenuFolders = useMemo(
    () =>
      feed ? allFolders.filter((folder) => folder.type === feed.type) : [],
    [feed, allFolders],
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /**
   * 第四十三批（移动端性能）：只有接近视口的卡片才计算正文纯文字预览。
   *
   * 通知 tab 一屏几十张卡，每张都对 `entry.content` 全量 `stripHtml` 纯属浪费；
   * 用 `useInView("800px")`（与卡片 content-visibility 的 140px 估算配合）门控，
   * 未进入视口的卡片 `previewText` 直接空串。观察节点绑在**正文预览容器**上。
   * jsdom 无 IntersectionObserver 时 `useInView` 立即返回 true，测试行为不变。
   */
  const { ref: previewInViewRef, inView: previewInView } =
    useInView<HTMLDivElement>("800px");
  const [isClipped, setIsClipped] = useState(false);
  const unreadStyle = useUISettingKey("unreadStyle");
  const showIcon = feed?.iconPath && !iconError;
  const isUnread = !entry.read;

  const translation = useTranslationStore((state) =>
    // 54-7：与取数/预载同一份解析器（条目级 > 订阅级 > 全局），别只看全局开关
    targetLanguage &&
    resolveEntryAutoTranslate({ entry, feed, aiSettings: { autoTranslate } })
      ? state.getTranslation(entry.id, targetLanguage)
      : undefined,
  );
  const displayTitle = translation?.title ?? entry.title;

  /**
   * 折叠态显示**纯文字预览**（与「展开后仍是同一段文字、只是不再截断」同一份内容，
   * 就地展开因此只是把 clamp 摘掉，不会换一套 DOM、也不会把轴顶偏）。
   *
   * 54-4（用户 2026-10-20「在外面就能直接看到翻译后的内容」）：预览文字取
   * **译文**优先。译文由 `useListTranslations` 批量从后端缓存读回（只读），没有
   * 就照旧用原文 —— 卡片立刻可读，等预载落库后自然补上。
   *
   * 折叠行数、截断判定（`scrollHeight`）、展开容器里的完整正文页都不受影响：
   * 这里只是把「同一段文字的来源」从原文换成译文。
   */
  const previewText = useMemo(() => {
    // 第四十三批：未接近视口的卡片不做全量解析（离屏卡由 content-visibility 按 140px 估算）
    if (!previewInView) return "";
    const source = translation?.content ?? entry.content;
    const raw = source ? stripHtml(source) : "";
    const text = raw.replace(/\s+/g, " ").trim();
    return text || (displayTitle ?? "");
  }, [previewInView, entry.content, displayTitle, translation?.content]);

  // 折叠态下正文是否真的被截断（用 scrollHeight 判定，图片异步加载会改高度 → 复测一次）
  // 另把自然高度（= 不钳制时的渲染高度）上报给父级：父级拿它判「长贴」（> 300px），
  // 口径与社交视图的 scrollHeight > 300 + 8 等价 —— 读的是同一段预览 DOM 的 scrollHeight，
  // 不摘 clamp、不改视觉、不挂常驻 observer（只量两次）。
  useEffect(() => {
    // 29-1：悬停档下卡片里没有正文预览，不量自然高度、不判截断（不生效且不报错）
    if (bodyOnHover) return undefined;
    const node2 = bodyRef.current;
    if (onNaturalHeightChange) {
      const report = () => onNaturalHeightChange(entry.id, node2?.scrollHeight ?? 0);
      // 第四十三批：只在卡片接近视口时测量，离屏卡不再强制布局
      return observeMeasureWhenVisible(node2, report);
    }
    return undefined;
  }, [entry.id, previewText, clampLines, onNaturalHeightChange, bodyOnHover]);
  useEffect(() => {
    // 29-1：悬停档下卡片里没有正文预览，不判截断
    if (bodyOnHover) return undefined;
    const node2 = bodyRef.current;
    // 「长贴自动展开」命中的条目不再钳制：截断判定直接回短贴，展开按钮也不出
    if (!node2 || clampLines === null || autoExpandLongEntry) {
      setIsClipped(false);
      return;
    }
    const measure = () => setIsClipped(node2.scrollHeight > node2.clientHeight + 1);
    // 第四十三批：只在卡片接近视口时测量，离屏卡不再强制布局
    return observeMeasureWhenVisible(node2, measure);
  }, [previewText, clampLines, autoExpandLongEntry, bodyOnHover]);

  const effectiveClampLines = autoExpandLongEntry ? null : clampLines;
  const canExpand = effectiveClampLines !== null;
  const showToggle = canExpand && (isClipped || expanded);
  const feedName = feed?.title || t("entry.unknown_feed");
  /* 52-4：点卡片的「源名 / 图标」→ 第一栏选中该订阅（与条目列表同一份行为） */
  const { sourceProps } = useEntrySourceJump(feed, onSelectFeedFromEntry);
  // 24-8：展开态是「正文级完整渲染」而不是去掉 clamp —— 有全文才进展开容器
  const hasFullContent = !!entry.content?.trim();

  // 24-8：右下角手柄拖高度（钳制 200 ~ 70vh），每条记自己的高度
  const handleResizeStart = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      const startY = event.clientY;
      const startHeight = fullHeight;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // 非指针环境（单测 / 无鼠标）可跳过捕获，move 监听照样工作
      }
      const onMove = (moveEvent: PointerEvent) => {
        const next = Math.round(startHeight + (moveEvent.clientY - startY));
        onFullHeightChange(
          entry.id,
          Math.min(
            Math.max(next, TIMELINE_FULL_MIN_HEIGHT),
            timelineFullMaxHeight(),
          ),
        );
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [entry.id, fullHeight, onFullHeightChange],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-entry-id={entry.id}
          data-timeline-card={node}
          data-timeline-side={side}
          data-body-on-hover={bodyOnHover ? "true" : undefined}
          onClick={() => onSelect(entry.id)}
          onMouseEnter={
            bodyOnHover
              ? (event) => {
                  // 带上卡片上下沿：落点要退到卡片下沿之下（标题不被遮）
                  const rect = event.currentTarget.getBoundingClientRect();
                  onHoverEnter?.(
                    entry.id,
                    event.clientX,
                    event.clientY,
                    rect.top,
                    rect.bottom,
                  );
                }
              : undefined
          }
          onMouseLeave={bodyOnHover ? () => onHoverLeave?.() : undefined}
          className={cn(
            // 第四十三批（移动端性能）：通知卡片实测高 88–149px，离屏时用 140px
            // 估算跳过布局/绘制；进入视口再由浏览器收敛到真实高度。
            "[content-visibility:auto] [contain-intrinsic-size:auto_140px]",
            "group relative cursor-pointer overflow-hidden rounded-[10px] border p-2.5 transition-[background-color,border-color,box-shadow,opacity] duration-200",
            isSelected
              ? "border-border/60 bg-card shadow-nf"
              : "border-transparent hover:bg-item-hover",
            unreadRowClass(isUnread, !!entry.starred, isSelected, unreadStyle),
          )}
        >
          <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />

          {/* 来源行：favicon + 源名 + 计数（同桶多条时）+ 静音/星标 */}
          <div className="relative flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <UnreadIndicator unread={isUnread} count={feedUnreadCount}>
              {showIcon ? (
                <img
                  src={apiUrl(`/icons/${feed?.iconPath}`)}
                  alt=""
                  width={18}
                  height={18}
                  loading="lazy"
                  decoding="async"
                  {...sourceProps}
                  className={cn(
                    "size-[18px] shrink-0 rounded-[var(--ui-icon-radius,3px)] object-contain",
                    sourceProps?.className,
                  )}
                  onError={() => setIconError(true)}
                />
              ) : (
                <span
                  {...sourceProps}
                  className={cn(
                    "flex size-[18px] shrink-0 items-center justify-center",
                    sourceProps?.className,
                  )}
                >
                  <FeedIcon className="size-[18px] text-muted-foreground/50" />
                </span>
              )}
            </UnreadIndicator>
            <span
              {...sourceProps}
              className={cn(
                "min-w-0 truncate font-medium text-foreground/80",
                sourceProps?.className,
              )}
            >
              {feedName}
            </span>
            {bucketCount > 1 && node === "major" && (
              <Chip size="sm" variant="soft" color="accent" className="shrink-0">
                <Chip.Label className="text-[10.5px] leading-none">
                  {t("timeline.entries_count", { count: bucketCount })}
                </Chip.Label>
              </Chip>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {/* 54-5：预览文字显示的是译文时挂语言图标（判据 = store 里真有译文） */}
              {translation?.content && <MachineTranslatedBadge />}
              {entry.starred && (
                <Star
                  className="size-3.5 shrink-0 text-amber-500"
                  aria-hidden="true"
                  data-entry-starred-badge=""
                />
              )}
              {entry.muted && (
                <span className="rounded-[3px] border border-border/60 bg-secondary/40 px-1 py-px text-[10px] leading-4">
                  {t("automation.muted_badge")}
                </span>
              )}
            </span>
          </div>

          {/* 标题（时间戳在轴上、紧贴节点，所以卡片里不再重复时间）
              40-1：展开态下**隐藏卡片标题** —— 展开容器里那个完整正文页自带 h1，
              两份标题挨在一起是重复。悬停档不展开、标题必须留着。 */}
          {bodyOnHover || !expanded ? (
            <div
              className={cn(
                "mt-1 line-clamp-2 text-[13.5px] font-semibold leading-5 wrap-anywhere",
                isUnread ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {displayTitle || t("entry.untitled")}
            </div>
          ) : null}

          {/* 29-1：悬停档 = 来源行 + 标题，不再渲染正文预览/展开按钮/展开容器/拖高手柄 */}
          {bodyOnHover ? null : expanded && hasFullContent ? (
            <div className="mt-2">
              <div className="mx-auto w-full max-w-[clamp(45ch,60vw,65ch)]">
                <div className="relative">
                  {/* 20-4：不要 overscroll-contain——用户要的是内层到底后继续滚带动外层列表
                      （默认链式滚动）。之前加的 contain 把链拦死，内层到底就停住、外层不动。 */}
                  <div
                    ref={bodyRef}
                    data-timeline-full={entry.id}
                    data-timeline-full-height={fullHeight}
                    onClick={(event) => event.stopPropagation()}
                    className="relative overflow-y-auto rounded-lg border border-border/60"
                    data-timeline-reader={entry.id}
                    style={{ height: fullHeight }}
                  >
                    {/* 39-1：这里挂的是**完整的正文页**（`EntryContent` 内嵌模式）——
                        工具栏（星标/已读/AI摘要/翻译/原网站/阅读模式/打开原文）、AI 摘要框、
                        Readability/翻译管道全部与第三栏同一份实现，不是另做一套。
                        外层只保留「固定高度 + 内部滚动 + 边框 + 大纲的定位基准」，
                        滚动由这个容器负责（所以内嵌模式不挂自己的滚动容器）。
                        `entry-content` 那个 class 由内层 `EntryContentBody` 的
                        `<article class="entry-content">` 提供（`index.css` 的
                        `.entry-content .prose` 变量/代码块/表格样式靠它）。 */}
                    <Suspense
                      fallback={
                        <div className="animate-pulse space-y-3 p-4">
                          <div className="h-4 w-3/4 rounded bg-secondary" />
                          <div className="h-3 w-full rounded bg-secondary" />
                          <div className="h-3 w-5/6 rounded bg-secondary" />
                        </div>
                      }
                    >
                      <LazyEntryContent
                        key={entry.id}
                        entryId={entry.id}
                        contentType="notification"
                        embedded
                        containerRef={bodyRef}
                      />
                    </Suspense>
                    <EntryToc scrollNode={bodyRef.current} entryId={entry.id} />
                  </div>
                  <span
                    data-timeline-resize={entry.id}
                    title={t("timeline.resize_hint")}
                    onPointerDown={handleResizeStart}
                    onClick={(event) => event.stopPropagation()}
                    className="absolute bottom-1.5 right-1.5 cursor-ns-resize select-none text-[12px] tracking-[-2px] text-muted-foreground transition-colors duration-200 hover:text-foreground"
                  >
                    ⋰
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCollapse(entry.id);
                  }}
                  className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground transition-colors duration-200 hover:text-foreground"
                >
                  <ChevronUp className="size-3.5" />
                  {t("timeline.collapse")}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* 正文预览：折叠态 clamp 到设置的行数。
                  容器**常驻**（即使 previewText 为空串）—— 否则离屏卡
                  `previewText=""` 时容器不挂，`useInView` 的 ref 永远观察不到，
                  视口内也永远不会补算正文。离屏卡靠 content-visibility 按 140px 估算。 */}
              <div
                ref={(node) => {
                  bodyRef.current = node;
                  previewInViewRef.current = node;
                }}
                data-timeline-body={
                  effectiveClampLines === null ? "full" : String(effectiveClampLines)
                }
                className={cn(
                  "mt-1 text-[12.5px] leading-5 text-muted-foreground wrap-anywhere",
                  !isUnread && "text-muted-foreground/70",
                )}
                style={
                  effectiveClampLines !== null && !expanded
                    ? {
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: effectiveClampLines,
                        overflow: "hidden",
                      }
                    : undefined
                }
              >
                {previewText}
              </div>

              {/* 展开/收起：就地展开，不跳轴（节点钉在卡片顶部，长的部分往下长） */}
              {showToggle && (
                <button
                  type="button"
                  data-timeline-expand={entry.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleExpand(entry.id);
                  }}
                  className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground transition-colors duration-200 hover:text-foreground"
                >
                  {expanded ? (
                    <ChevronUp className="size-3.5" />
                  ) : (
                    <ChevronDown className="size-3.5" />
                  )}
                  {expanded ? t("timeline.collapse") : t("timeline.expand")}
                </button>
              )}
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <EntryContextMenuContent
        entry={entry}
        feed={feed}
        feedActions={feedMenu}
        feedFolders={feedMenuFolders}
        onMarkAbove={onMarkAbove}
      />
    </ContextMenu>
  );
});

/** 被吸进小节点的条目：一个小节点 + 计数，点一下就地展开 */
function TimelineClusterCard({
  count,
  feeds,
  expanded,
  onToggle,
}: {
  count: number;
  feeds: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      data-timeline-cluster={count}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-[10px] border border-dashed border-border/70 px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors duration-200 hover:bg-item-hover"
    >
      <Chip size="sm" variant="soft" color="accent" className="shrink-0">
        <Chip.Label className="text-[10.5px] leading-none">
          {t("timeline.entries_count", { count })}
        </Chip.Label>
      </Chip>
      <span className="min-w-0 truncate">{feeds.join(" · ")}</span>
      {/* 展开了要给得回「收起」的出口，否则点一下就再也合不上 */}
      <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px]">
        {expanded && <span>{t("timeline.collapse")}</span>}
        {expanded ? (
          <ChevronUp className="size-3.5" />
        ) : (
          <ChevronDown className="size-3.5" />
        )}
      </span>
    </button>
  );
}

export interface NotificationTimelineHandle {
  /** 让目标条目所在段先挂载，再把该条目滚进视口（跨段 j/k 用）。 */
  revealEntry: (entryId: string) => boolean;
}

export interface NotificationTimelineProps {
  entries: Entry[];
  feeds: Map<string, Feed>;
  unreadCounts?: Record<string, number>;
  selectedEntryId: string | null;
  onSelectEntry: (entryId: string) => void;
  /** 24-5：右键「标记上方为已读」（与卡片列表同一套菜单） */
  onMarkAboveEntry?: (entryId: string) => void;
  /** 24-8：收起选中展开的条目（把选中交回列表） */
  onCloseEntry?: () => void;
  granularity: TimelineGranularity;
  collapse: TimelineCollapse;
  /** 「长贴自动展开」开关（通知视图槽位，与社交视图同一语义） */
  autoExpandLong?: boolean;
  /** 26-2：时间基准（发布时间 / 抓取时间），默认发布时间 = 现状 */
  timeBasis?: TimelineTimeBasis;
  /** 窄栏自动合一栏（默认开；关掉则始终左右交替） */
  autoSingleSide?: boolean;
  autoTranslate: boolean;
  targetLanguage: string;
  /** 29-1：正文悬停档（默认 false = 现状一字不改）。
   * true = 卡片只留来源行 + 标题，正文走悬浮块；触屏（hover: none）由内部自动降级回卡片内正文。 */
  bodyOnHover?: boolean;
  /** 52-4：点卡片的「源名 / 图标」→ 第一栏选中该订阅（与条目列表同一行为） */
  onSelectFeedFromEntry?: (feedId: string) => void;
  /**
   * 把「轴上的卡片」（不含被吸进小节点的条目）回报给父级 ——
   * 键盘 j/k、↑/↓ 就在这些节点之间吸附，不会选到看不见的条目。
   */
  onSelectableEntriesChange?: (entries: Entry[]) => void;
  /** 暴露命令式句柄：通知视图本身不虚拟整列，j/k 跨段时要先挂载目标段 */
  handleRef?: React.MutableRefObject<NotificationTimelineHandle | null>;
}


/**
 * 通知时间线的「段内行窗口化」（DOM 级虚拟化）：
 * 一天一段，段内可能有几十条卡片。日期吸顶头保持在段容器里（只有几段，代价很小），
 * 但段内的行卡片只在接近视口（rootMargin 1200px）时才挂载，滚远后卸载，
 * 用上一次实测高度做占位，既省 React 挂载/布局，又不破坏 sticky 头与整段高度。
 */
function TimelineLazyRows({
  sectionKey,
  rowCount,
  heights,
  forceMount = false,
  children,
}: {
  sectionKey: string;
  rowCount: number;
  heights: React.MutableRefObject<Map<string, number>>;
  /** 跨段 reveal 时强制挂载（挂上后由滚动位置接管） */
  forceMount?: boolean;
  children: () => ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // 初值 false：首帧只渲染占位高度，布局效应在**绘制前**按真实滚容器位置裁一次，
  // 命中视口的段立刻挂载，远离的保持占位 —— 进入通知视图的首个提交不再全量挂载。
  const [mounted, setMounted] = useState(false);

  useLayoutEffect(() => {
    if (forceMount) {
      setMounted(true);
      return;
    }
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const viewportH = window.innerHeight || 0;
    setMounted(rect.bottom > -1200 && rect.top < viewportH + 1200);
  }, [forceMount]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const Observer = globalThis.IntersectionObserver;
    if (typeof Observer !== "function") {
      setMounted(true);
      return;
    }
    // 桌面真正的滚容器是内层 entry-list-viewport（overflow-y-auto），
    // 不传 root 时 rootMargin 会被这层 clip 抵消，预挂载缓冲等于失效。
    const root = node.closest('[data-testid="entry-list-viewport"]');
    const observer = new Observer(
      (entries) => {
        for (const item of entries) {
          if (item.isIntersecting) setMounted(true);
          else if (!forceMount) setMounted(false);
        }
      },
      { root: root instanceof Element ? root : null, rootMargin: "1200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [forceMount]);

  useEffect(() => {
    const node = ref.current;
    if (!node || !mounted) return;
    const measure = () => {
      const h = node.offsetHeight;
      if (h > 0) heights.current.set(sectionKey, h);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [mounted, sectionKey, heights]);

  const estimate =
    heights.current.get(sectionKey) ?? Math.max(96, rowCount * 140);
  return (
    <div
      ref={ref}
      data-timeline-rows={sectionKey}
      aria-hidden={mounted ? undefined : true}
      style={mounted ? undefined : { height: `${estimate}px` }}
    >
      {mounted ? children() : null}
    </div>
  );
}

export function NotificationTimeline({
  entries,
  feeds,
  unreadCounts,
  selectedEntryId,
  onSelectEntry,
  onMarkAboveEntry,
  onCloseEntry,
  granularity,
  collapse,
  autoExpandLong = false,
  timeBasis,
  autoSingleSide = true,
  autoTranslate,
  targetLanguage,
  bodyOnHover = false,
  onSelectableEntriesChange,
  onSelectFeedFromEntry,
  handleRef,
}: NotificationTimelineProps) {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const width = useContainerWidth(containerRef);
  const singleSide = autoSingleSide && isSingleSideWidth(width);
  const clampLines = timelineCollapseClampLines(collapse);
  /**
   * 「长贴自动展开」的长贴判据 —— 与社交视图同一口径（渲染高度 > 300px）。
   *
   * 做法：各卡片把自己的预览正文**自然高度**（scrollHeight = 不钳制时的渲染高度）
   * 上报到这里，父级只记一个 id → 高度的 map，比 300 即得结论。
   *   - 量的是**卡片里真实挂载的那段预览 DOM**（同字号/同行高/同列宽），只是读它的
   *     scrollHeight 而不是 clientHeight —— 读 scrollHeight 不需要摘 clamp，
   *     卡片视觉上仍是钳制态，不闪；
   *   - 没量出来之前按短贴处理（保持现有行为，不先展开再塌回）；
   *   - 上报只在「预览文本 / 钳制行数 / 开关」变化时跑一次 + 400ms 后复测一次
   *     （对齐社交视图的图片异步复测），没有常驻 ResizeObserver，不影响滚动。
   */
  const [naturalHeights, setNaturalHeights] = useState<Record<string, number>>({});
  /**
   * 合批（性能）：卡片的自然高度上报先进这个待处理 Map，**不**立刻 setState。
   *
   * 真机长任务的第二来源（第一是 50 行一次挂满）：每张卡除了挂载上报一次，
   * 还在 400ms 后复测一次（图片异步加载会改高度）。50 个 `setTimeout` 各自是
   * 独立宏任务，浏览器两个宏任务之间会插入渲染 → 复测波 = 一串「一条高度 → 整棵
   * 时间线重渲染」的长任务（实测切换后 @641ms 起连串 87~387ms）。上报现在折成
   * **一次** setState：
   *   - 挂载那批在同一趟 passive effect 里（子先父后），下面那条无依赖 effect 在
   *     本轮 commit 末尾一次性 flush，展开结果与逐条 setState 时同步生效；
   *   - 复测那类「父级本轮不重渲染」的上报排**一个宏任务**兜底（排程位防重复排程），
   *     同一批到期回调全落进 Map 再一次 flush。
   * 刻意不用 `requestAnimationFrame`：后台标签页 rAF 被节流 → 长贴永远不展开
   * （实测过这个坑）。flush 先比 diff，全等就返回原引用 → 不发渲染。
   * 长贴判据（> 300px）与展开/钳制/悬停/多选的业务判据一律没动。
   */
  const pendingHeightsRef = useRef<Map<string, number> | null>(null);
  const heightFlushTimerRef = useRef<number | null>(null);
  const cancelNaturalHeightFlush = useCallback(() => {
    if (heightFlushTimerRef.current === null) return;
    window.clearTimeout(heightFlushTimerRef.current);
    heightFlushTimerRef.current = null;
  }, []);
  const flushPendingNaturalHeights = useCallback(() => {
    cancelNaturalHeightFlush();
    const pending = pendingHeightsRef.current;
    if (!pending || pending.size === 0) return;
    pendingHeightsRef.current = null;
    setNaturalHeights((current) => {
      let changed = false;
      pending.forEach((height, entryId) => {
        if (current[entryId] !== height) changed = true;
      });
      if (!changed) return current;
      const next = { ...current };
      pending.forEach((height, entryId) => {
        next[entryId] = height;
      });
      return next;
    });
  }, [cancelNaturalHeightFlush]);
  const handleNaturalHeightChange = useCallback(
    (entryId: string, height: number) => {
      let pending = pendingHeightsRef.current;
      if (!pending) {
        pending = new Map();
        pendingHeightsRef.current = pending;
      }
      pending.set(entryId, height);
      // 已排程就等那一次 flush；挂载那批由下面 effect 末尾的 flush 就地消费
      if (heightFlushTimerRef.current !== null) return;
      heightFlushTimerRef.current = window.setTimeout(() => {
        heightFlushTimerRef.current = null;
        flushPendingNaturalHeights();
      }, 0);
    },
    [flushPendingNaturalHeights],
  );
  // 每轮 commit 的 effect 末尾兜一次：挂载/更新那一批上报全在同一趟 effect 里落进
  // Map（子先父后），这里一次性 flush —— 不等宏任务，展开结果与改前同步生效。
  useEffect(() => {
    if (pendingHeightsRef.current && pendingHeightsRef.current.size > 0) {
      flushPendingNaturalHeights();
    }
  });
  // 卸载时取消还没跑的排程并丢掉待处理值，免得 setState 打在已卸载的树上
  useEffect(
    () => () => {
      cancelNaturalHeightFlush();
      pendingHeightsRef.current = null;
    },
    [cancelNaturalHeightFlush],
  );
  /** 26-2：时间基准（缺值一律回发布时间 = 现状） */
  const basis = resolveTimelineTimeBasis(timeBasis);

  /**
   * 29-1：触屏降级 —— `hover: none` 的设备没有悬停，正文必须留在卡片里，
   * 即使开关开了也按现状渲染。
   */
  const [coarsePointer, setCoarsePointer] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(hover: none)");
    setCoarsePointer(query.matches);
    const onChange = (event: MediaQueryListEvent) => setCoarsePointer(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const hoverMode = bodyOnHover && !coarsePointer;

  /**
   * 悬停浮块状态 —— 卡片 enter 立开（锚点取 mouseenter 事件自带的坐标：
   * 指针停在卡片上不动时也必须先出现在正确位置，不能等下一次 mousemove；
   * 浮块常挂，anchor 只做首帧兜底，跟随由浮块自己的 window mousemove 负责），
   * 卡片 leave / 浮块 leave 起 250ms 延迟关（RefreshTooltip 同款），浮块 enter 清 timer。
   */
  const [hoverAnchor, setHoverAnchor] = useState<{
    id: string;
    x: number;
    y: number;
    cardTop: number;
    cardBottom: number;
  } | null>(null);
  const hoverCloseTimer = useRef<number | null>(null);
  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimer.current !== null) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  }, []);
  const openHover = useCallback(
    (entryId: string, x: number, y: number, cardTop: number, cardBottom: number) => {
      cancelHoverClose();
      setHoverAnchor({ id: entryId, x, y, cardTop, cardBottom });
    },
    [cancelHoverClose],
  );
  const scheduleHoverClose = useCallback(() => {
    cancelHoverClose();
    hoverCloseTimer.current = window.setTimeout(() => setHoverAnchor(null), 250);
  }, [cancelHoverClose]);
  useEffect(() => cancelHoverClose, [cancelHoverClose]);
  // 退出悬停档时藏浮块（常挂节点 entry=null + visible=false，不卸载）；
  // 换一批条目后旧 id 找不到对应条目，浮块同样回到隐藏态
  useEffect(() => {
    if (!hoverMode) setHoverAnchor(null);
  }, [hoverMode, entries]);

  const [expandedClusters, setExpandedClusters] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedEntries, setExpandedEntries] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /**
   * 用户显式收起过的条目（只记「长贴自动展开」命中的卡片）。
   * 自然高度上报只在预览分支挂载时跑一次 + 400ms 复测，没有常驻 observer ——
   * 收起后高度值还留在 `naturalHeights` 里，不记这一笔的话下一渲染就被同一个
   * 判据又弹开。换一批条目时清空（与 `naturalHeights` 对齐）。
   */
  const [manuallyCollapsed, setManuallyCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /**
   * 「长贴自动展开」命中 ⟺ 这张卡片是展开的。
   * 命中条件 = 开关开 + 自然高度超长贴阈值 + 用户没显式收起过。
   * 调用方（钳制 prop / `expanded` prop）都走它，卡片内部的正文内容区、
   * 折叠判定、展开/收起按钮等所有按 `expanded` 分支的地方自然一致。
   * 短贴 / 开关关时恒 false，行为与现状完全一致。
   */
  const isAutoExpanded = useCallback(
    (entryId: string) =>
      autoExpandLong &&
      (naturalHeights[entryId] ?? 0) >
        SOCIAL_COLLAPSED_PX + SOCIAL_CLIPPED_SLACK_PX &&
      !manuallyCollapsed.has(entryId),
    [autoExpandLong, naturalHeights, manuallyCollapsed],
  );
  /**
   * 40-2：当前正被「长贴自动展开」撑开着的那些条目。
   * 用 `naturalHeights` 现算（它是长贴判据的权威来源，见 `isAutoExpanded`），
   * 「点空白收起全部」要把它们也一并收掉 —— 只清 `expandedEntries` 的话，
   * 自动展开的那批下一次渲染又会被同一判据弹回来。
   */
  const autoExpandIds = useMemo(() => {
    if (!autoExpandLong) return EMPTY_ID_SET;
    const ids = new Set<string>();
    for (const [id, height] of Object.entries(naturalHeights)) {
      if (
        height > SOCIAL_COLLAPSED_PX + SOCIAL_CLIPPED_SLACK_PX &&
        !manuallyCollapsed.has(id)
      ) {
        ids.add(id);
      }
    }
    return ids;
  }, [autoExpandLong, naturalHeights, manuallyCollapsed]);
  // 24-8：每条展开容器的高度（默认 380，右下角手柄可拖）
  const [fullHeights, setFullHeights] = useState<Record<string, number>>({});
  const { mutate: markAsRead } = useMarkAsRead();

  const handleFullHeightChange = useCallback(
    (entryId: string, height: number) => {
      setFullHeights((current) =>
        current[entryId] === height
          ? current
          : { ...current, [entryId]: height },
      );
    },
    [],
  );

  // 24-8：桌面端通知视图没有第三栏了，点条目 = 时间线内展开。
  // 顺手标已读（原来是第三栏的 EntryContent 干这事）：skipInvalidate + 记 deferred，
  // 离列表才摘（24-1 同语义），滚动标已读一行不动。
  const handleSelect = useCallback(
    (entryId: string) => {
      const index = entries.findIndex((item) => item.id === entryId);
      const target = index >= 0 ? entries[index] : undefined;
      if (target && !target.read) {
        markAsRead({ id: entryId, read: true, skipInvalidate: true });
        deferEntryRemoval(entryId, { ...target, read: true }, index);
      }
      onSelectEntry(entryId);
    },
    [entries, markAsRead, onSelectEntry],
  );

  // 24-8：收起 —— 手动展开的摘掉展开态；选中展开的把选中交回列表。
  // 自动展开命中的卡片被用户收起 → 记一笔「显式收起」，不再自动弹开
  // （自然高度值还留在 naturalHeights 里，没这笔记忆下一渲染就被同一判据弹开）。
  const handleCollapse = useCallback(
    (entryId: string) => {
      setExpandedEntries((current) => {
        if (!current.has(entryId)) return current;
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      if (
        autoExpandLong &&
        (naturalHeights[entryId] ?? 0) >
          SOCIAL_COLLAPSED_PX + SOCIAL_CLIPPED_SLACK_PX
      ) {
        setManuallyCollapsed((current) =>
          current.has(entryId) ? current : new Set(current).add(entryId),
        );
      }
      if (selectedEntryId === entryId) onCloseEntry?.();
    },
    [selectedEntryId, onCloseEntry, autoExpandLong, naturalHeights],
  );

  /**
   * 40-2：点空白处把**所有**展开的容器收起来（事件由 `EntryList` 的滚动视口发，
   * 因为卡片列两侧的留白在时间线根之外 —— 见 `COLLAPSE_ALL_EVENT`）。
   *
   * 展开有**三个**来源（见下面 TimelineCard 的 `expanded` 判据），三样都要清：
   * `expandedEntries`（手动点开）+ `selectedEntryId`（点卡片进的那条）+ `isAutoExpanded`
   * （「长贴自动展开」命中）。漏掉任何一个，点完空白还会有一半容器开着。
   */
  const handleCollapseAll = useCallback(() => {
    if (expandedEntries.size === 0 && !selectedEntryId && autoExpandIds.size === 0) {
      return;
    }
    setExpandedEntries(new Set<string>());
    // 自动展开命中的那些要记「显式收起」，否则下一渲染又被同一判据弹开
    setManuallyCollapsed((current) => {
      const next = new Set(current);
      for (const id of autoExpandIds) next.add(id);
      return next.size === current.size ? current : next;
    });
    if (selectedEntryId) onCloseEntry?.();
  }, [expandedEntries, selectedEntryId, autoExpandIds, onCloseEntry]);

  useEffect(() => {
    const node = containerRef?.current;
    if (!node) return undefined;
    node.addEventListener(COLLAPSE_ALL_EVENT, handleCollapseAll);
    return () => node.removeEventListener(COLLAPSE_ALL_EVENT, handleCollapseAll);
  }, [containerRef, handleCollapseAll]);

  // 展开后跟随：展开是纯向下生长、卡片顶部本身不动，所以只处理一种情况——
  // 卡片顶部被顶出视口上方时，把它拉回来（向上滚）；其他情况一律不动，
  // 展开内容自然向下长，鼠标不用往上滑。（反过来往下补滚动会把卡片顶出屏，
  // 用户反而要往上滑回来——之前那版方向写反了。）
  const expandedSignature = useMemo(() => {
    const ids = [...expandedEntries];
    if (selectedEntryId) ids.push(selectedEntryId);
    return ids.sort().join(" ");
  }, [expandedEntries, selectedEntryId]);
  const prevExpandedSignatureRef = useRef("");
  useEffect(() => {
    const prev = prevExpandedSignatureRef.current;
    prevExpandedSignatureRef.current = expandedSignature;
    if (!expandedSignature || expandedSignature === prev) return;
    const prevIds = new Set(prev ? prev.split(" ") : []);
    const freshId = expandedSignature
      .split(" ")
      .find((id) => !prevIds.has(id));
    if (!freshId) return;
    const root = containerRef.current;
    const card = root?.querySelector<HTMLElement>(
      `[data-timeline-card][data-entry-id="${freshId}"], [data-entry-id="${freshId}"]`,
    );
    if (!root || !card) return;
    // requestAnimationFrame：等展开容器的高度落定再量
    const frame = requestAnimationFrame(() => {
      const scroller =
        root.closest<HTMLElement>('[data-testid="entry-list-viewport"]') ??
        root.closest<HTMLElement>(".entry-list-document");
      if (scroller) {
        const view = scroller.getBoundingClientRect();
        const rect = card.getBoundingClientRect();
        // 卡片顶部在视口上方（被顶出去）才向上拉回来，对齐视口顶 + 12px
        if (rect.top < view.top) scroller.scrollTop -= view.top - rect.top + 12;
      } else if (typeof window !== "undefined") {
        const rect = card.getBoundingClientRect();
        if (rect.top < 0) window.scrollBy({ top: rect.top - 12 });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [expandedSignature]);

  // 换粒度 / 换基准 / 换列表时收起来，免得「展开态」跟着另一批数据走
  useEffect(() => {
    setExpandedClusters(new Set());
  }, [granularity, timeBasis, entries]);
  // 换一批条目时上一批的自然高度作废（id → 高度是按条目记的，不清会串）；
  // 跳过首轮挂载 —— 挂载时子卡片的上报 effect 先跑，父级清零后跑会把刚上报的盖掉
  const prevEntriesRef = useRef(entries);
  useEffect(() => {
    if (prevEntriesRef.current === entries) return;
    prevEntriesRef.current = entries;
    setNaturalHeights({});
    // 「显式收起」记忆只清掉已不在列表里的 id：同 id 还在（后台刷新同数据）时
    // 保留记忆，用户收起的卡片不会因为换一批数组引用又弹开
    setManuallyCollapsed((current) => {
      if (current.size === 0) return current;
      const alive = new Set(entries.map((item) => item.id));
      let dropped = false;
      const next = new Set<string>();
      current.forEach((id) => {
        if (alive.has(id)) next.add(id);
        else dropped = true;
      });
      return dropped ? next : current;
    });
  }, [entries]);

  const rows = useMemo(
    () =>
      buildTimelineRows(entries, {
        granularity,
        t,
        locale: i18n.language,
        timeBasis: basis,
      }),
    [entries, granularity, basis, t, i18n.language],
  );

  const displayRows = useMemo(
    () => expandTimelineRows(rows, expandedClusters, basis),
    [rows, expandedClusters, basis],
  );

  /**
   * 按日期切段（用户 9-24 吸顶）：日期行的 sticky 必须限制在**自己那一段**里 ——
   * 同容器里多个 `top: 0` 的 sticky 会互相重叠（实测 26 条全贴容器顶 = 整摞贴住），
   * 套一层段容器之后才会「后一段顶掉前一段」。
   */
  const sections = useMemo(
    () => splitTimelineSections(displayRows),
    [displayRows],
  );

  /** 段内行块实测高度（卸载后用占位，避免滚动条跳动） */
  const rowsHeightsRef = useRef<Map<string, number>>(new Map());
  /** 被命令式 reveal 强制挂载的段（滚到目标后清掉，交还 observer） */
  const [forcedSections, setForcedSections] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const pendingRevealIdRef = useRef<string | null>(null);

  /**
   * 命令式 reveal：通知视图不虚拟整列，但段内行块会卸载。j/k 跨到未挂载段时
   * `document.querySelector` 必然落空，所以要先把目标段强挂上，再滚动。
   * 目标若被吸进聚合卡，还要先展开那个聚合卡（卡片本身也是段内行）。
   */
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      revealEntry: (entryId: string) => {
        const section = sections.find((item) =>
          item.rows.some((row) =>
            row.kind === "cluster"
              ? row.entries.some((e) => e.id === entryId)
              : row.entry.id === entryId,
          ),
        );
        if (!section) return false;
        const targetRow = section.rows.find((row) =>
          row.kind === "cluster"
            ? row.entries.some((e) => e.id === entryId)
            : row.entry.id === entryId,
        );
        if (targetRow?.kind === "cluster") {
          setExpandedClusters((prev) => {
            if (prev.has(targetRow.key)) return prev;
            const next = new Set(prev);
            next.add(targetRow.key);
            return next;
          });
        }
        pendingRevealIdRef.current = entryId;
        setForcedSections((prev) => {
          if (prev.has(section.key)) return prev;
          const next = new Set(prev);
          next.add(section.key);
          return next;
        });
        return true;
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, sections, setExpandedClusters]);

  /** 段强制挂载后，等该条目真正进 DOM 再滚；最多等 20 帧。滚完交还 observer。 */
  useEffect(() => {
    const entryId = pendingRevealIdRef.current;
    if (!entryId) return;
    let frame = 0;
    let raf = 0;
    const sectionKey = sections.find((item) =>
      item.rows.some((row) =>
        row.kind === "cluster"
          ? row.entries.some((e) => e.id === entryId)
          : row.entry.id === entryId,
      ),
    )?.key;
    const tick = () => {
      const target = document.querySelector<HTMLElement>(
        `[data-entry-id="${CSS.escape(entryId)}"]`,
      );
      if (target) {
        target.scrollIntoView({ block: "center" });
        pendingRevealIdRef.current = null;
        if (sectionKey) {
          setForcedSections((prev) => {
            if (!prev.has(sectionKey)) return prev;
            const next = new Set(prev);
            next.delete(sectionKey);
            return next;
          });
        }
        return;
      }
      if (frame++ < 20) raf = requestAnimationFrame(tick);
      else pendingRevealIdRef.current = null;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [forcedSections, expandedClusters, sections]);

  /** 轴上的卡片（顺序即键盘吸附顺序） */
  const selectableEntries = useMemo(
    () =>
      displayRows
        .filter((row): row is Extract<TimelineRow, { kind: "entry" }> => row.kind === "entry")
        .map((row) => row.entry),
    [displayRows],
  );

  // 只有「轴上条目集合」真的变了才回报给父级（否则每次渲染都 setState 会转圈）
  const selectableSignatureRef = useRef("");
  useEffect(() => {
    if (!onSelectableEntriesChange) return;
    const signature = selectableEntries.map((entry) => entry.id).join("\u0000");
    if (signature === selectableSignatureRef.current) return;
    selectableSignatureRef.current = signature;
    onSelectableEntriesChange(selectableEntries);
  }, [onSelectableEntriesChange, selectableEntries]);

  const toggleCluster = useCallback((key: string) => {
    setExpandedClusters((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * 33-2（用户 2026-09-26）：「把之前的通知视图的悬浮拿过来，放到吸顶那里，只有吸顶才会出现那个样式」。
   * 口径：非吸顶的日期行仍是现在这版裸文字；**只有正贴住吸顶线的那条**才带上 2423cda 那版的
   * 浮起背衬（`bg-background/85` + `backdrop-blur-md` + 底部 inset 1px 线），滚过去就还原。
   * 判定交给纯函数 `pickStuckDateKeys`（可单测），这里只负责量 rect 与挂滚动监听。
   */
  const [stuckDateKeys, setStuckDateKeys] = useState<readonly string[]>([]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    // 吸顶线 = 滚动容器的上沿；找不到滚动容器（文档滚动 / jsdom）时按视口顶算
    const findScroller = (): HTMLElement | null => {
      let el: HTMLElement | null = root.parentElement;
      while (el) {
        const overflowY = window.getComputedStyle(el).overflowY;
        if (/(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight + 1) {
          return el;
        }
        el = el.parentElement;
      }
      return null;
    };
    const scroller = findScroller();

    const measure = () => {
      const line = scroller ? scroller.getBoundingClientRect().top : 0;
      const probes = Array.from(
        root.querySelectorAll<HTMLElement>("[data-timeline-section]"),
      ).map((sectionEl) => {
        const sectionRect = sectionEl.getBoundingClientRect();
        const dateEl = sectionEl.querySelector<HTMLElement>("[data-timeline-date]");
        return {
          key: sectionEl.dataset.timelineSection ?? "",
          dateTop: dateEl
            ? dateEl.getBoundingClientRect().top
            : Number.POSITIVE_INFINITY,
          sectionTop: sectionRect.top,
          sectionBottom: sectionRect.bottom,
        };
      });
      const next = pickStuckDateKeys(probes, line);
      // 逐帧比一次：一样就返回原引用，避免滚动时把整条时间线重渲染
      setStuckDateKeys((prev) =>
        prev.length === next.length && prev.every((key, index) => key === next[index])
          ? prev
          : next,
      );
    };

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    measure();
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      target.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [sections]);

  const toggleEntry = useCallback((entryId: string) => {
    setExpandedEntries((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="notification-timeline"
      data-timeline-layout={singleSide ? "single" : "alternating"}
      // 40-2：真正的「空白」在列表列两侧的留白里（在时间线根之外），所以收起全部的
      // 触发由 `EntryList` 的滚动视口发事件，这里只监听（见下方 useEffect）。
      // 收窄到社交视图同款居中可读宽度（用户反馈：之前三栏中栏窄，现在两栏太宽）
      className="relative mx-auto w-full max-w-[clamp(45ch,60vw,65ch)]"
    >
      {/* 中轴：横跨整条时间线，1px */}
      <div
        aria-hidden="true"
        data-timeline-axis=""
        className="absolute bottom-3 top-3 z-0 w-px bg-border"
        style={{ left: singleSide ? SINGLE_SIDE_TIME_COLUMN : "50%" }}
      />

      {sections.map((section) => {
        const dateStuck = stuckDateKeys.includes(section.key);
        return (
        /* 每段一层容器 = sticky 的作用域：本段滚完，日期行被段底边推走，下一段接替 */
        <div key={section.key} data-timeline-section={section.key} className="relative">
          {/* 日期分隔行（用户 9-24 要吸顶 / 9-25 居中胶囊 → 2423cda 全宽条 → 2026-09-25
              复验后按用户「要最早那版：纯一行文字、无底色、无分隔线」回到 2423cda 之前那版）：
              只有一行文字（solid `bg-background` 小 pill 保住字底、无描边无投影），
              **非吸顶时**不加底条、不加分隔线、不加模糊 —— 保留 `sticky top-0` 吸顶；
              33-2（用户 2026-09-26）：「只有吸顶才会出现那个样式」⇒ 只有正吸顶的那条（`dateStuck`）
              才带上浮起样式，滚过去立刻还原。样式本身按用户二次校正取 **a96896d 那版胶囊**
              （见下面 span 上的分支），不是全宽背衬。
              文字位置与胶囊前一致 —— 单栏左对齐到卡片列左缘（时间列 86px 之后）、交替布局居中。
              仍是段内 sticky（本段滚完被段底推走，下一段接替），只有当前吸顶的那条会浮起。 */}
          <div
            data-timeline-date={section.label}
            data-timeline-date-stuck={dateStuck ? "true" : "false"}
            className={cn(
              "sticky top-0 z-10 flex items-center py-3",
              singleSide ? "justify-start pl-[86px]" : "justify-center",
            )}
          >
            {/* 34-2（用户 2026-09-26 二次校正）：「不是这个吸顶样式，是之前的胶囊悬浮吸顶样式」
                ⇒ 负吸顶那条的文字胶囊本身变成 a96896d 那版浮起胶囊
                （圆角 + 描边 + 95% 底 + 模糊 + 投影）；非吸顶仍是同一颗无描边无投影的素胶囊。
                位置按用户先前锁定「回到条目标题上方」不变（单栏贴卡片列左缘 / 交替居中），
                胶囊那版的 `mx-auto` 居中他当时否过；`top-2` 也没跟过来（吸顶瞬间不跳 8px）。 */}
            <span
              className={cn(
                "rounded-full text-[11.5px] font-semibold tabular-nums text-foreground transition-[background-color,box-shadow,border-color] duration-200 ease-[var(--ease-ios)]",
                dateStuck
                  ? // 投影用项目自己的浮层令牌 shadow-nf：a96896d 那版写的是任意值
                    // `shadow-[0_6px_16px_rgba(0,0,0,0.10)]`，实测在本项目的 Tailwind v4 里**不生效**
                    // （探针元素上也只算出 Tailwind 的复位值），所以那版当时其实是无投影的
                    "border border-border bg-background/95 px-3 py-[3px] shadow-nf backdrop-blur-md"
                  : "bg-background px-2",
              )}
            >
              {section.label}
            </span>
          </div>

          <TimelineLazyRows
            sectionKey={section.key}
            rowCount={section.rows.length}
            heights={rowsHeightsRef}
            forceMount={forcedSections.has(section.key)}
          >
            {() => section.rows.map((row) => {
        const dotLeft = singleSide ? `${SINGLE_SIDE_TIME_COLUMN}px` : "50%";
        const isLeft = row.side === "left";

        if (row.kind === "cluster") {
          const clusterExpanded = expandedClusters.has(row.key);
          const cluster = (
            <TimelineClusterCard
              count={row.count}
              feeds={row.entries.map(
                (entry) => feeds.get(entry.feedId)?.title ?? t("entry.unknown_feed"),
              )}
              expanded={clusterExpanded}
              onToggle={() => toggleCluster(row.key)}
            />
          );
          return (
            /* 58-2：折叠小节点里的条目**没有自己的 DOM 节点**（没渲染），滚动标已读
               就永远观察不到它们 —— 把被吸进来的 id 挂在簇行上，交给 useScrollMarkRead
               按「多 id 目标」处理（看到簇、簇再滚出顶部 → 整簇标已读）。
               展开后这些条目会各自渲染出 [data-entry-id]，此时不能再挂这个属性，
               否则簇头部滚出时会把下面还没滚到的展开条目一起标掉。 */
            <div
              key={row.key}
              data-timeline-row="cluster"
              data-cluster-entry-ids={
                clusterExpanded
                  ? undefined
                  : row.entries.map((entry) => entry.id).join(",")
              }
              className={cnRow(singleSide)}
            >
              <TimelineDot
                node="minor"
                unread={row.entries.some((entry) => !entry.read)}
                left={dotLeft}
              />
              {singleSide ? (
                <>
                  <span />
                  <div className="min-w-0 pb-2 pl-3">{cluster}</div>
                </>
              ) : (
                <>
                  {isLeft ? <div className="min-w-0 px-1 pb-2">{cluster}</div> : <span />}
                  <span />
                  {!isLeft ? <div className="min-w-0 px-1 pb-2">{cluster}</div> : <span />}
                </>
              )}
            </div>
          );
        }

        const entry = row.entry;
        const card = (
          <TimelineCard
            entry={entry}
            feed={feeds.get(entry.feedId)}
            feedUnreadCount={unreadCounts?.[entry.feedId]}
            isSelected={entry.id === selectedEntryId}
            side={row.side}
            node={row.node}
            bucketCount={row.bucketCount}
            clampLines={clampLines}
            autoExpandLongEntry={hoverMode ? false : isAutoExpanded(entry.id)}
            onNaturalHeightChange={hoverMode ? undefined : handleNaturalHeightChange}
            expanded={
              hoverMode
                ? false
                : expandedEntries.has(entry.id) ||
                  entry.id === selectedEntryId ||
                  isAutoExpanded(entry.id)
            }
            onToggleExpand={toggleEntry}
            onSelect={handleSelect}
            onSelectFeedFromEntry={onSelectFeedFromEntry}
            bodyOnHover={hoverMode}
            onHoverEnter={hoverMode ? openHover : undefined}
            onHoverLeave={hoverMode ? scheduleHoverClose : undefined}
            onMarkAbove={
              onMarkAboveEntry
                ? () => onMarkAboveEntry(entry.id)
                : undefined
            }
            fullHeight={
              fullHeights[entry.id] ?? TIMELINE_FULL_DEFAULT_HEIGHT
            }
            onFullHeightChange={handleFullHeightChange}
            onCollapse={handleCollapse}
            autoTranslate={autoTranslate}
            targetLanguage={targetLanguage}
          />
        );

        return (
          <div
            key={row.key}
            data-timeline-row={row.node}
            className={cnRow(singleSide)}
          >
            <TimelineDot node={row.node} unread={!entry.read} left={dotLeft} />

            {singleSide ? (
              <>
                {/* 单侧：时间列在轴左边、右对齐 —— 时间戳右缘紧贴节点左缘；
                    C-②：76px 列只留 HH:MM（日期看跨天分隔头）+ nowrap，390 下不再挤两行 */}
                <div className="flex justify-end pr-2 pt-[11px]">
                  <span
                    data-timeline-time=""
                    className={cn(
                      "whitespace-nowrap tabular-nums",
                      row.node === "major"
                        ? "text-[11px] font-semibold text-foreground"
                        : "text-[10.5px] text-muted-foreground",
                    )}
                  >
                    {row.shortLabel}
                  </span>
                </div>
                <div className="min-w-0 pb-2.5 pl-3">{card}</div>
              </>
            ) : (
              <>
                {isLeft ? <div className="min-w-0 px-1 pb-2.5">{card}</div> : <span />}
                {/* 交替：时间戳挂在节点正下方（紧贴） */}
                <div
                  className="flex justify-center"
                  style={{
                    paddingTop:
                      NODE_TOP_OFFSET +
                      (row.node === "major" ? TIMELINE_DOT_MAJOR : TIMELINE_DOT_MINOR) +
                      TIME_GAP_AFTER_NODE,
                  }}
                >
                  <span
                    data-timeline-time=""
                    className={cn(
                      "whitespace-nowrap tabular-nums",
                      row.node === "major"
                        ? "text-[11px] font-semibold text-foreground"
                        : "text-[10.5px] text-muted-foreground",
                    )}
                  >
                    {row.label}
                  </span>
                </div>
                {!isLeft ? <div className="min-w-0 px-1 pb-2.5">{card}</div> : <span />}
              </>
            )}
          </div>
        );
            })}
          </TimelineLazyRows>
        </div>
        );
      })}
      {/* 悬停正文浮块 —— hoverMode 下常挂（无 key、不卸载）：换条目只换 entry，
          无悬停时 entry=null + visible=false 藏起（scale 0 + 透明 + 点穿） */}
      {hoverMode
        ? (() => {
            const hoverEntry = hoverAnchor
              ? (entries.find((item) => item.id === hoverAnchor.id) ?? null)
              : null;
            return (
              <NotificationBodyPreview
                entry={hoverEntry}
                visible={hoverEntry !== null}
                anchor={
                  hoverAnchor
                    ? {
                        x: hoverAnchor.x,
                        y: hoverAnchor.y,
                        cardTop: hoverAnchor.cardTop,
                        cardBottom: hoverAnchor.cardBottom,
                      }
                    : { x: 0, y: 0, cardTop: null, cardBottom: null }
                }
                feedName={
                  hoverEntry
                    ? (feeds.get(hoverEntry.feedId)?.title ??
                      t("entry.unknown_feed"))
                    : ""
                }
                feed={hoverEntry ? feeds.get(hoverEntry.feedId) : undefined}
                autoTranslate={autoTranslate}
                targetLanguage={targetLanguage}
                onMouseEnter={cancelHoverClose}
                onMouseLeave={scheduleHoverClose}
              />
            );
          })()
        : null}
    </div>
  );
}
