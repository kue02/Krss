import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Star } from "lucide-react";
import { Ripple } from "m3-ripple";
import { Chip } from "@heroui/react";
import { cn } from "@/lib/utils";
import { stripHtml } from "@/lib/html-utils";
import { FeedIcon } from "@/components/ui/feed-icon";
import { ArticleContent } from "@/components/ui/article-content";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { EntryContextMenuContent } from "./EntryListItem";
import { UnreadIndicator, unreadRowClass } from "./unread-indicator";
import { useMarkAsRead } from "@/hooks/useEntries";
import { deferEntryRemoval } from "./deferred-removal";
import { useUISettingKey } from "@/hooks/useUISettings";
import { useTranslationStore } from "@/stores/translation-store";
import {
  buildTimelineRows,
  expandTimelineRows,
  isSingleSideWidth,
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
 * 形态（用户已拍板，效果图 `~/Documents/test/gist-nextflux-ui/mockups/notification-timeline.html`）：
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
  onToggleExpand: (entryId: string) => void;
  onSelect: (entryId: string) => void;
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
  onToggleExpand,
  onSelect,
  onMarkAbove,
  fullHeight,
  onFullHeightChange,
  onCollapse,
  autoTranslate,
  targetLanguage,
}: TimelineCardProps) {
  const { t } = useTranslation();
  const [iconError, setIconError] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [isClipped, setIsClipped] = useState(false);
  const unreadStyle = useUISettingKey("unreadStyle");
  const showIcon = feed?.iconPath && !iconError;
  const isUnread = !entry.read;

  const translation = useTranslationStore((state) =>
    autoTranslate && targetLanguage
      ? state.getTranslation(entry.id, targetLanguage)
      : undefined,
  );
  const displayTitle = translation?.title ?? entry.title;

  /**
   * 折叠态显示**纯文字预览**（与「展开后仍是同一段文字、只是不再截断」同一份内容，
   * 就地展开因此只是把 clamp 摘掉，不会换一套 DOM、也不会把轴顶偏）。
   */
  const previewText = useMemo(() => {
    const raw = entry.content ? stripHtml(entry.content) : "";
    const text = raw.replace(/\s+/g, " ").trim();
    return text || (displayTitle ?? "");
  }, [entry.content, displayTitle]);

  // 折叠态下正文是否真的被截断（用 scrollHeight 判定，图片异步加载会改高度 → 复测一次）
  useEffect(() => {
    const node2 = bodyRef.current;
    if (!node2 || clampLines === null) {
      setIsClipped(false);
      return;
    }
    const measure = () => setIsClipped(node2.scrollHeight > node2.clientHeight + 1);
    measure();
    const retry = setTimeout(measure, 400);
    return () => clearTimeout(retry);
  }, [previewText, clampLines]);

  const canExpand = clampLines !== null;
  const showToggle = canExpand && (isClipped || expanded);
  const feedName = feed?.title || t("entry.unknown_feed");
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
          onClick={() => onSelect(entry.id)}
          className={cn(
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
                  src={`/icons/${feed?.iconPath}`}
                  alt=""
                  width={18}
                  height={18}
                  loading="lazy"
                  decoding="async"
                  className="size-[18px] shrink-0 rounded-[var(--ui-icon-radius,3px)] object-contain"
                  onError={() => setIconError(true)}
                />
              ) : (
                <FeedIcon className="size-[18px] shrink-0 text-muted-foreground/50" />
              )}
            </UnreadIndicator>
            <span className="min-w-0 truncate font-medium text-foreground/80">
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
              {entry.starred && <Star className="size-3 fill-amber-500 text-amber-500" />}
              {entry.muted && (
                <span className="rounded-[3px] border border-border/60 bg-secondary/40 px-1 py-px text-[10px] leading-4">
                  {t("automation.muted_badge")}
                </span>
              )}
            </span>
          </div>

          {/* 标题（时间戳在轴上、紧贴节点，所以卡片里不再重复时间） */}
          <div
            className={cn(
              "mt-1 line-clamp-2 text-[13.5px] font-semibold leading-5 wrap-anywhere",
              isUnread ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {displayTitle || t("entry.untitled")}
          </div>

          {/* 24-8：展开态 = 正文级完整渲染（标题/图片/全文按阅读区管道排版），
              居中可读宽度、固定高度容器 + 内部滚动 —— 再长的正文也不挤下面的条目 */}
          {expanded && hasFullContent ? (
            <div className="mt-2">
              <div className="mx-auto w-full max-w-[clamp(45ch,60vw,65ch)]">
                <div className="relative">
                  <div
                    ref={bodyRef}
                    data-timeline-full={entry.id}
                    data-timeline-full-height={fullHeight}
                    onClick={(event) => event.stopPropagation()}
                    className="entry-content reading-prose prose prose-sm dark:prose-invert max-w-none break-words overflow-y-auto overscroll-y-contain rounded-lg border border-border/60 p-3"
                    style={{ height: fullHeight }}
                  >
                    <ArticleContent
                      content={entry.content ?? ""}
                      articleUrl={entry.url}
                    />
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
              {/* 正文预览：折叠态 clamp 到设置的行数 */}
              {previewText && (
                <div
                  ref={bodyRef}
                  data-timeline-body={clampLines === null ? "full" : String(clampLines)}
                  className={cn(
                    "mt-1 text-[12.5px] leading-5 text-muted-foreground wrap-anywhere",
                    !isUnread && "text-muted-foreground/70",
                  )}
                  style={
                    clampLines !== null && !expanded
                      ? {
                          display: "-webkit-box",
                          WebkitBoxOrient: "vertical",
                          WebkitLineClamp: clampLines,
                          overflow: "hidden",
                        }
                      : undefined
                  }
                >
                  {previewText}
                </div>
              )}

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
      <EntryContextMenuContent entry={entry} onMarkAbove={onMarkAbove} />
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
  /** 时间基准（默认发布时间，现状不动；EntryList 里 resolve 后传进来） */
  timeBasis?: TimelineTimeBasis;
  collapse: TimelineCollapse;
  /** 窄栏自动合一栏（默认开；关掉则始终左右交替） */
  autoSingleSide?: boolean;
  autoTranslate: boolean;
  targetLanguage: string;
  /**
   * 把「轴上的卡片」（不含被吸进小节点的条目）回报给父级 ——
   * 键盘 j/k、↑/↓ 就在这些节点之间吸附，不会选到看不见的条目。
   */
  onSelectableEntriesChange?: (entries: Entry[]) => void;
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
  timeBasis = "published",
  collapse,
  autoSingleSide = true,
  autoTranslate,
  targetLanguage,
  onSelectableEntriesChange,
}: NotificationTimelineProps) {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const width = useContainerWidth(containerRef);
  const singleSide = autoSingleSide && isSingleSideWidth(width);
  const clampLines = timelineCollapseClampLines(collapse);

  const [expandedClusters, setExpandedClusters] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedEntries, setExpandedEntries] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
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

  // 24-8：收起 —— 手动展开的摘掉展开态；选中展开的把选中交回列表
  const handleCollapse = useCallback(
    (entryId: string) => {
      setExpandedEntries((current) => {
        if (!current.has(entryId)) return current;
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
      if (selectedEntryId === entryId) onCloseEntry?.();
    },
    [selectedEntryId, onCloseEntry],
  );

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

  // 换粒度 / 换时间基准 / 换列表时收起来，免得「展开态」跟着另一批数据走
  useEffect(() => {
    setExpandedClusters(new Set());
  }, [granularity, timeBasis, entries]);

  const rows = useMemo(
    () =>
      buildTimelineRows(entries, {
        granularity,
        timeBasis,
        t,
        locale: i18n.language,
      }),
    [entries, granularity, timeBasis, t, i18n.language],
  );

  const displayRows = useMemo(
    () => expandTimelineRows(rows, expandedClusters, timeBasis),
    [rows, expandedClusters, timeBasis],
  );

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

      {displayRows.map((row) => {
        if (row.kind === "date") {
          return (
            <div
              key={row.key}
              data-timeline-date={row.label}
              className={cn(
                // 日期分隔行吸顶：划过顶部时固定，内容从下面滑过
                "sticky top-0 z-[1] flex items-center bg-background py-3",
                singleSide ? "justify-start pl-[86px]" : "justify-center",
              )}
            >
              <span className="rounded-full bg-background px-2 text-[11.5px] font-semibold tabular-nums text-foreground">
                {row.label}
              </span>
            </div>
          );
        }

        const dotLeft = singleSide ? `${SINGLE_SIDE_TIME_COLUMN}px` : "50%";
        const isLeft = row.side === "left";

        if (row.kind === "cluster") {
          const cluster = (
            <TimelineClusterCard
              count={row.count}
              feeds={row.entries.map(
                (entry) => feeds.get(entry.feedId)?.title ?? t("entry.unknown_feed"),
              )}
              expanded={expandedClusters.has(row.key)}
              onToggle={() => toggleCluster(row.key)}
            />
          );
          return (
            <div key={row.key} data-timeline-row="cluster" className={cnRow(singleSide)}>
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
            expanded={
              expandedEntries.has(entry.id) || entry.id === selectedEntryId
            }
            onToggleExpand={toggleEntry}
            onSelect={handleSelect}
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
    </div>
  );
}
