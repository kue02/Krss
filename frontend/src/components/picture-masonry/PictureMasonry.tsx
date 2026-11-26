import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import { VirtuosoMasonry } from "@virtuoso.dev/masonry";
import { useEntriesInfinite, useUnreadCounts } from "@/hooks/useEntries";
import { useFeeds } from "@/hooks/useFeeds";
import { useFolders } from "@/hooks/useFolders";
import { useMasonryColumn } from "@/hooks/useMasonryColumn";
import { useSwipeGesture } from "@/hooks/useSwipeGesture";
import { selectionToParams, type SelectionType } from "@/hooks/useSelection";
import { flattenUniqueEntries } from "@/lib/entry-pagination";
import { cn } from "@/lib/utils";
import { useImageDimensionsStore } from "@/stores/image-dimensions-store";
import { PictureItem } from "./PictureItem";
import { PictureHoverList } from "@/components/picture-hover/PictureHoverList";
import { PictureWall } from "@/components/picture-wall/PictureWall";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import { useScrollToTop } from "@/hooks/useScrollToTop";
import { useMasonryScrollMarkRead } from "./useMasonryScrollMarkRead";
import {
  useUISettingKey,
  useUISettingActions,
  resolvePictureLayout,
  resolveGridStyle,
  resolveExperimentalLayoutVisibility,
} from "@/hooks/useUISettings";
import { getEntryImages } from "@/lib/extract-images";
import { EntryListHeader } from "@/components/entry-list/EntryListHeader";
import { MobileDocumentHeader } from "@/components/layout/MobileDocumentHeader";
import { useEntryListScrollSurface } from "@/components/entry-list/scroll-surface";
import type { ContentType, Entry, Feed } from "@/types/api";

interface PictureMasonryProps {
  selection: SelectionType;
  contentType: ContentType;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  onMarkAllRead: () => void;
  isMobile?: boolean;
  onMenuClick?: () => void;
  isTablet?: boolean;
  onToggleSidebar?: () => void;
  sidebarVisible?: boolean;
  /** 52-4：点格子里的「源名 / 图标」→ 第一栏选中该订阅 */
  onSelectFeedFromEntry?: (feedId: string) => void;
  /** 52-4：这次跳来自某个订阅时，列表头出「返回」 */
  feedJumpBackHref?: string | null;
  onBackFromFeedJump?: () => void;
  /** 移动端顶栏搜索入口（App 打开 SearchModal）；不传不渲染 */
  onSearchClick?: () => void;
}

interface MasonryItem {
  entry: Entry;
  feed?: Feed;
}

function getSelectionKey(selection: SelectionType): string {
  switch (selection.type) {
    case "feed":
      return selection.feedId;
    case "folder":
      return selection.folderId;
    case "all":
    case "starred":
      return selection.type;
  }
}

function findScrollableElement(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;

  const candidates = [
    root,
    ...Array.from(root.querySelectorAll<HTMLElement>("*")),
  ];
  return (
    candidates.find((element) => {
      const { overflowY } = getComputedStyle(element);
      return overflowY === "auto" || overflowY === "scroll";
    }) ?? null
  );
}

export function PictureMasonry({
  selection,
  contentType,
  unreadOnly,
  onToggleUnreadOnly,
  onMarkAllRead,
  isMobile,
  onMenuClick,
  isTablet,
  onToggleSidebar,
  sidebarVisible,
  onSelectFeedFromEntry,
  feedJumpBackHref,
  onBackFromFeedJump,
  onSearchClick,
}: PictureMasonryProps) {
  const { t } = useTranslation();
  const params = selectionToParams(selection, contentType);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollElementRef = useRef<HTMLElement>(null);
  const [internalScroller, setInternalScroller] = useState<HTMLElement | null>(
    null,
  );
  const usesDocumentScroll = Boolean(isMobile);
  const scrollElement = usesDocumentScroll
    ? document.documentElement
    : internalScroller;
  const scrollSurface = useEntryListScrollSurface({
    documentScroll: usesDocumentScroll,
    containerRef: scrollElementRef,
    headerRef,
  });
  const scrollToTop = useCallback(() => {
    scrollSurface.scrollTo(0, "smooth");
  }, [scrollSurface]);

  useScrollToTop(scrollToTop, "picture");

  // Swipe gesture: Right swipe opens sidebar (only on mobile)
  useSwipeGesture(wrapperRef, {
    onSwipeRight: () => onMenuClick?.(),
    enabledDirections: ["right"],
    threshold: 100,
    preventScroll: true,
    startFrom: { left: 32 },
    enabled: Boolean(isMobile && onMenuClick),
  });

  // 图片视图排布：瀑布流（默认）或等高正方格（用户 2026-09-17 要求可切）
  const pictureLayout = useUISettingKey("pictureLayout");
  // 28-7：档位收敛为两档（grid / hover），「正方格 vs 原图比例」降为 grid 档下的样式
  const resolvedLayout: "grid" | "hover" | "wall" =
    resolvePictureLayout(pictureLayout);
  const gridStyle = resolveGridStyle(pictureLayout, useUISettingKey("gridStyle"));
  const isGrid = resolvedLayout === "grid" && gridStyle === "square";
  /** 第三档：hover-img（复用 obsidianui 组件），走普通列表而不是瀑布流虚拟滚动 */
  const isHover = resolvedLayout === "hover";
  /** 第四档（31-1）：照片墙（obsidianui art-gallery，three.js）——铺照片本身、不按条目分组 */
  const isWall = resolvedLayout === "wall";
  /** 28-6：顶栏那颗档位切换（用户要求图片视图也加一个，三档循环） */
  const { setPictureLayout } = useUISettingActions();
  /** 28-7a：悬停大图档的尺寸预设（行高 / 浮块大小，用户要求可设置） */
  const hoverRowHeight = useUISettingKey("hoverRowHeight");
  const hoverImageSize = useUISettingKey("hoverImageSize");
  /**
   * 实验布局批：图片可切换档位（按实验可见性过滤）。
   * 常规只有「网格」；hover/wall 是实验档，仅当实验入口可见（或当前正选中它）才出现在循环里。
   * 若只剩网格一档 → 顶栏不渲染切换按钮（EntryListHeader 据 order.length>1 判断）。
   * 注意：已选中的实验布局仍照常渲染（这里只影响「入口」与循环，不影响 resolvedLayout）。
   */
  const expVisibility = resolveExperimentalLayoutVisibility({
    experimentalFeaturesEnabled: useUISettingKey("experimentalFeaturesEnabled"),
    experimentalPictureHover: useUISettingKey("experimentalPictureHover"),
    experimentalPictureWall: useUISettingKey("experimentalPictureWall"),
    experimentalArticleHover: useUISettingKey("experimentalArticleHover"),
    experimentalArticleRows: useUISettingKey("experimentalArticleRows"),
  });
  // 实验布局批：图片可切换档位严格按实验可见性生成（关闭即隐藏，不因当前正选中而泄漏）。
  // 常规只有「网格」；hover/wall 仅在对应实验开关打开时进入循环。
  // 已选中的实验布局仍照常渲染——入口隐藏不影响 resolvedLayout。
  const showPictureHover = expVisibility.pictureHover;
  const showPictureWall = expVisibility.pictureWall;
  const pictureLayoutOrder = useMemo<Array<"grid" | "hover" | "wall">>(() => {
    const order: Array<"grid" | "hover" | "wall"> = ["grid"];
    if (showPictureHover) order.push("hover");
    if (showPictureWall) order.push("wall");
    return order;
  }, [showPictureHover, showPictureWall]);
  const handleTogglePictureLayout = useCallback(() => {
    // 28-7 / 31-1：在「可见档位」里循环（网格 → 悬停大图 → 照片墙 → 网格）。
    // 实验布局批：hover/wall 未启用时循环里只有更少档；只剩一档则不切。
    const idx = Math.max(
      0,
      pictureLayoutOrder.findIndex((l) => l === resolvedLayout),
    );
    const next =
      pictureLayoutOrder[(idx + 1) % pictureLayoutOrder.length] ?? "grid";
    setPictureLayout(next);
  }, [pictureLayoutOrder, resolvedLayout, setPictureLayout]);
  const { currentColumn, isReady } = useMasonryColumn(
    isMobile,
    scrollContainerRef,
  );
  const loadFromDB = useImageDimensionsStore((state) => state.loadFromDB);
  const clearFailed = useImageDimensionsStore((state) => state.clearFailed);

  const { data: feeds = [] } = useFeeds();
  const { data: folders = [] } = useFolders();
  const { data: unreadCounts } = useUnreadCounts();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useEntriesInfinite({
      ...params,
      unreadOnly,
      hasThumbnail: true,
    });
  const { data: generalSettings } = useGeneralSettings();
  const markReadOnScroll = generalSettings?.markReadOnScroll ?? false;
  // 图片视图也可单独覆盖「滚动标已读」（设置 → 外观 → 按视图）
  const scrollReadByView = useUISettingKey("scrollReadByView");
  const scrollReadOverride = scrollReadByView?.picture ?? "inherit";
  const scrollReadEnabled =
    scrollReadOverride === "inherit"
      ? markReadOnScroll
      : scrollReadOverride === "on";

  const feedsMap = useMemo(() => {
    const map = new Map<string, Feed>();
    for (const feed of feeds) {
      map.set(feed.id, feed);
    }
    return map;
  }, [feeds]);

  const foldersMap = useMemo(() => {
    const map = new Map<string, { name: string }>();
    for (const folder of folders) {
      map.set(folder.id, folder);
    }
    return map;
  }, [folders]);

  const entries = useMemo(() => flattenUniqueEntries(data?.pages), [data]);

  const filterKey = useMemo(
    () => `${getSelectionKey(selection)}-${unreadOnly}`,
    [selection, unreadOnly],
  );

  // Clear failed images on mount and when filter context changes,
  // giving images a fresh chance to load (failures are often transient)
  useEffect(() => {
    clearFailed();
  }, [filterKey, clearFailed]);

  // Load cached dimensions from IndexedDB
  useEffect(() => {
    const srcs = entries
      .map((entry) => entry.thumbnailUrl)
      .filter((url): url is string => !!url);
    if (srcs.length > 0) {
      loadFromDB(srcs);
    }
  }, [entries, loadFromDB]);

  const items: MasonryItem[] = useMemo(
    () =>
      entries.map((entry) => ({
        entry,
        feed: feedsMap.get(entry.feedId),
      })),
    [entries, feedsMap],
  );

  /**
   * 灯箱画廊：把「当前已加载的条目」按顺序交给灯箱，这样左右箭头能跨条目走
   * （用户 2026-09-17 要求：同条目内先切图，切到头跳到下一条目并给简洁提示）。
   */
  const gallery = useMemo(
    () =>
      items
        .map(({ entry, feed }) => ({
          entry,
          feed,
          images: getEntryImages(
            entry.thumbnailUrl,
            entry.content,
            entry.url ?? undefined,
          ),
        }))
        .filter((item) => item.images.length > 0),
    [items],
  );

  const MasonryItemContent = useCallback(
    ({ data: item }: { data: MasonryItem }) => {
      if (!item?.entry) return null;
      return (
        <div data-entry-id={item.entry.id}>
          <PictureItem
            entry={item.entry}
            feed={item.feed}
            square={isGrid}
            gallery={gallery}
            onSelectFeedFromEntry={onSelectFeedFromEntry}
          />
        </div>
      );
    },
    [isGrid, gallery, onSelectFeedFromEntry],
  );

  // Reset before passive scroll effects can inspect a previous view's position.
  useLayoutEffect(() => {
    if (!scrollElement) return;
    scrollSurface.scrollTo(0);
  }, [filterKey, scrollElement, scrollSurface]);

  // Virtuoso creates its own scroller on desktop and uses the document on mobile.
  useEffect(() => {
    const wrapper = scrollContainerRef.current;
    if (!wrapper || !isReady) return;

    const handleScroll = () => {
      if (
        scrollSurface.getDistanceToBottom() < 300 &&
        hasNextPage &&
        !isFetchingNextPage
      ) {
        fetchNextPage();
      }
    };

    if (usesDocumentScroll) {
      const unsubscribe = scrollSurface.subscribe(handleScroll);
      handleScroll();
      return unsubscribe;
    }

    let internalScroller: HTMLElement | null = null;
    let observer: MutationObserver | null = null;

    const setupScrollListener = () => {
      const nextScroller = findScrollableElement(wrapper);
      if (!nextScroller || nextScroller === internalScroller) {
        return Boolean(internalScroller);
      }

      internalScroller?.removeEventListener("scroll", handleScroll);
      internalScroller = nextScroller;
      scrollElementRef.current = nextScroller;
      setInternalScroller(nextScroller);
      nextScroller.addEventListener("scroll", handleScroll, { passive: true });
      return true;
    };

    if (!setupScrollListener()) {
      observer = new MutationObserver(() => {
        if (setupScrollListener() && observer) {
          observer.disconnect();
          observer = null;
        }
      });
      observer.observe(wrapper, { childList: true, subtree: true });
    }

    return () => {
      observer?.disconnect();
      internalScroller?.removeEventListener("scroll", handleScroll);
      scrollElementRef.current = null;
      setInternalScroller((current) =>
        current === internalScroller ? null : current,
      );
    };
  }, [
    fetchNextPage,
    filterKey,
    hasNextPage,
    isFetchingNextPage,
    isReady,
    scrollSurface,
    usesDocumentScroll,
  ]);

  const { endPaddingHeight: scrollReadEndPaddingHeight } =
    useMasonryScrollMarkRead({
      scrollElement,
      scrollSurface,
      entries,
      enabled: scrollReadEnabled,
      unreadOnly,
      hasNextPage: Boolean(hasNextPage),
      resetKey: `${filterKey}\u0000${scrollReadEnabled}`,
    });
  const title = useMemo(() => {
    switch (selection.type) {
      case "all":
        return t("entry_list.all_pictures");
      case "feed":
        return feedsMap.get(selection.feedId)?.title || t("entry_list.feed");
      case "folder":
        return (
          foldersMap.get(selection.folderId)?.name || t("entry_list.folder")
        );
      case "starred":
        return t("entry_list.starred");
    }
  }, [selection, feedsMap, foldersMap, t]);

  const unreadCount = useMemo(() => {
    if (!unreadCounts) return 0;
    const counts = unreadCounts.counts;
    switch (selection.type) {
      case "all":
        return feeds
          .filter((f) => f.type === contentType)
          .reduce((sum, f) => sum + (counts[f.id] ?? 0), 0);
      case "feed":
        return counts[selection.feedId] ?? 0;
      case "folder":
        return feeds
          .filter(
            (f) => f.folderId === selection.folderId && f.type === contentType,
          )
          .reduce((sum, f) => sum + (counts[f.id] ?? 0), 0);
      case "starred":
        return 0;
    }
  }, [unreadCounts, selection, feeds, contentType]);

  // 实验布局批：当前正用着已停用的实验布局 —— 保留渲染，但给一条「切回常规」逃生条
  const disabledExperimentNotice =
    (resolvedLayout === "hover" && !expVisibility.pictureHover) ||
    (resolvedLayout === "wall" && !expVisibility.pictureWall);

  return (
    <div
      ref={wrapperRef}
      className={cn(
        usesDocumentScroll ? "min-h-[var(--app-dvh)]" : "flex h-full flex-col",
      )}
    >
      <MobileDocumentHeader
        enabled={usesDocumentScroll}
        headerRef={headerRef}
        testId="picture-masonry-header"
      >
        <EntryListHeader
          title={title}
          onBackFromFeedJump={feedJumpBackHref ? onBackFromFeedJump : undefined}
          unreadCount={unreadCount}
          unreadOnly={unreadOnly}
          onToggleUnreadOnly={onToggleUnreadOnly}
          onMarkAllRead={onMarkAllRead}
          scrollToTopScope="picture"
          isMobile={isMobile}
          onMenuClick={onMenuClick}
          isTablet={isTablet}
          onToggleSidebar={onToggleSidebar}
          sidebarVisible={sidebarVisible}
          pictureLayout={resolvedLayout}
          onTogglePictureLayout={handleTogglePictureLayout}
          pictureLayoutOrder={pictureLayoutOrder}
          onSearchClick={onSearchClick}
        />
      </MobileDocumentHeader>

      {disabledExperimentNotice && (
        <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <span>{t("appearance_view.experimental_disabled_hint")}</span>
          <button
            type="button"
            onClick={() => setPictureLayout("grid")}
            className="shrink-0 rounded-md px-2 py-1 font-medium underline underline-offset-2 hover:bg-amber-500/15"
          >
            {t("appearance_view.switch_to_regular")}
          </button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        className={cn(
          "[overflow-anchor:none]",
          usesDocumentScroll
            ? "min-h-[calc(var(--app-dvh)-3.5rem)]"
            : "min-h-0 flex-1 overflow-hidden",
        )}
      >
        {isLoading ? (
          <div
            className={cn("p-4", !usesDocumentScroll && "h-full overflow-auto")}
          >
            <MasonrySkeleton />
          </div>
        ) : entries.length === 0 ? (
          <div
            className={cn(
              "flex flex-col p-4",
              usesDocumentScroll
                ? "min-h-[calc(var(--app-dvh)-2.75rem-3.5rem)]"
                : "h-full overflow-auto",
            )}
          >
            <EmptyState />
          </div>
        ) : isReady && isWall ? (
          /* 31-1：照片墙铺满内容区（不做 p-4 内边距 —— 原件是整块 WebGL 画布） */
          <PictureWall
            items={items}
            className={
              usesDocumentScroll ? "h-[70vh] min-h-96 w-full" : "h-full w-full"
            }
          />
        ) : isReady && isHover ? (
          <div className={cn("p-4", !usesDocumentScroll && "h-full overflow-auto")}>
            <PictureHoverList
              items={items}
              rowHeight={hoverRowHeight}
              imageSize={hoverImageSize}
            />
          </div>
        ) : isReady ? (
          /* key 里必须带上 gridStyle：VirtuosoMasonry 只在 data / columnCount 这类输入变化时
             重建内部项，换 ItemContent（新的 useCallback）它不理会 —— 表现为改了「网格 · 样式」
             后已挂载的卡片不变，必须刷新整页才生效。带上样式即强制重建。 */
          <VirtuosoMasonry
            key={`${filterKey}-${resolvedLayout}-${gridStyle}`}
            data={items}
            columnCount={currentColumn}
            ItemContent={MasonryItemContent}
            useWindowScroll={usesDocumentScroll}
            className={cn("p-4", !usesDocumentScroll && "h-full")}
            style={{ paddingBottom: scrollReadEndPaddingHeight || undefined }}
          />
        ) : null}
        {isFetchingNextPage && <LoadingMore />}
      </div>
    </div>
  );
}

function MasonrySkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="animate-pulse">
          <div className="bg-secondary" style={{ height: 150 + (i % 3) * 50 }} />
          <div className="mt-2 flex items-center gap-2">
            <div className="size-4 rounded bg-secondary" />
            <div className="h-3 w-20 rounded bg-secondary" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-2 text-muted-foreground opacity-60">
      <ImageOff className="size-16" strokeWidth={1.5} />
      <p className="text-sm">{t("entry_list.no_articles")}</p>
    </div>
  );
}

function LoadingMore() {
  return (
    <div className="flex items-center justify-center py-8">
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
