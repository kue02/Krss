import {
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { useEntriesInfinite, useUnreadCounts, useMarkManyAsRead } from "@/hooks/useEntries";
import { AlertDialog, Button } from "@heroui/react";
import { useFeeds } from "@/hooks/useFeeds";
import { useRefreshStatus } from "@/hooks/useRefreshStatus";
import { queryClient } from "@/lib/queryClient";
import { getRefreshStatus, refreshAllFeeds, refreshFeeds } from "@/api";
import { showToast } from "@/stores/toast-store";
import { useFolders } from "@/hooks/useFolders";
import { useAISettings } from "@/hooks/useAISettings";
import { useSwipeGesture } from "@/hooks/useSwipeGesture";
import { selectionToParams, type SelectionType } from "@/hooks/useSelection";
import { flattenUniqueEntries } from "@/lib/entry-pagination";
import { stripHtml } from "@/lib/html-utils";
import { EntryListItem } from "./EntryListItem";
import {
  EntryListFilterPill,
  type EntryFilter,
} from "./EntryListFilterPill";
import { EntryListHeader } from "./EntryListHeader";
import { needsTranslation as needsTranslationAsync } from "@/lib/language-detect-async";
import {
  translateArticlesBatch,
  cancelAllBatchTranslations,
} from "@/services/translation-service";
import { translationActions } from "@/stores/translation-store";
import { selectionScrollKey, entryListScrollPositions } from "./scroll-key";
import { useScrollToTop } from "@/hooks/useScrollToTop";
import { MobileDocumentHeader } from "@/components/layout/MobileDocumentHeader";
import { cn } from "@/lib/utils";
import { useScrollMarkRead } from "./useScrollMarkRead";
import {
  getDeferredRemovalsVersion,
  mergeDeferredRemovals,
  subscribeDeferredRemovals,
} from "./deferred-removal";
import { useEntryListScrollSurface } from "./scroll-surface";
import { useEntryHotkeys } from "@/hooks/useEntryHotkeys";
import { useUISettingKey } from "@/hooks/useUISettings";
import {
  resolveTimelineCollapse,
  resolveTimelineGranularity,
} from "@/lib/timeline-model";
import { NotificationTimeline } from "./NotificationTimeline";
import { useScrollReadSetting } from "@/hooks/useScrollReadSetting";
import { useFilterViewStore } from "@/stores/filter-view-store";
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


interface EntryListProps {
  selection: SelectionType;
  selectedEntryId: string | null;
  onSelectEntry: (entryId: string) => void;
  /** Esc 关闭详情（交回列表） */
  onCloseEntry?: () => void;
  onMarkAllRead: () => void;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  /**
   * 底部筛选胶囊：星标 / 未读 / 全部 的切换（一次导航，见 useSelection.selectFilter）。
   * 第四个状态「已静音」不走导航（路由里没有这个维度），由 EntryList 本地承载，
   * 所以这里的回调类型不含 "muted"。
   */
  onFilterChange?: (filter: Exclude<EntryFilter, "muted">) => void;
  /** 12-6：星标视图下的「只查看当前视图」开关（与侧栏那个是同一个语义） */
  onToggleStarredViewOnly?: () => void;
  contentType: ContentType;
  isMobile?: boolean;
  onMenuClick?: () => void;
  isTablet?: boolean;
  onToggleSidebar?: () => void;
  sidebarVisible?: boolean;
  isActive?: boolean;
}

export function EntryList({
  selection,
  selectedEntryId,
  onSelectEntry,
  onCloseEntry,
  onMarkAllRead,
  unreadOnly,
  onToggleUnreadOnly,
  onFilterChange,
  contentType,
  isMobile,
  onMenuClick,
  isTablet,
  onToggleSidebar,
  sidebarVisible,
  isActive = true,
  onToggleStarredViewOnly,

}: EntryListProps) {
  "use no memo";

  const { t } = useTranslation();
  /**
   * 「已静音」是独立于三态胶囊的回看态（2026-09-17 起入口在 设置 → 自动化）。
   *
   * 星标 / 未读对应路由里的 selection 与 unreadOnly，切换一次导航；「已静音」没有对应的
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

  // 中栏胶囊的三态（星标 > 未读 > 全部）。「已静音」不再是胶囊的一态 ——
  // 它是独立的回看入口，入口在 设置 → 自动化（2026-09-17 用户要求），状态见 mutedOnly
  const filterValue: EntryFilter =
    selection.type === "starred"
      ? "starred"
      : unreadOnly
        ? "unread"
        : "all";
  // 「已静音」是独立的回看视图，不叠加「只看未读」——否则规则静音前已读的条目就回看不到了
  const effectiveUnreadOnly = mutedOnly ? false : unreadOnly;

  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const listWrapperRef = useRef<HTMLDivElement>(null);
  const usesDocumentScroll = Boolean(isMobile);
  const scrollSurface = useEntryListScrollSurface({
    documentScroll: usesDocumentScroll,
    containerRef,
    headerRef,
  });
  const scrollToTop = useCallback(() => {
    scrollSurface.scrollTo(0, "smooth");
  }, [scrollSurface]);

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
  const timelineGranularity = resolveTimelineGranularity(
    useUISettingKey("timelineGranularityByView")?.[contentType],
  );
  const timelineCollapse = resolveTimelineCollapse(
    useUISettingKey("timelineCollapseByView")?.[contentType],
  );
  /** 窄栏自动合一栏（默认开；关掉则始终左右交替） */
  const timelineAutoSingleSide =
    useUISettingKey("timelineSingleSideByView")?.[contentType] !== false;
  /**
   * 轴上可选的条目（被吸进小节点的条目不算节点）：时间线组件回报上来，
   * 键盘 j/k、↑/↓ 就用它做吸附顺序 —— 不会选到看不见的条目。
   */
  const [timelineSelectableEntries, setTimelineSelectableEntries] = useState<
    Entry[] | null
  >(null);
  const fetchReadableByView = useUISettingKey("fetchReadableByView");
  const expandLongByView = useUISettingKey("expandLongByView");
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
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
      showToast(t("entry.refresh_done"));
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

  const { endPaddingHeight: scrollReadEndPaddingHeight } = useScrollMarkRead({
    surface: scrollSurface,
    contentRootRef: containerRef,
    entries,
    enabled: scrollReadEnabled && isActive,
    unreadOnly: effectiveUnreadOnly,
    hasNextPage: Boolean(hasNextPage),
    resetKey: `${scrollKey}\u0000${effectiveUnreadOnly}\u0000${scrollReadEnabled}`,
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
      translateArticlesBatch(articlesToTranslate, targetLanguage).finally(
        () => {
          // Remove entries that didn't actually get translated (cancelled, partial failure, etc.)
          for (const article of articlesToTranslate) {
            const cached = translationActions.get(article.id, targetLanguage);
            if (!cached?.title && !cached?.summary) {
              translatedEntries.current.delete(article.id);
            }
          }
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

      void needsTranslationAsync(entry.title || "", summary, targetLanguage)
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

  // 底部筛选胶囊的当前态 filterValue 在文件上方定义（列表参数要用到它）
  // 「已静音」是回看视图：标题跟着变，并给一行说明（这条视图里看到的不是新内容，而是被规则收起来的）
  const headerTitle =
    mutedOnly
      ? t("entry_filter.muted")
      : activeViewId && activeViewName
        ? activeViewName
        : title;
  const headerSubtitle =
    mutedOnly
      ? t("automation.muted_view_hint")
      : activeViewId
        ? t("automation.view_active_hint")
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
      <MobileDocumentHeader
        enabled={usesDocumentScroll}
        headerRef={headerRef}
        testId="entry-list-header"
      >
        <EntryListHeader
          title={headerTitle}
          subtitle={headerSubtitle}
          unreadCount={unreadCount}
          unreadOnly={unreadOnly}
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
          scrollToTopScope="entrylist"
          isMobile={isMobile}
          onMenuClick={handleMenuClick}
          isTablet={isTablet}
          onToggleSidebar={onToggleSidebar}
          sidebarVisible={sidebarVisible}
        />

        {/* 强制拉取确认（范围太大时先问一句，避免误选整轮重抓） */}
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
          className={cn(
            "w-full overflow-x-hidden rounded-[inherit] [overflow-anchor:none]",
            usesDocumentScroll
              ? "overflow-y-visible"
              : "h-full overflow-y-auto overscroll-y-contain",
          )}
        >
          {isLoading ? (
            <EntryListSkeleton />
          ) : entries.length === 0 ? (
            <EntryListEmpty />
          ) : (
            <div className="w-full pb-16">
              {/* pb-16：底部悬浮的「星标 / 未读 / 已静音 / 全部」胶囊会盖住内容，留白让最后一条能滚上来 */}
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
                  autoSingleSide={timelineAutoSingleSide}
                  autoTranslate={autoTranslate}
                  targetLanguage={targetLanguage}
                  onSelectableEntriesChange={setTimelineSelectableEntries}
                />
              ) : (
                entries.map((entry, index) => (
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
                  />
                ))
              )}
              {/* 24-5：列表尾整宽弱边框「全部标记为已读」（语义=清当前范围未读，
                  与列表头那颗同接口 onMarkAllRead；胶囊浮在下面，pb-16 已留白） */}
              {entries.length > 0 && (
                <div className="mx-2 mt-1">
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

        {!usesDocumentScroll && (
          <EntryListFilterPill
            value={filterValue}
            onChange={(next) => {
              // 三态都走一次导航；「已静音」已从这里移除（入口在 设置 → 自动化）
              onFilterChange?.(next);
            }}
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
