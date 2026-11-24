import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  useEntriesInfinite,
  useUnreadCounts,
  useMarkManyAsRead,
  useMarkAsRead,
} from "@/hooks/useEntries";
import { AlertDialog, Button } from "@heroui/react";
import { useFeeds } from "@/hooks/useFeeds";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import { useEntryPrefetch } from "@/hooks/useEntryPrefetch";
import { useListTranslations } from "@/hooks/useListTranslations";
import { useListSummaryStatuses } from "@/hooks/useListSummaryStatuses";
import { useRefreshStatus } from "@/hooks/useRefreshStatus";
import { queryClient } from "@/lib/queryClient";
import { requestEntriesHeadSync } from "@/lib/entries-head-sync";
import { getRefreshStatus, refreshAllFeeds, refreshFeeds } from "@/api";
import { showToast } from "@/stores/toast-store";
import { useFolders } from "@/hooks/useFolders";
import { useAISettings } from "@/hooks/useAISettings";
import { useSwipeGesture } from "@/hooks/useSwipeGesture";
import { selectionToParams, type SelectionType } from "@/hooks/useSelection";
import { flattenUniqueEntries } from "@/lib/entry-pagination";
import { stripHtml } from "@/lib/html-utils";
import { EntryListItem } from "./EntryListItem";
import { ArticleRowsListRow } from "./ArticleRowsList";
import { ArticlePlainListRow } from "./ArticlePlainList";
import { MobileSwipeEntryRow } from "@/components/mobile/MobileSwipeEntryRow";
import { EntryListHeader } from "./EntryListHeader";
import { needsListTranslation as needsListTranslationAsync } from "@/lib/language-detect-async";
import {
  translateArticlesBatch,
  cancelAllBatchTranslations,
} from "@/services/translation-service";
import { translationActions } from "@/stores/translation-store";
import { selectionScrollKey, entryListScrollPositions } from "./scroll-key";
import { useScrollToTop } from "@/hooks/useScrollToTop";
import { MobileDocumentHeader } from "@/components/layout/MobileDocumentHeader";
import { cn } from "@/lib/utils";
import {
  useVirtualizedArticleList,
  VIRTUAL_PLAIN_ROW_ESTIMATE_PX,
} from "./useVirtualizedArticleList";
import { VirtualizedArticleList } from "./VirtualizedArticleList";
import { useScrollMarkRead } from "./useScrollMarkRead";
import { usePrependScrollAnchor } from "./usePrependScrollAnchor";
import {
  deferEntryRemoval,
  getDeferredRemovalsVersion,
  mergeDeferredRemovals,
  subscribeDeferredRemovals,
} from "./deferred-removal";
import { useEntryListScrollSurface } from "./scroll-surface";
import { useEntryHotkeys } from "@/hooks/useEntryHotkeys";
import {
  useUISettingKey,
  useUISettingActions,
  resolveExperimentalLayoutVisibility,
} from "@/hooks/useUISettings";
import {
  resolveTimelineCollapse,
  resolveTimelineGranularity,
  resolveTimelineTimeBasis,
} from "@/lib/timeline-model";
import {
  COLLAPSE_ALL_EVENT,
  NotificationTimeline,
} from "./NotificationTimeline";
import { NotificationBodyPreview } from "./NotificationBodyPreview";
import { useScrollReadSetting } from "@/hooks/useScrollReadSetting";
import { useFilterViewStore } from "@/stores/filter-view-store";
import { MobilePullToRefresh } from "@/components/mobile/MobilePullToRefresh";
import { MobileEntryActions } from "@/components/mobile/MobileEntryActions";
import { ArrowUp, Check, Inbox } from "lucide-react";
import type { Entry, Feed, Folder, ContentType } from "@/types/api";

/** 刚点刷新时后端可能还没开始跑，这段宽限期内先别宣布「刷完了」（毫秒） */
const REFRESH_START_GRACE_MS = 1500;
/** 兜底：再久也不让按钮一直转（毫秒） */
const REFRESH_MAX_WAIT_MS = 180_000;

/**
 * 强制拉取时，范围超过这个数就先弹确认（用户 11-19：「如果当前范围太多（有可能是误选），
 * 要谈个确认框」）。20 是个经验值：单个源 / 小分类不会被打断，全量（几十上百个源）才拦一下。
 */
const FORCE_REFRESH_CONFIRM_THRESHOLD = 20;

/** 列表筛选态（星标 / 未读 / 全部）；底部胶囊已移除，仅作请求参数与视图判断。 */
type EntryFilter = "all" | "unread" | "starred";

interface EntryListProps {
  selection: SelectionType;
  selectedEntryId: string | null;
  onSelectEntry: (entryId: string) => void;
  /** Esc 关闭详情（交回列表） */
  onCloseEntry?: () => void;
  onMarkAllRead: () => void;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  /** 12-6：星标视图下的「只查看当前视图」开关（与侧栏那个是同一个语义） */
  onToggleStarredViewOnly?: () => void;
  contentType: ContentType;
  isMobile?: boolean;
  onMenuClick?: () => void;
  isTablet?: boolean;
  onToggleSidebar?: () => void;
  sidebarVisible?: boolean;
  isActive?: boolean;
  /**
   * 52-4：点条目的「订阅源名称/图标」→ 第一栏选中该订阅（由 App 透传 `selectFeed` 那条路）。
   * 不传则来源行保持原样（不可点）—— 单测与其它调用点零变化。
   */
  onSelectFeedFromEntry?: (feedId: string) => void;
  /** 52-4：这次跳来自哪个订阅（非 null 时列表头出「返回」） */
  feedJumpBackHref?: string | null;
  onBackFromFeedJump?: () => void;
  /** 移动端顶栏搜索入口（App 打开 SearchModal）；不传不渲染 */
  onSearchClick?: () => void;
  /**
   * 「正文推入方向 = 向下」的合列形态（方案 2 · 整列一起滚）：
   * 正文接在被点那一行后面、与该行之后的条目共用同一条滚动条。传的是渲染函数而不是节点，
   * 因为内嵌正文要拿本列表的滚动容器（`embedded` 模式的 `containerRef`）
   * 才能让工具栏吸顶判断跟列表滚动走。不传则列表不带内联正文。
   */
  renderInlineContent?: (
    scrollRef: RefObject<HTMLDivElement | null>,
    options: { headerStickyTop: string },
  ) => ReactNode;
}

export function EntryList({
  selection,
  selectedEntryId,
  onSelectEntry,
  onCloseEntry,
  onMarkAllRead,
  unreadOnly,
  onToggleUnreadOnly,
  contentType,
  isMobile,
  onMenuClick,
  isTablet,
  onToggleSidebar,
  sidebarVisible,
  isActive = true,
  onToggleStarredViewOnly,
  onSelectFeedFromEntry,
  feedJumpBackHref,
  onBackFromFeedJump,
  onSearchClick,
  renderInlineContent,
}: EntryListProps) {
  "use no memo";

  const { t } = useTranslation();
  /**
   * 「已静音」是独立的回看态（2026-09-17 起入口在 设置 → 自动化）。
   *
   * 星标 / 未读对应路由里的 selection 与 unreadOnly；「已静音」没有对应的
   * 路由维度（路由参数不该为一个回看视图扩容），所以由 filter-view-store 承载，
   * 只体现在 listEntries 的 mutedOnly 参数上。切到别的订阅 / 视图 / 已读态时自动退出。
   */
  const mutedOnly = useFilterViewStore((state) => state.mutedOnly);
  const setMutedOnly = useFilterViewStore((state) => state.setMutedOnly);

  /**
   * 「已静音」是**全局回看**：静音条目可能属于任何内容类型（文章 / 社交媒体 / 通知…），
   * 中栏此刻停在哪个标签不该把它藏起来 —— 所以这一态**不带 contentType**。
   * 实测依据：`/api/entries?mutedOnly=true` 返回 2 条，加上 `contentType=article` 返回 0 条
   * （那 2 条属于别的内容类型），用户点「查看已静音」就会看到一片空。
   */
  const params = selectionToParams(selection, mutedOnly ? undefined : contentType);
  /**
   * 保存筛选视图（设置 → 自动化 里建的「范围 + 条件」）：侧栏点一下就叠加到当前列表上。
   * 与「已静音」同一套本地状态的理由 —— 它不是一个导航维度，选中时若列表作用域
   * （订阅/分类/内容类型/已读态）变了就自动退出，免得带着别人的筛法看新列表。
   */
  const activeViewId = useFilterViewStore((state) => state.viewId);
  const activeViewName = useFilterViewStore((state) => state.viewName);
  const viewUnreadCount = useFilterViewStore((state) => state.viewUnreadCount);
  const viewScopeKey = useFilterViewStore((state) => state.scopeKey);
  const clearView = useFilterViewStore((state) => state.clearView);
  const selectionScopeKey = useMemo(() => {
    switch (selection.type) {
      case "feed":
        return `feed:${selection.feedId}`;
      case "folder":
        return `folder:${selection.folderId}`;
      default:
        return selection.type;
    }
  }, [selection]);
  useEffect(() => {
    setMutedOnly(false);
  }, [selectionScopeKey, contentType, unreadOnly]);
  useEffect(() => {
    if (!activeViewId || !viewScopeKey) return;
    if (viewScopeKey !== `${selectionScopeKey}:${contentType}`) {
      clearView();
    }
  }, [
    activeViewId,
    viewScopeKey,
    selectionScopeKey,
    contentType,
    clearView,
  ]);

  // 列表筛选态（星标 > 未读 > 全部）。「已静音」是独立回看入口（设置 → 自动化），状态见 mutedOnly
  const filterValue: EntryFilter =
    selection.type === "starred"
      ? "starred"
      : unreadOnly
        ? "unread"
        : "all";
  // 「已静音」是独立的回看视图，不叠加「只看未读」——否则规则静音前已读的条目就回看不到了
  const effectiveUnreadOnly = mutedOnly ? false : unreadOnly;

  const containerRef = useRef<HTMLDivElement>(null);
  /** 「向下」合列模式下接在「被点那一行」后面的正文块（点条目后要滚到它） */
  const inlineContentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const listWrapperRef = useRef<HTMLDivElement>(null);
  const usesDocumentScroll = Boolean(isMobile);
  /**
   * 非虚拟列表（社媒 / 通知时间线）：直接交给浏览器原生 scroll anchoring。
   *
   * 2026-11-01 用户「还是不行」的根因就在这里：`overflow-anchor:none` 把浏览器
   * 自带的补偿关掉之后，只能靠 `usePrependScrollAnchor` 的 JS 兜底 —— 它拿的是
   * 上一帧量到的锚点坐标，图片/翻译异步撑高、或者锚点条目被换掉之后，那串旧坐标
   * 会被当成「应该在哪」反复拉，于是整块往下走一段就停住（用户看到的形态）。
   * 原生 anchoring 和布局在同一帧里补偿，不存在这个时间差。
   *
   * 虚拟化文章列表仍走 JS 补偿 —— 行是按 `estimateSize` 绝对定位的，插入新条目会让
   * 所有行整体平移、总高度却可能不变，Chrome 的 anchoring 认不出这种「垫片内位移」
   * （实测 3 条 148px 估计行 = 下移 444px 且没人补）。
   */
  const nativeScrollAnchor = contentType !== "article";
  const scrollSurface = useEntryListScrollSurface({
    documentScroll: usesDocumentScroll,
    containerRef,
    headerRef,
  });
  /**
   * 平滑回顶时会临时关掉「内容位移兜底」：兜底里的 scrollBy 会打断 smooth 动画
   * （实测 Toast 点回顶停在原处，就是被 0.5px 的兜底补正掐断的）。
   */
  const anchorStabilizePausedRef = useRef(false);
  const anchorPauseTimerRef = useRef<number | null>(null);
  /** Toast 的「跳到新条目」用瞬时滚动：smooth 在兜底/RO 共存时容易被抢断 */
  const jumpToTop = useCallback(() => {
    anchorStabilizePausedRef.current = true;
    if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
      console.log("[krss-anchor] jumpToTop before", scrollSurface.getScrollTop());
    }
    scrollSurface.scrollTo(0, "auto");
    requestAnimationFrame(() => {
      anchorStabilizePausedRef.current = false;
      if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
        console.log("[krss-anchor] jumpToTop after", scrollSurface.getScrollTop());
      }
    });
  }, [scrollSurface]);

  const scrollToTop = useCallback(() => {
    // 同步置位（不能靠 setState，兜底会赶在 React 渲染前把 smooth 动画掐断）
    anchorStabilizePausedRef.current = true;
    scrollSurface.scrollTo(0, "smooth");
    if (anchorPauseTimerRef.current !== null) {
      window.clearTimeout(anchorPauseTimerRef.current);
    }
    anchorPauseTimerRef.current = window.setTimeout(() => {
      anchorPauseTimerRef.current = null;
      anchorStabilizePausedRef.current = false;
    }, 1300);
  }, [scrollSurface]);

  useEffect(
    () => () => {
      if (anchorPauseTimerRef.current !== null) {
        window.clearTimeout(anchorPauseTimerRef.current);
      }
    },
    [],
  );

  useScrollToTop(scrollToTop, "entrylist", isActive);

  const handleMenuClick = useCallback(() => {
    entryListScrollPositions.set(
      selectionScrollKey(selection, contentType),
      scrollSurface.getScrollTop(),
    );
    onMenuClick?.();
  }, [contentType, onMenuClick, scrollSurface, selection]);

  const { data: feeds = [] } = useFeeds();
  const { data: folders = [] } = useFolders();
  const { data: aiSettings } = useAISettings();
  const { data: unreadCounts } = useUnreadCounts();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useEntriesInfinite({
      ...params,
      unreadOnly: effectiveUnreadOnly,
      // 选中的筛选视图：作用域与条件都由视图携带（后端按视图取数）
      ...(activeViewId ? { viewId: activeViewId } : {}),
      // 「已静音」才传 mutedOnly；星标视图带上静音条目（用户显式收藏的内容不该被规则藏起来）；
      // 其余状态不传 includeMuted（默认就是隐藏静音条目）
      ...(mutedOnly
        ? { mutedOnly: true }
        : filterValue === "starred"
          ? { includeMuted: true }
          : {}),
    });

  // Swipe gesture: Right swipe opens sidebar (only on mobile)
  useSwipeGesture(listWrapperRef, {
    onSwipeRight: handleMenuClick,
    enabledDirections: ["right"],
    threshold: 100,
    preventScroll: true,
    startFrom: { left: 32 },
    enabled: Boolean(isMobile && onMenuClick),
  });

  // Track translated entries to avoid re-translating
  const translatedEntries = useRef(new Set<string>());
  const pendingTranslation = useRef(new Map<string, Entry>());
  const pendingDetection = useRef(new Set<string>());
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const translationSession = useRef(0);

  const autoTranslate = aiSettings?.autoTranslate ?? false;

  // 订阅级覆盖：feed.autoTranslate 有值就盖过全局（#5）
  const feedsById = useMemo(
    () => new Map(feeds.map((feed) => [feed.id, feed])),
    [feeds],
  );
  const hasAutoTranslateOverride = useMemo(
    () => feeds.some((feed) => feed.autoTranslate === true),
    [feeds],
  );
  const isAutoTranslateEnabled = useCallback(
    (entry: Entry) =>
      feedsById.get(entry.feedId)?.autoTranslate ?? autoTranslate,
    [autoTranslate, feedsById],
  );
  const targetLanguage = aiSettings?.summaryLanguage ?? "zh-CN";
  // 按视图（文章 / 图片 / 通知）的独立开关：自动展开正文、覆盖滚动标已读

  // 「滚动标已读」的开关解析已收口到 useScrollReadSetting（总开关三态 + 按视图覆盖 + 判定联动）
  const { resolveFor: resolveScrollRead } = useScrollReadSetting();
  const scrollReadTimingByView = useUISettingKey("scrollReadTimingByView");
  /** 20-3：滚动标已读后「不实时摘掉」（默认开）——摘除推迟到离开这个列表时 */
  const scrollReadDeferRemoval = useUISettingKey("scrollReadDeferRemoval");
  // 社交媒体是第四类内容（与文章 / 图片 / 通知并列），不是文章视图的另一种排布
  const isSocialView = contentType === "social";
  /**
   * 第十五批：通知视图改成**时间线**（15-1 硬边界：只作用于 notification）。
   * 与 `isSocialView` 同一处判断 —— 别的视图一行不动。
   * 形态只有这一种（用户定案：通知视图没有「切回卡片列表」这回事），
   * 设置里能调的只有粒度与折叠行数（15-5）。
   */
  const isNotificationTimeline = contentType === "notification";
  /**
   * 文章视图 hover 档（reader-transition 批新增为「悬停大图」；31-2 改成「悬停正文」）：
   * 行还是普通文章卡片（`EntryListItem` 一行不动，含缩略图/标题/摘要），
   * **悬停时浮块显示这一条的完整正文**（复用 29-1 那套浮块：跟随指针、不遮标题、可滚可选中），
   * 点击行照旧打开正文（第三栏阅读器）。
   *
   * 用户原话（2026-09-25）：「文章视图的悬停大图，鼠标悬浮上去的时候，它也应该显示文章。
   * 当点击的时候，正好弹出正文页面。因为文章是图，展示图片没什么用处。」
   *
   * 为什么用容器事件委托而不是给 `EntryListItem` 加 onMouseEnter：
   * 那是全仓最大的热点文件，且同一份行还要服务时间线/社交/列表三条路径；
   * 委托只认行上的 `data-entry-id`，对行本身零改动（图片视图的 hover 档不动，
   * 它仍走 PictureHoverList + hover-img 原件）。
   */
  const articleLayout = useUISettingKey("articleLayout");
  const isArticleHover = contentType === "article" && articleLayout === "hover";
  /**
   * 实验布局批：文章「缩略图列表」档（带 64×64 缩略图的紧凑行，无悬停浮层）。
   * 常规「Inoreader列表」是另一档（`isArticlePlain`），别混。
   */
  const isArticleRows = contentType === "article" && articleLayout === "rows";
  /** 常规「Inoreader列表」：来源图标 + 加粗标题 + 右侧来源·时间，无缩略图 */
  const isArticlePlain =
    contentType === "article" && articleLayout === "inoreader";
  /** 「正文推入方向 = 向下」：条目栏与正文合为一列，正文接在被点那一行后面（方案 2） */
  const articlePushDirection = useUISettingKey("articlePushDirection");
  const isArticleInline =
    contentType === "article" && articlePushDirection === "down";
  /** 实验布局批：文章相关实验入口的可见性（关闭即隐藏，已选中仍照常渲染） */
  const articleExpVisibility = resolveExperimentalLayoutVisibility({
    experimentalFeaturesEnabled: useUISettingKey("experimentalFeaturesEnabled"),
    experimentalPictureHover: useUISettingKey("experimentalPictureHover"),
    experimentalPictureWall: useUISettingKey("experimentalPictureWall"),
    experimentalArticleHover: useUISettingKey("experimentalArticleHover"),
    experimentalArticleRows: useUISettingKey("experimentalArticleRows"),
  });
  /**
   * 实验布局批：文章顶栏可切换档位（按实验可见性过滤）。
   * 常规 = 传统三栏 + 列表；「悬停正文」仅在对应实验开关打开时进入循环。
   * 只剩一档 → 不渲染切换按钮（由 EntryListHeader 据 order.length>1 判断）。
   */
  const articleLayoutOrder = useMemo<
    Array<"list" | "inoreader" | "rows" | "hover">
  >(() => {
    /* 常规两档永远在：传统三栏 → Inoreader列表（默认顺序按用户点名的那样） */
    const order: Array<"list" | "inoreader" | "rows" | "hover"> = [
      "list",
      "inoreader",
    ];
    /* 实验两档：只按开关进循环 —— 关掉就从选择器与顶栏一起消失。
       正用着已停用的档时不再把它塞回来（那是「入口泄漏」），
       保留渲染 + 列表顶部逃生条负责把人带回常规档。 */
    if (articleExpVisibility.articleRows) {
      order.push("rows");
    }
    if (articleExpVisibility.articleHover) {
      order.push("hover");
    }
    return order;
  }, [
    articleExpVisibility.articleHover,
    articleExpVisibility.articleRows,
  ]);
  /** 实验布局批：正用着已停用的实验档（悬停正文 / 缩略图列表）——保留渲染，给一条「切回常规」逃生条 */
  const showDisabledArticleHoverNotice =
    contentType === "article" &&
    ((articleLayout === "hover" && !articleExpVisibility.articleHover) ||
      (articleLayout === "rows" && !articleExpVisibility.articleRows));
  const [articleHoverAnchor, setArticleHoverAnchor] = useState<{
    id: string;
    x: number;
    y: number;
    cardTop: number;
    cardBottom: number;
  } | null>(null);
  const articleHoverCloseTimer = useRef<number | null>(null);
  const cancelArticleHoverClose = useCallback(() => {
    if (articleHoverCloseTimer.current !== null) {
      window.clearTimeout(articleHoverCloseTimer.current);
      articleHoverCloseTimer.current = null;
    }
  }, []);
  /** 离开行后延迟 250ms 再收 —— 留出「把指针移进浮块继续看/选中正文」的时间 */
  const closeArticleHoverSoon = useCallback(() => {
    cancelArticleHoverClose();
    articleHoverCloseTimer.current = window.setTimeout(() => {
      articleHoverCloseTimer.current = null;
      setArticleHoverAnchor(null);
    }, 250);
  }, [cancelArticleHoverClose]);
  const handleArticleHoverOver = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as Element | null;
      const row = target?.closest?.("[data-entry-id]");
      const id = row?.getAttribute("data-entry-id");
      if (!row || !id) return;
      const rect = row.getBoundingClientRect();
      cancelArticleHoverClose();
      setArticleHoverAnchor((prev) =>
        prev &&
        prev.id === id &&
        Math.abs(prev.x - event.clientX) < 2 &&
        Math.abs(prev.y - event.clientY) < 2
          ? prev
          : {
              id,
              x: event.clientX,
              y: event.clientY,
              cardTop: rect.top,
              cardBottom: rect.bottom,
            },
      );
    },
    [cancelArticleHoverClose],
  );
  const handleArticleHoverOut = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const next = event.relatedTarget as Element | null;
      // 移到另一行 ⇒ 交给 mouseover 换内容；彻底离开列表/移到浮块 ⇒ 延后收
      if (next?.closest?.("[data-entry-id]")) return;
      closeArticleHoverSoon();
    },
    [closeArticleHoverSoon],
  );

  /** 28-1：顶栏左上角那颗文章档位切换（只有文章视图会拿到它）。
   *  实验布局批：在「可见档位」里循环（传统三栏 → Inoreader列表 → [缩略图列表] → [悬停正文]）；
   *  后两档仅在对应实验开关打开时进入循环。 */
  const {
    setArticleLayout,
    setInoreaderSplitterPromptShown,
    hideArticleSplitterFromPrompt,
  } = useUISettingActions();
  const handleToggleArticleLayout = useCallback(() => {
    const idx = Math.max(
      0,
      articleLayoutOrder.findIndex((l) => l === articleLayout),
    );
    const next =
      articleLayoutOrder[(idx + 1) % articleLayoutOrder.length] ?? "list";
    setArticleLayout(next);
  }, [articleLayout, articleLayoutOrder, setArticleLayout]);
  // 「Inoreader列表」首次打开：若图片 / 社交媒体 / 通知视图的分界限是关闭的，问一次文章视图是否也关闭
  const splitterVisibleByView = useUISettingKey("splitterVisibleByView");
  const inoreaderSplitterPromptShown = useUISettingKey(
    "inoreaderSplitterPromptShown",
  );
  const [splitterPromptOpen, setSplitterPromptOpen] = useState(false);
  const articlePaneStyle = useUISettingKey("articlePaneStyle");
  const suppressedSplitterViews = useMemo(
    () =>
      (["picture", "social", "notification"] as ContentType[])
        .filter((view) => splitterVisibleByView?.[view] === false)
        .map((view) => t(`content_type.${view}`)),
    [splitterVisibleByView, t],
  );
  useEffect(() => {
    if (contentType !== "article" || articleLayout !== "inoreader") return;
    if (inoreaderSplitterPromptShown) return;
    if (suppressedSplitterViews.length === 0) return;
    setSplitterPromptOpen(true);
    setInoreaderSplitterPromptShown(true);
  }, [
    contentType,
    articleLayout,
    inoreaderSplitterPromptShown,
    suppressedSplitterViews.length,
    setInoreaderSplitterPromptShown,
  ]);

  const timelineGranularity = resolveTimelineGranularity(
    useUISettingKey("timelineGranularityByView")?.[contentType],
  );
  const timelineCollapse = resolveTimelineCollapse(
    useUISettingKey("timelineCollapseByView")?.[contentType],
  );
  /** 26-2：时间基准（发布时间默认 = 现状；抓取时间 = 刷新批次） */
  const timelineTimeBasis = resolveTimelineTimeBasis(
    useUISettingKey("timelineTimeBasisByView")?.[contentType],
  );
  /** 窄栏自动合一栏（默认开；关掉则始终左右交替） */
  const timelineAutoSingleSide =
    useUISettingKey("timelineSingleSideByView")?.[contentType] !== false;
  /** 29-1：正文悬停档（默认 false = 现状一字不改） */
  const notificationBodyOnHover =
    useUISettingKey("notificationBodyOnHover") ?? false;
  /**
   * 轴上可选的条目（被吸进小节点的条目不算节点）：时间线组件回报上来，
   * 键盘 j/k、↑/↓ 就用它做吸附顺序 —— 不会选到看不见的条目。
   */
  const [timelineSelectableEntries, setTimelineSelectableEntries] = useState<
    Entry[] | null
  >(null);
  const fetchReadableByView = useUISettingKey("fetchReadableByView");
  const expandLongByView = useUISettingKey("expandLongByView");
  /**
   * 进视口预载（用户 2026-10-10 原话）：订阅配了阅读模式 / 摘要 / 翻译的条目
   * 一出现在列表视口内就后台跑，点开时命中后端缓存 ⇒ 打开即出。
   * 关掉 = 回到今天「点开才发起请求」的行为。
   */
  const entryPrefetchEnabled = useUISettingKey("entryPrefetch") !== false;
  const entryPrefetchConcurrency =
    useUISettingKey("entryPrefetchConcurrency") ?? 3;
  // 「缺全文时自动抓取」只在文章类开放（设置里也只为文章渲染这一行）：
  // 实测对社交链接抓回的是 X 未登录落地页，比源内容还差。
  // 这里同时挡住存量设置里可能残留的 social=true。
  const fetchReadableEnabled =
    contentType === "article" && (fetchReadableByView?.[contentType] ?? false);
  const scrollReadEnabled = resolveScrollRead(contentType);

  // Save/restore scroll position per selection+contentType
  const scrollKey = selectionScrollKey(selection, contentType);

  // Restore scroll position on same-mount key change (e.g., article -> notification)
  // and remount (e.g., returning from picture mode).
  useLayoutEffect(() => {
    if (!isActive) return;

    const saved = entryListScrollPositions.get(scrollKey);
    scrollSurface.scrollTo(saved ?? 0);
    return () => {
      entryListScrollPositions.set(scrollKey, scrollSurface.getScrollTop());
    };
  }, [isActive, scrollKey, scrollSurface]);

  const maybeFetchNextPage = useCallback(() => {
    if (!isActive || !hasNextPage || isFetchingNextPage) return;
    if (scrollSurface.getDistanceToBottom() <= 600) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isActive, isFetchingNextPage, scrollSurface]);

  // 选中回调**必须身份稳定**：它作为 prop 传给每一张 EntryListItem，
  // 一变就是几百张卡全量重渲（实测：点一条 = 50 张卡重渲）。
  // 而 onSelectEntry 来自 wouter 路由（点条目就会换路由 → 回调换引用），
  // scrollKey 也可能随视图变，所以用「latest ref」把它们的当前值取出来，
  // 回调本身只依赖 scrollSurface（useMemo 稳定）。
  const onSelectEntryRef = useRef(onSelectEntry);
  onSelectEntryRef.current = onSelectEntry;
  const scrollKeyRef = useRef(scrollKey);
  scrollKeyRef.current = scrollKey;

  const handleSelectEntry = useCallback(
    (entryId: string) => {
      entryListScrollPositions.set(
        scrollKeyRef.current,
        scrollSurface.getScrollTop(),
      );
      onSelectEntryRef.current(entryId);
    },
    [scrollSurface],
  );

  useEffect(() => {
    if (!isActive) return;

    const handleScroll = () => {
      entryListScrollPositions.set(scrollKey, scrollSurface.getScrollTop());
      maybeFetchNextPage();
    };

    return scrollSurface.subscribe(handleScroll);
  }, [isActive, maybeFetchNextPage, scrollKey, scrollSurface]);

  // Cancel pending translations and reset state when list changes
  useEffect(() => {
    // Cancel any in-flight batch translations
    cancelAllBatchTranslations();
    // Clear translation tracking for new list
    translationSession.current += 1;
    translatedEntries.current.clear();
    pendingTranslation.current.clear();
    pendingDetection.current.clear();
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  }, [selection, contentType]);

  useEffect(() => {
    const pendingDetectionEntries = pendingDetection.current;

    return () => {
      translationSession.current += 1;
      pendingDetectionEntries.clear();
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, []);

  const feedsMap = useMemo(() => {
    const map = new Map<string, Feed>();
    for (const feed of feeds) {
      map.set(feed.id, feed);
    }
    return map;
  }, [feeds]);

  const foldersMap = useMemo(() => {
    const map = new Map<string, Folder>();
    for (const folder of folders) {
      map.set(folder.id, folder);
    }
    return map;
  }, [folders]);

  const { data: generalSettings } = useGeneralSettings();

  /**
   * 22-3：渲染前把「已读但先别消失」的条目插回来。
   *
   * `entries` 来自 `["entries"]` 查询，任何一次重拉（刷新跑完 / 手动刷新 / 重新聚焦）都会把它
   * 换成「服务端此刻的未读列表」—— 那些刚被标已读、但用户还看着的条目就没了。
   * `deferred-removal` 记着它们的本体和原下标，这里按原位插回；没缺失时**引用不变**（不白渲染）。
   * 离开这个列表（`resetKey` 变）时 `useScrollMarkRead` 会清空记账 + 从缓存里摘掉，
   * 于是「换订阅再回来它们才消失」这条语义不变。
   */
  const deferredRemovalVersion = useSyncExternalStore(
    subscribeDeferredRemovals,
    getDeferredRemovalsVersion,
    () => 0,
  );
  const entries = useMemo(
    () =>
      mergeDeferredRemovals(flattenUniqueEntries(data?.pages)),
    [data, deferredRemovalVersion],
  );

  /**
   * 「正文推入方向 = 向下」合列（方案 2 · 整列一起滚）的两件事：
   * 1) 点条目后把正文滚进视野并把正文顶部吸到视口顶 —— 用户的期待就是「点完继续往下滚」；
   * 2) 顺手标已读并记 deferred（同 NotificationTimeline 的写法）：内嵌正文
   *    不走 EntryContent 的自动标已读（embedded 时那段被跳过），不补这一步
   *    就会出现「读完了列表里还是未读」。
   */
  const { mutate: markAsRead } = useMarkAsRead();
  const inlineMarkedRef = useRef<string | null>(null);
  /* 只有真接了内联正文（桌面合列）才滚/标已读；移动端仍是列表→详情页，不插手 */
  const inlineActive = isArticleInline && Boolean(renderInlineContent);
  /* 合列且已选中正文时关掉虚拟化：虚拟列表的行是 position:absolute + transform 包裹，
     正文 pane 插在这种祖先里会让 EntryContentHeader 的 sticky 失效（工具栏会浮在正文
     中部）。关掉虚拟化后 pane 落在普通文档流里，sticky 正常，正文也能滚动吸顶。 */
  const inlineNoVirtual = inlineActive;
  /* 移动端列表 TOP 栏的滚动交互（用户 2026-11-24 第 2 条）：
     - 向下滚 → 收起；向上滚 → 出现；回到顶部 → 出现；
     - 打开内联正文后，正文标题栏优先级高于 TOP 栏：正文标题一到顶就把 TOP 收起，
       滚回正文上方（paneTop > 0）时 TOP 再出现。
     自动吸顶那几帧是程序化滚动，用户没动手前不据此判定方向。 */
  const [mobileHeaderHidden, setMobileHeaderHidden] = useState(false);
  /* 卡片正文栏滚到视口顶部后自动铺满宽度，不再留左右各 8px 的空白（用户 2026-11-24）。 */
  const [paneAtTop, setPaneAtTop] = useState(false);
  const lastScrollYRef = useRef<number | null>(null);
  /* 点开正文后的自动吸顶会连续写 scrollTop；这段时间不要用「位置」去反推顶栏，
     否则收起/展开又反过来改变可视高度，paneTop 在阈值附近来回抖 → 点击时快速闪烁。 */
  const suppressHeaderToggleUntilRef = useRef(0);
  useEffect(() => {
    suppressHeaderToggleUntilRef.current = performance.now() + 300;
    setMobileHeaderHidden(false);
    setPaneAtTop(false);
    lastScrollYRef.current = null;
  }, [selectedEntryId, isMobile, articlePushDirection, contentType, inlineActive]);
  useEffect(() => {
    const container = containerRef.current;
    const readY = () => (isMobile ? window.scrollY : container?.scrollTop ?? 0);
    let last = readY();
    /* 顶栏收起/展开会改变列表可视高度，浏览器的滚动锚定会回写 scrollTop，
       产生一次方向相反的小滚动，导致顶栏来回抖。切换后 450ms 内只更新基准、不再判定。 */
    let lockUntil = 0;
    const update = () => {
      const y = readY();
      const prev = last;
      last = y;
      if (performance.now() < lockUntil) return;
      if (performance.now() < suppressHeaderToggleUntilRef.current) return;
      if (y <= 6) {
        setMobileHeaderHidden(false);
        /* 回到列表最顶时正文一定不在视口顶（它排在列表里），必须把「铺满」复位，
           否则从正文下方滚回顶部后 paneAtTop 还停在 true，正文栏会以直角铺满的
           形态挂在列表中间、左右 8px 留白消失（用户 2026-11-24 报的缺口同批发现）。 */
        if (inlineActive) setPaneAtTop(false);
        return;
      }
      if (inlineActive && selectedEntryId) {
        const node = inlineContentRef.current;
        if (node) {
          const paneTop =
            node.getBoundingClientRect().top - scrollSurface.getViewportRect().top;
          /* 滞回：正文略微越过顶（<=2）才收，回落到 14 以上才展开。
             顶栏收起/展开会改变列表可视高度，若用单一阈值，paneTop 会在 0 附近来回抖，
             表现为点击后顶栏快速闪烁。 */
          setPaneAtTop(paneTop <= 2);
          /* 正文还没滚到顶部时，仍按普通列表的方向规则：下滑收起 TOP、上滑恢复。
             正文一旦顶到视口顶（paneTop<=2），TOP 就让位给正文标题栏并保持收起。 */
          if (paneTop <= 2) {
            setMobileHeaderHidden(true);
            return;
          }
        }
      }
      const dy = y - prev;
      if (dy > 2) {
        setMobileHeaderHidden(true);
        lockUntil = performance.now() + 450;
      } else if (dy < -2) {
        setMobileHeaderHidden(false);
        lockUntil = performance.now() + 450;
      }
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    container?.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("scroll", update);
      container?.removeEventListener("scroll", update);
    };
  }, [isMobile, inlineActive, selectedEntryId, scrollSurface]);
  /* 合列正文接在「被点那一行」的后面（不是列表末尾）：读正文时还能继续往下滚看到
     后续条目；selectedEntryId 唯一 ⇒ 同时只有一条正文，点别的行就是换正文、上一条收起。 */
  const inlinePaneFor = (entryId: string | null) =>
    inlineActive && entryId !== null && entryId === selectedEntryId ? (
      <div
        ref={inlineContentRef}
        data-testid="inline-article-pane"
        className={cn(
          /* 裁剪圆角必须跟着 border-radius 走：贴顶那档是 rounded-none（直角边框），
             若裁剪还按 12px 圆角切，角上就会少一块（用户 2026-11-24 报的缺口）。
             clip-path 一并进过渡表，否则切换途中两者不同步，反向（贴顶→卡片）时
             裁剪圆角会先跳回 12px，照样露缺口。 */
          "bg-card transition-[margin,width,border-radius,clip-path] duration-200 ease-out",
          articlePaneStyle === "card"
            ? paneAtTop
              ? "my-0 w-full rounded-none border-t border-border [clip-path:inset(0)]"
              : "mx-2 my-2 w-[calc(100%-1rem)] rounded-[12px] border border-border/60 shadow-nf [clip-path:inset(0_round_12px)]"
            : "w-full rounded-[12px] border-t border-border [clip-path:inset(0_round_12px)]",
        )}
      >
        {renderInlineContent?.(containerRef, {
          headerStickyTop: mobileHeaderHidden
            ? "top-0"
            : "top-[calc(2.75rem+env(safe-area-inset-top))]",
        })}
      </div>
    ) : null;
  /* 打开正文不再自动把正文吸到顶部（用户 2026-11-24：整块吸过去太抽搐）。
     交给自然滚动：TOP 栏随列表滚走，正文标题滚到视口顶部时由自身的 sticky 自然钉住。 */

  useEffect(() => {
    if (!inlineActive || !selectedEntryId) return;
    if (inlineMarkedRef.current === selectedEntryId) return;
    const index = entries.findIndex((item) => item.id === selectedEntryId);
    const target = index >= 0 ? entries[index] : undefined;
    /* 深链进来时 entries 可能还没到；找不到就先不记账，等列表到位再补标 */
    if (!target) return;
    inlineMarkedRef.current = selectedEntryId;
    if (!target.read) {
      markAsRead({ id: selectedEntryId, read: true, skipInvalidate: true });
      deferEntryRemoval(selectedEntryId, { ...target, read: true }, index);
    }
  }, [inlineActive, selectedEntryId, entries, markAsRead]);

  /**
   * 进视口预载：观察器挂在本列表的滚动容器上（root 与 `scroll-surface` 同一口径，
   * 手机端是文档滚动 ⇒ root=null），条目行带 `data-entry-id`，命中就入队。
   * 判定用的三态口径由 `entry-prefetch-plan` 照抄正文页，读写的位置也全是
   * 正文页会读的地方（单条缓存 / 后端 AI 缓存 / translation-store）。
   */
  useEntryPrefetch({
    entries,
    feedsById: feedsMap,
    context: {
      autoReadability: generalSettings?.autoReadability ?? false,
      autoSummary: aiSettings?.autoSummary ?? false,
      autoTranslate: aiSettings?.autoTranslate ?? false,
      targetLanguage,
    },
    intersectionRoot: scrollSurface.getIntersectionRoot(),
    contentRootRef: containerRef,
    enabled: entryPrefetchEnabled && isActive,
    resetKey: scrollKey,
    concurrency: entryPrefetchConcurrency,
  });

  /**
   * 54-9：**列表主动翻译**（社交 / 通知视图）。
   *
   * 用户 2026-10-20 原话：「就是要列表主动翻译，只限社交媒体、通知视图……直接在列表就看了」。
   * 54-2 那一版是**只读缓存**（等滚动预载碰巧翻好），用户判为「等于没做」—— 因为列表里
   * 绝大多数条目从来没被预载过，所以一直是原文。
   *
   * 现在本钩子自己发起翻译，但走的仍是**预载那条 warm 通道**（202 立即返回、后端后台翻），
   * 绝不在列表里开 `/ai/translate` SSE（同源 6 条并发，§2.50 实测第 6 条卡 45.6 秒）；
   * 翻好之后按 2.5s 轮询批量读缓存，读到就换到卡片上。
   */
  useListTranslations({
    entries,
    feedsById: feedsMap,
    autoTranslate: aiSettings?.autoTranslate ?? false,
    targetLanguage,
    enabled:
      isActive &&
      (isSocialView || isNotificationTimeline) &&
      (autoTranslate || hasAutoTranslateOverride),
    resetKey: scrollKey,
    concurrency: entryPrefetchConcurrency,
  });

  // 列表卡片的「AI 摘要」徽章：只读轮询后端摘要状态（不发翻译请求）。
  // 只在这两个视图启用：它们的卡片渲染 AI 摘要徽章（lightbulb）。
  // 文章列表的「摘要」徽标不靠这里 —— 批量翻译流式返回时会带 provider/model
  // 直接写进 translation store，既不额外轮询也不占用 ai_summary_status。
  useListSummaryStatuses({
    entries,
    targetLanguage,
    enabled: isActive && (isSocialView || isNotificationTimeline),
    resetKey: scrollKey,
  });

  // 24-5：右键「标记上方为已读」—— 把这条之上的未读一次标掉。
  // 与菜单里「标为已读」同语义（直接写库、不推迟摘除），上面被标掉的当场消失。
  const { mutate: markManyAsRead } = useMarkManyAsRead();
  const handleMarkAboveEntry = useCallback(
    (entryId: string) => {
      const index = entries.findIndex((entry) => entry.id === entryId);
      if (index <= 0) return;
      const ids = entries
        .slice(0, index)
        .filter((entry) => !entry.read)
        .map((entry) => entry.id);
      if (ids.length === 0) return;
      markManyAsRead({ ids, read: true });
    },
    [entries, markManyAsRead],
  );

  // 键盘快捷键：j/k 上下篇（选中即已读）、m 已读、s 星标、v 打开原文、Esc 关闭
  useEntryHotkeys({
    // 通知视图走时间线：吸附顺序 = 轴上的卡片（被吸进小节点的条目不算节点）
    entries: (isNotificationTimeline ? timelineSelectableEntries : null) ?? entries,
    selectedEntryId,
    onSelect: handleSelectEntry,
    onEscape: onCloseEntry,
    enabled: isActive,
    // 15-4：只有时间线视图额外认 ↑/↓（其余视图一行不动，行为零变化）
    arrowKeys: isNotificationTimeline,
  });
  // 列表滚上去以后，右上角浮出「当前序号 + 回到顶部」（对齐 Nextflux 的 Indicator）
  const [firstVisibleIndex, setFirstVisibleIndex] = useState(0);
  /**
   * 虚拟化只覆盖「标准文章扁平流」：article 内容类型 + 非 hover 档（含 list 与 rows）。
   * 社交 / 通知时间线 / hover 浮层档走原路径，一字不动。
   */
  const useVirtualList =
    contentType === "article" && !isArticleHover && !inlineNoVirtual;
  const virtualList = useVirtualizedArticleList({
    enabled: useVirtualList,
    scrollSurface,
    scrollKey,
    containerRef,
    entries,
    /* Inoreader列表 是固定 42px 单行档：按真实行高估，别用卡片档的 148px */
    estimateSize: isArticlePlain ? VIRTUAL_PLAIN_ROW_ESTIMATE_PX : undefined,
  });
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const items = node.querySelectorAll<HTMLElement>("[data-entry-id]");
      if (items.length === 0) return;
      const containerTop = node.getBoundingClientRect().top;
      let index = items.length - 1;
      for (let i = 0; i < items.length; i += 1) {
        const el = items[i];
        if (!el) continue;
        const bottom = el.getBoundingClientRect().bottom - containerTop + 8;
        if (bottom > 0) {
          index = i;
          break;
        }
      }
      setFirstVisibleIndex((prev) => (prev === index ? prev : index));
    };

    const handleScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    node.addEventListener("scroll", handleScroll, { passive: true });
    measure();
    return () => {
      node.removeEventListener("scroll", handleScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [entries.length]);

  // 刷新：按当前选中范围（单个源 / 文件夹内所有源 / 某个视图的所有源）
  const [mobileActions, setMobileActions] = useState<{
    entry: Entry;
    point: { x: number; y: number };
  } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  /** 强制拉取前待确认的源数（null = 没有待确认的） */
  const [forcePending, setForcePending] = useState<number | null>(null);
  // 刷新进度（待刷新总数 / 已完成数）：后端刷新状态接口轮询得到，用于按钮里的递减计数
  const [refreshProgress, setRefreshProgress] = useState<{
    total: number;
    completed: number;
  } | null>(null);
  const refreshPollRef = useRef<number | null>(null);

  const stopRefreshPolling = useCallback(() => {
    if (refreshPollRef.current !== null) {
      window.clearInterval(refreshPollRef.current);
      refreshPollRef.current = null;
    }
  }, []);

  useEffect(() => stopRefreshPolling, [stopRefreshPolling]);

  /**
   * 12-10：刷新进度以**全局状态**为准。
   *
   * 原来只有中栏自己点的刷新才会亮进度条 —— 侧栏 / 文件夹 / 视图右键触发的刷新
   * （走的是同一个后端接口）在中栏一点反应都没有，用户以为「联动没生效」。
   * 现在把轮询到的 isRefreshing/进度一起算进来（同一个 queryKey，不多一次请求）。
   */
  const globalRefreshStatus = useRefreshStatus();
  const showRefreshing =
    isRefreshing || Boolean(globalRefreshStatus?.isRefreshing);
  const shownTotal =
    refreshProgress?.total || globalRefreshStatus?.total || 0;
  const shownCompleted =
    refreshProgress?.completed || globalRefreshStatus?.completed || 0;

  const handleRefresh = useCallback(async (force = false, skipConfirm = false) => {
    if (isRefreshing) return;

    let ids: string[] = [];
    if (selection.type === "feed") {
      ids = [selection.feedId];
    } else if (selection.type === "folder") {
      ids = feeds
        .filter((feed) => feed.folderId === selection.folderId)
        .map((feed) => feed.id);
    } else if (selection.type === "all") {
      ids = feeds
        .filter((feed) => (feed.type ?? "article") === contentType)
        .map((feed) => feed.id);
    }
    // 星标视图或算不出范围时刷新全部（ids 为空即刷新全部）

    // 先用本地已知的源数打底，随后由后端进度覆盖（后端只在刷新中返回进度）
    const localTotal = ids.length > 0 ? ids.length : feeds.length;

    // 强制拉取且范围很大（很可能是误选）先确认一次（用户 11-19 的原话要求）
    if (force && !skipConfirm && localTotal > FORCE_REFRESH_CONFIRM_THRESHOLD) {
      setForcePending(localTotal);
      return;
    }

    setIsRefreshing(true);
    setRefreshProgress({ total: localTotal, completed: 0 });
    stopRefreshPolling();

    /**
     * 后端是后台刷新：POST 立刻返回 204，真正「刷完」只能看状态接口。
     * 所以这里不能把 POST 的返回当成结束 —— 否则按钮刚转一下就停（用户看到的「点一下 49 个瞬间完成」）。
     * 结束条件：状态接口报 isRefreshing=false（且我们已经见过它在刷）或兜底超时。
     */
    const startedAt = Date.now();
    let sawRefreshing = false;

    const finishRefresh = () => {
      stopRefreshPolling();
      setIsRefreshing(false);
      setRefreshProgress(null);
      // 58-3：手动刷新也只并头部新条目 —— 整窗重拉会按旧 offset 把用户正读的卡顶出窗口
      void requestEntriesHeadSync(queryClient);
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
      /**
       * 58-3：手动刷新也先等「新增 N 条」—— 这条是用户明确要的「刷新完告诉我加了多少」。
       * 这里先把记账标成「刷新已完成」，entries 一回来就能弹条数 Toast；
       * 如果确实一条新增都没有，2.5 秒后再补那条泛泛的「刷新完成」。
       */
      const watch = refreshWatchRef.current;
      watch.active = true;
      watch.finished = true;
      if (watch.trigger === null) watch.trigger = "manual";
      if (manualDoneToastTimerRef.current !== null) {
        window.clearTimeout(manualDoneToastTimerRef.current);
      }
      manualDoneToastTimerRef.current = window.setTimeout(() => {
        manualDoneToastTimerRef.current = null;
        showToast(t("entry.refresh_done"));
      }, 2500);
    };

    const pollRefreshStatus = () => {
      void getRefreshStatus()
        .then((status) => {
          setRefreshProgress((prev) => ({
            total: status.total || prev?.total || localTotal,
            completed: status.completed ?? prev?.completed ?? 0,
          }));

          if (status.isRefreshing) {
            sawRefreshing = true;
            return;
          }
          // 还在「刚触发、后端尚未开始」的空档里就再等一会儿，别一上来就宣布刷完了
          const settled = sawRefreshing || Date.now() - startedAt > REFRESH_START_GRACE_MS;
          if (settled || Date.now() - startedAt > REFRESH_MAX_WAIT_MS) {
            finishRefresh();
          }
        })
        .catch(() => {
          // 进度只是显示用，取不到就保持上一次的值
        });
    };

    pollRefreshStatus();
    refreshPollRef.current = window.setInterval(pollRefreshStatus, 400);

    showToast(
      ids.length > 0
        ? t("entry.refreshing_n_feeds", { count: ids.length })
        : t("entry.refreshing_all"),
    );

    try {
      if (ids.length > 0) {
        await refreshFeeds(ids, force);
      } else {
        await refreshAllFeeds(force);
      }
      // 「已在刷新中」也会走到这里：那就跟着它在跑的这一轮一起显示进度，不报错
      pollRefreshStatus();
    } catch {
      stopRefreshPolling();
      setIsRefreshing(false);
      setRefreshProgress(null);
      showToast(t("entry.refresh_failed"));
    }
  }, [
    contentType,
    feeds,
    isRefreshing,
    selection,
    stopRefreshPolling,
    t,
  ]);

  /**
   * 58-3（用户 2026-10-29）：自动刷新拉到新条目时——
   *   ① 列表不在顶部 ⇒ 保持当前这一屏不动（新条目无感叠在前面，见 usePrependScrollAnchor）；
   *   ② 刷新跑完只弹一条 3 秒 Toast「新增 N 条新条目」，点它才滚回顶部看新内容；
   *   ③ 在列表最顶端 ⇒ 直接插进来、不弹 Toast（用户原话）。
   *
   * 记账口径：只认 `trigger === "auto"` 的刷新（手动刷新已有「刷新完成」提示，不重复弹）；
   * ids 用 Set 去重（一轮刷新里 completed 递增会多次重拉，同一条新条目可能被算到两次）。
   */
  const refreshWatchRef = useRef<{
    active: boolean;
    finished: boolean;
    trigger: "manual" | "auto" | null;
    ids: Set<string>;
    timer: number | null;
  }>({
    active: false,
    finished: false,
    trigger: null,
    ids: new Set<string>(),
    timer: null,
  });
  const prevRefreshedAtRef = useRef<string | undefined | null>(null);
  /** DEV 诊断去重：状态签名没变就不打 */
  const refreshStatusLogSigRef = useRef("");
  /** 手动刷新如果没拉到新条目，延迟落一条「刷新完成」；有新增则被条数 Toast 顶掉 */
  const manualDoneToastTimerRef = useRef<number | null>(null);

  const showRefreshAddedToast = useCallback(() => {
    const watch = refreshWatchRef.current;
    watch.timer = null;
    // 有「新增 N 条」就不再补那条泛泛的「刷新完成」
    if (manualDoneToastTimerRef.current !== null) {
      window.clearTimeout(manualDoneToastTimerRef.current);
      manualDoneToastTimerRef.current = null;
    }
    const count = watch.ids.size;
    // 出过这一条就重新开始记：同一轮里后面的重拉不会把同一条再算一次
    watch.ids.clear();
    watch.active = false;
    watch.finished = false;
    watch.trigger = null;
    if (count <= 0) return;
    showToast(
      t("entry.refresh_new_entries", { count }),
      3000,
      // 用户 2026-10-29：「或者可以点击这个 Toast，它就跳到前面了」——
      // 点它才滚到最顶部；不点 3 秒后自己消失，列表全程不动。
      jumpToTop,
    );
  }, [jumpToTop, t]);

  const scheduleRefreshAddedToast = useCallback(() => {
    const watch = refreshWatchRef.current;
    // 手动刷新也报条数（用户 2026-10-29：刷新完没提示，他以为新条目没进来）
    if (watch.ids.size === 0) return;
    if (watch.timer !== null) window.clearTimeout(watch.timer);
    // 等最后一次重拉落定（刷新中每刷完一个源都会并一次 entries）再报总数
    watch.timer = window.setTimeout(showRefreshAddedToast, 800);
  }, [showRefreshAddedToast]);

  const handleHeadAdditions = useCallback(
    (_headIds: string[], newIds: string[], atTop: boolean) => {
      const watch = refreshWatchRef.current;
      if (!watch.active) return;
      if (atTop) {
        // 在顶端 = 用户本来就在看最新内容，直接插即可，不必再提示条数
        watch.ids.clear();
        if (watch.timer !== null) {
          window.clearTimeout(watch.timer);
          watch.timer = null;
        }
        return;
      }
      // 用 newIds 而不是 headIds：按发布时间排序时，新条目可能夹在两条旧条目之间
      // （实测 3 条新条目里 1 条夹在旧条目后面，只数头部会报「新增 2 条」）。
      for (const id of newIds) watch.ids.add(id);
      if (watch.finished) scheduleRefreshAddedToast();
    },
    [scheduleRefreshAddedToast],
  );

  // 刷新状态变化：记下「正在自动刷新 / 刚刷新完」两个时刻（前端轮询 15s 一次，
  // 短刷新可能只看到「刚刷新完」这一跳，所以两条都算）。
  useEffect(() => {
    const status = globalRefreshStatus;
    if (!status) return;
    const watch = refreshWatchRef.current;
    const current = status.lastRefreshedAt ?? undefined;

    if (prevRefreshedAtRef.current === null) {
      prevRefreshedAtRef.current = current;
      return;
    }

    if (status.isRefreshing) {
      // 新一轮开始：上一轮如果什么都没加到（或已经出过 Toast），清掉残留记账
      if (!watch.active || watch.finished) {
        watch.ids.clear();
        if (watch.timer !== null) {
          window.clearTimeout(watch.timer);
          watch.timer = null;
        }
      }
      watch.active = true;
      watch.finished = false;
      if (status.trigger) watch.trigger = status.trigger;
    }

    if (prevRefreshedAtRef.current !== current) {
      prevRefreshedAtRef.current = current;
      watch.active = true;
      watch.finished = true;
      if (status.trigger) watch.trigger = status.trigger;
    } else if (watch.active && !watch.finished && !status.isRefreshing) {
      // 只看到结束（轮询错过了「刷新中」那一跳）
      watch.finished = true;
    }

    if (watch.active && watch.finished) scheduleRefreshAddedToast();

    if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
      // 只在「开始/结束/切轮次」这些状态跳变时打，不跟每 2 秒的 completed 刷屏
      const signature = `${Boolean(status.isRefreshing)}|${status.trigger ?? ""}|${status.lastRefreshedAt ?? ""}|${watch.active}|${watch.finished}`;
      if (signature !== refreshStatusLogSigRef.current) {
        refreshStatusLogSigRef.current = signature;
        console.log("[krss-refresh] status", {
          isRefreshing: Boolean(status.isRefreshing),
          trigger: status.trigger ?? null,
          lastRefreshedAt: status.lastRefreshedAt ?? null,
          completed: status.completed ?? null,
          active: watch.active,
          finished: watch.finished,
          newIds: watch.ids.size,
        });
      }
    }
  }, [globalRefreshStatus, scheduleRefreshAddedToast]);

  // 换列表（订阅 / 视图 / 已读筛选）时清账，别把上一个列表的新条目算进来
  useEffect(() => {
    const watch = refreshWatchRef.current;
    watch.active = false;
    watch.finished = false;
    watch.trigger = null;
    watch.ids.clear();
    if (watch.timer !== null) {
      window.clearTimeout(watch.timer);
      watch.timer = null;
    }
    if (manualDoneToastTimerRef.current !== null) {
      window.clearTimeout(manualDoneToastTimerRef.current);
      manualDoneToastTimerRef.current = null;
    }
  }, [scrollKey, effectiveUnreadOnly]);

  useEffect(
    () => () => {
      const watch = refreshWatchRef.current;
      if (watch.timer !== null) window.clearTimeout(watch.timer);
      if (manualDoneToastTimerRef.current !== null) {
        window.clearTimeout(manualDoneToastTimerRef.current);
      }
    },
    [],
  );

  usePrependScrollAnchor({
    surface: scrollSurface,
    contentRootRef: containerRef,
    entries,
    // 保存筛选视图（activeViewId）切换时列表作用域不变、scrollKey 也不变，
    // 必须把它并进 resetKey，让换视图也当成「换了个列表」重置锚点。
    resetKey: `${scrollKey}\u0000${effectiveUnreadOnly}\u0000${activeViewId ?? ""}`,
    enabled: isActive,
    pausedRef: anchorStabilizePausedRef,
    // 有原生 anchoring 时 JS 不补：浏览器已经在同一帧补偿，JS 再补一次会重复/打架，
    // 而且它的「锚点旧坐标」在跨帧场景里反而会把页面拉走（用户 2026-11-01 复测「还是不行」）。
    compensate: !nativeScrollAnchor,
    onHeadAdditions: handleHeadAdditions,
  });

  const { endPaddingHeight: scrollReadEndPaddingHeight } = useScrollMarkRead({
    surface: scrollSurface,
    contentRootRef: containerRef,
    entries,
    enabled: scrollReadEnabled && isActive,
    unreadOnly: effectiveUnreadOnly,
    hasNextPage: Boolean(hasNextPage),
    // 5a：保存筛选视图（activeViewId）切换不改变 selection/contentType/scrollKey，
    // 之前 resetKey 不含它 ⇒ 切视图不触发 flush，滚动标掉的已读条目留在旧视图缓存里
    // （叠加 QueryClient staleTime 30s 不重拉，切回来还在）。把 activeViewId 并入 resetKey，
    // 切视图即 flush：把本段记的待摘 id 从 unreadOnly 缓存里摘掉，回来就看不到了。
    resetKey: `${scrollKey}\u0000${effectiveUnreadOnly}\u0000${scrollReadEnabled}\u0000${activeViewId ?? ""}`,
    timing: scrollReadTimingByView?.[contentType] ?? "scrollPast",
    deferRemoval: scrollReadDeferRemoval !== false,
  });

  useEffect(() => {
    maybeFetchNextPage();
  }, [entries.length, maybeFetchNextPage]);

  // Function to trigger batch translation for pending entries
  const triggerBatchTranslation = useCallback(() => {
    if (pendingTranslation.current.size === 0) return;

    const articlesToTranslate = Array.from(pendingTranslation.current.values())
      .filter((entry) => !translatedEntries.current.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        title: entry.title || "",
        summary: entry.content ? stripHtml(entry.content).slice(0, 200) : null,
      }));

    // Mark as translated to prevent re-translating
    for (const article of articlesToTranslate) {
      translatedEntries.current.add(article.id);
    }

    pendingTranslation.current.clear();

    if (articlesToTranslate.length > 0) {
      // REQ3：送出去就先把这批的「摘要」标成翻译中
      for (const article of articlesToTranslate) {
        translationActions.setStatus(article.id, targetLanguage, {
          summary: { state: "translating" },
        });
      }
      const settleSummaryStatus = (errorMsg?: string) => {
        for (const article of articlesToTranslate) {
          const cached = translationActions.get(article.id, targetLanguage);
          const prevSummary = translationActions.getStatus?.(
            article.id,
            targetLanguage,
          )?.summary;
          if (!cached?.title && !cached?.summary) {
            translatedEntries.current.delete(article.id);
            translationActions.setStatus(article.id, targetLanguage, {
              summary: { state: "failed", error: errorMsg },
            });
          } else {
            // 保留流式结果写入的 provider/model，只把状态收尾成 done
            translationActions.setStatus(article.id, targetLanguage, {
              summary: { ...prevSummary, state: "done" },
            });
          }
        }
      };
      translateArticlesBatch(articlesToTranslate, targetLanguage).then(
        () => settleSummaryStatus(),
        (error: unknown) => {
          // 取消（abort）不算失败：不写失败态，等新批次接管
          if (error instanceof Error && error.name === "AbortError") return;
          // REQ3：摘要翻译失败时把具体错误存进状态，列表悬浮可见（与正文翻译失败同口径）
          const msg =
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : undefined;
          settleSummaryStatus(msg);
        },
      );
    }
  }, [targetLanguage]);

  const queueEntryForTranslation = useCallback(
    (entry: Entry) => {
      pendingTranslation.current.set(entry.id, entry);

      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = setTimeout(triggerBatchTranslation, 500);
    },
    [triggerBatchTranslation],
  );

  // Schedule entry for translation when visible
  const scheduleTranslation = useCallback(
    (entry: Entry) => {
      if (!isAutoTranslateEnabled(entry)) return;
      if (translatedEntries.current.has(entry.id)) {
        // Verify against store: if marked but no actual translation, allow retry
        const cached = translationActions.get(entry.id, targetLanguage);
        if (cached?.title || cached?.summary) return;
        translatedEntries.current.delete(entry.id);
      }
      // Skip if user manually disabled translation for this article
      if (translationActions.isDisabled(entry.id)) return;

      if (
        pendingTranslation.current.has(entry.id) ||
        pendingDetection.current.has(entry.id)
      ) {
        return;
      }

      const summary = entry.content
        ? stripHtml(entry.content).slice(0, 200)
        : null;
      const session = translationSession.current;
      pendingDetection.current.add(entry.id);

      /**
       * 54-10（用户 2026-10-20 报「标题没翻 / 社媒视图多出一行标题」的根因之一）：
       * 这里原来用 `needsTranslation`（「这条要不要翻**正文**」），正文是中文就整体
       * 返回 false ⇒ **英文标题永远不翻**。而列表里标题与正文是两个独立字段，
       * 语言可以不一样（社交帖常见「中文正文 + 英文标题」）。
       * 改成逐字段判定（`needsListTranslation`）：标题或摘要任一是外文就来翻。
       */
      void needsListTranslationAsync(entry.title || "", summary, targetLanguage)
        .then((shouldTranslate) => {
          if (translationSession.current !== session) return;

          if (!shouldTranslate) {
            translatedEntries.current.add(entry.id);
            return;
          }

          queueEntryForTranslation(entry);
        })
        .catch(() => {
          if (translationSession.current !== session) return;
          queueEntryForTranslation(entry);
        })
        .finally(() => {
          if (translationSession.current === session) {
            pendingDetection.current.delete(entry.id);
          }
        });
    },
    [isAutoTranslateEnabled, targetLanguage, queueEntryForTranslation],
  );

  // Trigger translation for real visible items and selected entry
  useEffect(() => {
    if ((!autoTranslate && !hasAutoTranslateOverride) || !isActive) return;

    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      for (const entry of entries.slice(0, 20)) {
        scheduleTranslation(entry);
      }
      return;
    }

    const observer = new IntersectionObserver(
      (items) => {
        for (const item of items) {
          if (!item.isIntersecting) continue;

          const index = Number((item.target as HTMLElement).dataset.index);
          const entry = entries[index];
          if (entry) {
            scheduleTranslation(entry);
          }
        }
      },
      {
        root: scrollSurface.getIntersectionRoot(),
        rootMargin: "200px 0px",
      },
    );

    for (const item of node.querySelectorAll<HTMLElement>("[data-index]")) {
      observer.observe(item);
    }

    if (selectedEntryId) {
      const selectedEntry = entries.find((e) => e.id === selectedEntryId);
      if (selectedEntry) {
        scheduleTranslation(selectedEntry);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [
    entries,
    autoTranslate,
    hasAutoTranslateOverride,
    isActive,
    scheduleTranslation,
    scrollSurface,
    selectedEntryId,
  ]);

  const title = useMemo(() => {
    switch (selection.type) {
      case "all":
        switch (contentType) {
          case "picture":
            return t("entry_list.all_pictures");
          case "notification":
            return t("entry_list.all_notifications");
          case "social":
            return t("entry_list.all_social");
          default:
            return t("entry_list.all_articles");
        }
      case "feed":
        return feedsMap.get(selection.feedId)?.title || t("entry_list.feed");
      case "folder":
        return (
          foldersMap.get(selection.folderId)?.name || t("entry_list.folder")
        );
      case "starred":
        return t("entry_list.starred");
    }
  }, [selection, contentType, feedsMap, foldersMap, t]);

  // Calculate unread count from API data (not from loaded entries)
  const unreadCount = useMemo(() => {
    if (!unreadCounts) return 0;
    const counts = unreadCounts.counts;
    switch (selection.type) {
      case "all":
        // Sum all feeds' unread counts, filtered by contentType
        return feeds
          .filter((f) => f.type === contentType)
          .reduce((sum, f) => sum + (counts[f.id] ?? 0), 0);
      case "feed":
        return counts[selection.feedId] ?? 0;
      case "folder":
        // Sum unread counts for feeds in this folder with matching contentType
        return feeds
          .filter(
            (f) => f.folderId === selection.folderId && f.type === contentType,
          )
          .reduce((sum, f) => sum + (counts[f.id] ?? 0), 0);
      case "starred":
        return 0; // Starred view doesn't show unread count
    }
  }, [unreadCounts, selection, feeds, contentType]);

  // filterValue 见文件上方，用于请求参数与标题判断
  // 「已静音」是回看视图：标题跟着变，并给一行说明（这条视图里看到的不是新内容，而是被规则收起来的）
  const headerTitle =
    mutedOnly
      ? t("entry_filter.muted")
      : activeViewId && activeViewName
        ? activeViewName
        : title;
  // 保存筛选视图（activeViewId）不再显示那行「正在使用保存的筛选视图」副标题（用户 2026-11-23：
  // 智能文件夹升级后，这条提示多余要去掉）；「已静音」回看视图的说明保留。
  const headerSubtitle = mutedOnly
    ? t("automation.muted_view_hint")
    : undefined;

  return (
    <div
      ref={listWrapperRef}
      className={cn(
        usesDocumentScroll
          ? "entry-list-document relative min-h-[var(--app-dvh)]"
          : "relative flex h-full flex-col",
      )}
    >
      <MobilePullToRefresh
        enabled={Boolean(isMobile && isActive)}
        isRefreshing={showRefreshing}
        onRefresh={handleRefresh}
        progressTotal={showRefreshing ? shownTotal : 0}
        progressCompleted={shownCompleted}
      />
      <MobileDocumentHeader
        enabled={usesDocumentScroll}
        headerRef={headerRef}
        testId="entry-list-header"
        hidden={mobileHeaderHidden}
      >
        <EntryListHeader
          hidden={
            !isMobile &&
            mobileHeaderHidden &&
            articleLayout === "inoreader" &&
            inlineActive &&
            Boolean(selectedEntryId)
          }
          title={headerTitle}
          subtitle={headerSubtitle}
          onBackFromFeedJump={feedJumpBackHref ? onBackFromFeedJump : undefined}
          unreadCount={
            activeViewId ? (viewUnreadCount ?? unreadCount) : unreadCount
          }
          unreadOnly={unreadOnly}
          /* 58-1：星标视图不显示「只看未读」切换（用户 2026-10-29） */
          showUnreadToggle={selection.type !== "starred"}
          onToggleUnreadOnly={onToggleUnreadOnly}
          onMarkAllRead={onMarkAllRead}
          onRefresh={handleRefresh}
          onForceRefresh={() => void handleRefresh(true)}
          starredViewOnly={
            selection.type === "starred" ? Boolean(selection.viewOnly) : undefined
          }
          onToggleStarredViewOnly={
            selection.type === "starred" ? onToggleStarredViewOnly : undefined
          }
          isRefreshing={showRefreshing}
          refreshTotal={shownTotal}
          refreshCompleted={shownCompleted}
          refreshStatus={globalRefreshStatus}
          scrollToTopScope="entrylist"
          isMobile={isMobile}
          onMenuClick={handleMenuClick}
          isTablet={isTablet}
          selectedEntryIds={selectedEntryId ? [selectedEntryId] : []}
          articleLayout={contentType === "article" ? articleLayout : undefined}
          articleLayoutOrder={
            contentType === "article" ? articleLayoutOrder : undefined
          }
          onToggleArticleLayout={
            contentType === "article" ? handleToggleArticleLayout : undefined
          }
          onToggleSidebar={onToggleSidebar}
          sidebarVisible={sidebarVisible}
          onSearchClick={onSearchClick}
        />

        {/* 强制拉取确认（范围太大时先问一句，避免误选整轮重抓） */}
        <AlertDialog>
          <Button className="hidden" aria-hidden />
          <AlertDialog.Backdrop
            isOpen={splitterPromptOpen}
            onOpenChange={(open) => !open && setSplitterPromptOpen(false)}
          >
            <AlertDialog.Container>
              <AlertDialog.Dialog className="max-w-md">
                <AlertDialog.Header>
                  <AlertDialog.Heading>
                    {t("appearance_view.inoreader_splitter_prompt_title")}
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <p>
                      {t(
                        "appearance_view.inoreader_splitter_prompt_description",
                        {
                          views: suppressedSplitterViews.join(
                            t(
                              "appearance_view.inoreader_splitter_prompt_separator",
                            ),
                          ),
                        },
                      )}
                    </p>
                    {/* 11-24（用户第 3 条）：说明这不是一次性选择，随时能回设置里改回来 */}
                    <p>
                      {t(
                        "appearance_view.inoreader_splitter_prompt_settings_hint",
                      )}
                    </p>
                  </div>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setSplitterPromptOpen(false)}
                  >
                    {t("appearance_view.inoreader_splitter_prompt_keep")}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onPress={() => {
                      // 记下「这条是提示替用户关的」，切走 Inoreader 布局时自动恢复
                      hideArticleSplitterFromPrompt();
                      setSplitterPromptOpen(false);
                    }}
                  >
                    {t("appearance_view.inoreader_splitter_prompt_also_off")}
                  </Button>
                </AlertDialog.Footer>
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog>

        <AlertDialog>
          <Button className="hidden" aria-hidden />
          <AlertDialog.Backdrop
            isOpen={forcePending !== null}
            onOpenChange={(open) => !open && setForcePending(null)}
          >
            <AlertDialog.Container>
              <AlertDialog.Dialog className="max-w-md">
                <AlertDialog.Header>
                  <AlertDialog.Heading>
                    {t("entry.force_confirm_title", { count: forcePending ?? 0 })}
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <div className="text-sm text-muted-foreground">
                    {t("entry.force_confirm_description")}
                  </div>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setForcePending(null)}
                  >
                    {t("actions.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onPress={() => {
                      setForcePending(null);
                      void handleRefresh(true, true);
                    }}
                  >
                    {t("entry.force_refresh")}
                  </Button>
                </AlertDialog.Footer>
                <AlertDialog.CloseTrigger />
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog>
      </MobileDocumentHeader>

      {/* 「当前序号 + 回到顶部」浮标（对齐 Nextflux 的 Indicator） */}
      {firstVisibleIndex > 0 && (
        <button
          type="button"
          onClick={scrollToTop}
          title={t("entry_list.back_to_top")}
          className="nf-enter absolute right-3 top-14 z-20 flex cursor-pointer select-none items-center gap-0.5 rounded-full bg-overlay/70 px-2 py-1 font-mono text-xs font-medium text-muted-foreground shadow-nf backdrop-blur-2xl transition-colors duration-200 hover:text-foreground"
        >
          {firstVisibleIndex}
          <ArrowUp className="size-3 opacity-60" strokeWidth={3} />
        </button>
      )}

      <div
        className={cn(
          usesDocumentScroll
            ? "min-h-[calc(var(--app-dvh)-3.5rem)]"
            : "relative min-h-0 flex-1 overflow-hidden",
        )}
      >
        <div
          ref={containerRef}
          data-testid="entry-list-viewport"
          /**
           * 40-2：通知视图下「点空白处收起所有展开容器」。
           * 挂在这个滚动视口上（而不是时间线根）是因为卡片列宽 `clamp(45ch,60vw,65ch)`
           * 是居中的，自动展开时卡片把这一列占满 —— 用户点的「空白」是**列表列两侧的留白**，
           * 那部分在时间线根元素之外，事件到不了它。
           * 命中判定放在时间线那边（它才知道哪些元素算「卡片」）。
           */
          onClickCapture={(event) => {
            if (!isNotificationTimeline) return;
            const target = event.target as HTMLElement | null;
            // 落在时间线行 / 卡片 / 展开容器上 → 是点条目，不是点空白
            if (
              target?.closest(
                "[data-timeline-card], [data-timeline-row], [data-timeline-full]",
              )
            ) {
              return;
            }
            // 底部「全部标记为已读」等自身可点的元素，别当成空白
            if (target?.closest("button, a, [role=\"button\"]")) return;
            // 事件要**直接派发在时间线根上**：自定义事件不会向下传播，
            // 从视口派发的话时间线根（监听方）收不到。
            const timelineRoot = event.currentTarget.querySelector(
              "[data-testid=\"notification-timeline\"]",
            );
            timelineRoot?.dispatchEvent(
              new CustomEvent(COLLAPSE_ALL_EVENT),
            );
          }}
          className={cn(
            "w-full rounded-[inherit]",
            usesDocumentScroll ? "overflow-x-visible" : "overflow-x-hidden",
            // 非虚拟列表时交给浏览器自己的 scroll anchoring：它和布局在同一帧里补偿，
            // 不会出现「先被推走一秒、再被 JS 拉回」的跳（旧 JS 兜底还会用过期锚点乱拉）。
            // 虚拟化文章列表仍然是 none + usePrependScrollAnchor 的 JS 补偿。
            usesDocumentScroll
              ? cn("overflow-y-visible", nativeScrollAnchor ? "[overflow-anchor:auto]" : "[overflow-anchor:none]")
              : cn(
                  "h-full overflow-y-auto overscroll-y-contain",
                  nativeScrollAnchor ? "[overflow-anchor:auto]" : "[overflow-anchor:none]",
                ),
          )}
        >
          {showDisabledArticleHoverNotice && (
            <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <span>{t("appearance_view.experimental_disabled_hint")}</span>
              <button
                type="button"
                onClick={() => setArticleLayout("list")}
                className="shrink-0 rounded-md px-2 py-1 font-medium underline underline-offset-2 hover:bg-amber-500/15"
              >
                {t("appearance_view.switch_to_regular")}
              </button>
            </div>
          )}
          {isLoading ? (
            <EntryListSkeleton />
          ) : entries.length === 0 ? (
            <EntryListEmpty />
          ) : (
            <div
              className="w-full"
              /* 31-2：文章 hover 档的悬停认行靠事件委托（对行零改动）；别的档不挂监听 */
              onMouseOver={isArticleHover ? handleArticleHoverOver : undefined}
              onMouseOut={isArticleHover ? handleArticleHoverOut : undefined}
              data-article-body-hover={isArticleHover ? "true" : undefined}
            >
              {/* 底部留白由外层布局承担（移动端 Tab 栏 padding / 桌面无悬浮胶囊），此处不再叠加 */}
              {isNotificationTimeline ? (
                <NotificationTimeline
                  entries={entries}
                  feeds={feedsMap}
                  unreadCounts={unreadCounts?.counts}
                  selectedEntryId={selectedEntryId}
                  onSelectEntry={handleSelectEntry}
                  onMarkAboveEntry={handleMarkAboveEntry}
                  onCloseEntry={onCloseEntry}
                  granularity={timelineGranularity}
                  collapse={timelineCollapse}
                  autoExpandLong={expandLongByView?.[contentType] ?? false}
                  timeBasis={timelineTimeBasis}
                  autoSingleSide={timelineAutoSingleSide}
                  bodyOnHover={notificationBodyOnHover}
                  autoTranslate={autoTranslate}
                  targetLanguage={targetLanguage}
                  onSelectableEntriesChange={setTimelineSelectableEntries}
                  onSelectFeedFromEntry={onSelectFeedFromEntry}
                />
              ) : isArticlePlain ? (
                /* 常规「Inoreader列表」—— 来源图标 + 加粗标题 + 右侧来源·时间，
                   没有缩略图、没有摘要、没有悬停浮层（就是图片视图「悬停大图」去掉悬停）。 */
                <div className="w-full" data-testid="article-plain-list">
                  {inlineNoVirtual ? (
                    entries.map((entry) => {
                      const row = (
                        <ArticlePlainListRow
                          entry={entry}
                          feed={feedsMap.get(entry.feedId)}
                          onSelectEntry={handleSelectEntry}
                          selectedEntryId={selectedEntryId}
                          onMarkAboveEntry={handleMarkAboveEntry}
                          isMobile={isMobile}
                          feedUnreadCount={unreadCounts?.counts?.[entry.feedId]}
                        />
                      );
                      return (
                        <Fragment key={entry.id}>
                          {isMobile ? (
                            <MobileSwipeEntryRow entry={entry}>{row}</MobileSwipeEntryRow>
                          ) : (
                            row
                          )}
                          {inlinePaneFor(entry.id)}
                        </Fragment>
                      );
                    })
                  ) : (
                    <VirtualizedArticleList
                      virtualList={virtualList}
                      entries={entries}
                      renderItem={(entry) => {
                        const row = (
                          <ArticlePlainListRow
                            entry={entry}
                            feed={feedsMap.get(entry.feedId)}
                            onSelectEntry={handleSelectEntry}
                            selectedEntryId={selectedEntryId}
                            onMarkAboveEntry={handleMarkAboveEntry}
                            isMobile={isMobile}
                            feedUnreadCount={unreadCounts?.counts?.[entry.feedId]}
                          />
                        );
                        /* 手机档跟其它列表一致：左滑露出已读/星标 */
                        return (
                          <>
                            {isMobile ? (
                              <MobileSwipeEntryRow entry={entry}>{row}</MobileSwipeEntryRow>
                            ) : (
                              row
                            )}
                            {inlinePaneFor(entry.id)}
                          </>
                        );
                      }}
                    />
                  )}
                </div>
              ) : isArticleRows ? (
                /* 实验布局批：文章「列表」布局 —— 紧凑行（缩略图+标题+元信息），无悬停浮层。
                   走通用虚拟容器（大列表性能），jsdom 测不到尺寸时内部全量渲染。 */
                <div className="w-full" data-testid="article-rows-list">
                  {inlineNoVirtual ? (
                    entries.map((entry) => (
                      <Fragment key={entry.id}>
                        <ArticleRowsListRow
                          entry={entry}
                          feed={feedsMap.get(entry.feedId)}
                          onSelectEntry={handleSelectEntry}
                          selectedEntryId={selectedEntryId}
                          onMarkAboveEntry={handleMarkAboveEntry}
                          isMobile={isMobile}
                          feedUnreadCount={unreadCounts?.counts?.[entry.feedId]}
                        />
                        {inlinePaneFor(entry.id)}
                      </Fragment>
                    ))
                  ) : (
                    <VirtualizedArticleList
                      virtualList={virtualList}
                      entries={entries}
                      renderItem={(entry) => (
                        <>
                          <ArticleRowsListRow
                            entry={entry}
                            feed={feedsMap.get(entry.feedId)}
                            onSelectEntry={handleSelectEntry}
                            selectedEntryId={selectedEntryId}
                            onMarkAboveEntry={handleMarkAboveEntry}
                            isMobile={isMobile}
                            feedUnreadCount={unreadCounts?.counts?.[entry.feedId]}
                          />
                          {inlinePaneFor(entry.id)}
                        </>
                      )}
                    />
                  )}
                </div>
              ) : useVirtualList ? (
                <VirtualizedArticleList
                  virtualList={virtualList}
                  entries={entries}
                  renderItem={(entry, index) => {
                    const item = (
                      <EntryListItem
                        feedUnreadCount={unreadCounts?.counts?.[entry.feedId]}
                        key={entry.id}
                        data-index={index}
                        data-entry-id={entry.id}
                        entry={entry}
                        feed={feedsMap.get(entry.feedId)}
                        isSelected={entry.id === selectedEntryId}
                        onClick={handleSelectEntry}
                        onMarkAboveEntry={handleMarkAboveEntry}
                        autoTranslate={autoTranslate}
                        targetLanguage={targetLanguage}
                        social={isSocialView}
                        fetchReadable={fetchReadableEnabled}
                        autoExpandLong={expandLongByView?.[contentType] ?? false}
                        isMobile={isMobile}
                        onLongPress={(entry, point) =>
                          setMobileActions({ entry, point })
                        }
                        onSelectFeedFromEntry={onSelectFeedFromEntry}
                      />
                    );
                    return (
                      <>
                        {isMobile ? (
                          <MobileSwipeEntryRow entry={entry}>
                            {item}
                          </MobileSwipeEntryRow>
                        ) : (
                          item
                        )}
                        {inlinePaneFor(entry.id)}
                      </>
                    );
                  }}
                />
              ) : (
                entries.map((entry, index) => {
                  const item = (
                    <EntryListItem
                      feedUnreadCount={unreadCounts?.counts?.[entry.feedId]}
                      key={entry.id}
                      data-index={index}
                      data-entry-id={entry.id}
                      entry={entry}
                      feed={feedsMap.get(entry.feedId)}
                      isSelected={entry.id === selectedEntryId}
                      onClick={handleSelectEntry}
                      onMarkAboveEntry={handleMarkAboveEntry}
                      autoTranslate={autoTranslate}
                      targetLanguage={targetLanguage}
                      social={isSocialView}
                      fetchReadable={fetchReadableEnabled}
                      autoExpandLong={expandLongByView?.[contentType] ?? false}
                      isMobile={isMobile}
                      onLongPress={(entry, point) =>
                        setMobileActions({ entry, point })
                      }
                      onSelectFeedFromEntry={onSelectFeedFromEntry}
                    />
                  );
                  return (
                    <Fragment key={entry.id}>
                      {isMobile ? (
                        <MobileSwipeEntryRow entry={entry}>{item}</MobileSwipeEntryRow>
                      ) : (
                        item
                      )}
                      {inlinePaneFor(entry.id)}
                    </Fragment>
                  );
                })
              )}
              {/* 24-5：列表尾整宽弱边框「全部标记为已读」（语义=清当前范围未读，
                  与列表头那颗同接口 onMarkAllRead）。
                  宽度跟时间线/社交卡片同款居中可读宽度，免得在宽栏下失控拉满。 */}
              {entries.length > 0 && (
                <div className="mx-auto mt-1 w-full max-w-[clamp(45ch,60vw,65ch)] px-2">
                  <button
                    type="button"
                    data-testid="mark-all-read-footer"
                    onClick={onMarkAllRead}
                    className="flex h-[35px] w-full items-center justify-center gap-1.5 rounded-[10px] border border-border bg-transparent px-3 text-[13px] text-muted-foreground transition-colors duration-200 hover:bg-item-hover hover:text-foreground"
                  >
                    <Check className="size-4 shrink-0" />
                    {t("entry.mark_all_read")}
                  </button>
                </div>
              )}
              {scrollReadEndPaddingHeight > 0 && (
                <div
                  aria-hidden="true"
                  data-testid="scroll-read-end-padding"
                  style={{ height: scrollReadEndPaddingHeight }}
                />
              )}
            </div>
          )}

          {isFetchingNextPage && <LoadingMore />}
        </div>

        {isArticleHover && (() => {
          /* entries 声明在下面，这里现算悬停的那条（同 NotificationTimeline 的写法） */
          const articleHoverEntry = articleHoverAnchor
            ? (entries.find((entry) => entry.id === articleHoverAnchor.id) ??
              null)
            : null;
          return (
          <NotificationBodyPreview
            entry={articleHoverEntry}
            visible={articleHoverEntry !== null}
            anchor={
              articleHoverAnchor
                ? {
                    x: articleHoverAnchor.x,
                    y: articleHoverAnchor.y,
                    cardTop: articleHoverAnchor.cardTop,
                    cardBottom: articleHoverAnchor.cardBottom,
                  }
                : { x: 0, y: 0, cardTop: null, cardBottom: null }
            }
            feedName={
              articleHoverEntry
                ? ((feedsMap.get(articleHoverEntry.feedId)?.title ??
                  t("entry.unknown_feed")) as string)
                : ""
            }
            autoTranslate={autoTranslate}
            targetLanguage={targetLanguage}
            onMouseEnter={cancelArticleHoverClose}
            onMouseLeave={closeArticleHoverSoon}
            /* 32-2（用户 2026-09-26 原话）：「文章视图的悬浮框能不能像图片视图里那样？
               鼠标还在中间，效果什么都一样」⇒ 照 hover-img 原件以指针为中心 */
            anchorMode="pointer"
            /* 33-1（用户 2026-09-26 原话）：「悬浮框里的『移动』操作会卡住，然后就不会切换到
               下一篇文章的内容」⇒ 以指针为中心的浮块必然被指针命中，跟随冻结 + 行 hover 丢失。
               照图片视图的逻辑解决：浮块**不吃指针**（pointer-events: none，纯跟随预览），
               指针始终落在卡片上 ⇒ 逐行扫过去每次都换内容，滚轮也归列表；
               要读全文/滚动/选中，点卡片 → 进阅读区（那里有滚动条）。 */
            interactive={false}
          />
          );
        })()}

        {mobileActions && (
          <MobileEntryActions
            entry={mobileActions.entry}
            anchor={mobileActions.point}
            open
            onOpenChange={(next) => {
              if (!next) setMobileActions(null);
            }}
            onMarkAbove={handleMarkAboveEntry}
          />
        )}

      </div>
    </div>
  );
}

function EntryListSkeleton() {
  const cardImageSize = useUISettingKey("cardImageSize") ?? "small";
  const showThumb = cardImageSize !== "none";
  const isLarge = cardImageSize === "large";

  return (
    <div className="space-y-1.5 py-2">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          className="mx-2 animate-pulse rounded-xl border border-transparent p-3"
        >
          {/* 来源行 + favicon + 时间 */}
          <div className="flex items-center gap-1.5">
            <div className="size-5 rounded-[6px] bg-secondary/70" />
            <div className="h-3 w-24 rounded bg-secondary/70" />
            <div className="h-3 w-12 rounded bg-secondary/60" />
          </div>

          <div
            className={cn(
              "mt-2",
              showThumb && !isLarge && "flex items-start gap-3",
            )}
          >
            <div className="min-w-0 flex-1">
              {/* 标题两行 */}
              <div className="h-4 w-4/5 rounded bg-secondary/70" />
              <div className="mt-1 h-4 w-3/5 rounded bg-secondary/70" />
              {/* 摘要三行（对齐卡片的摘要行高） */}
              <div className="mt-2 h-3 w-full rounded bg-secondary/60" />
              <div className="mt-1 h-3 w-11/12 rounded bg-secondary/60" />
              <div className="mt-1 h-3 w-2/3 rounded bg-secondary/60" />
            </div>

            {showThumb && (
              <div
                className={cn(
                  "shrink-0 rounded-lg bg-secondary/70",
                  isLarge ? "mt-3 aspect-video w-full" : "size-[76px]",
                )}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function EntryListEmpty() {
  const { t } = useTranslation();
  // 对齐 Nextflux 的 EmptyPlaceholder：图标 + 文案，整体压暗到 60%
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground opacity-60">
      <Inbox className="size-16" strokeWidth={1.5} />
      <p className="text-sm">{t("entry_list.no_articles")}</p>
    </div>
  );
}

function LoadingMore() {
  return (
    <div className="flex items-center justify-center py-4">
      <svg
        className="size-5 animate-spin text-muted-foreground"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
    </div>
  );
}
