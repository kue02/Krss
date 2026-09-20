import {
  Suspense,
  lazy,
  useCallback,
  useState,
  useMemo,
  useEffect,
} from "react";
import { Router, useLocation, Redirect } from "wouter";
import { useTranslation } from "react-i18next";
import {
  SETTINGS_SAVED_EVENT,
  SETTINGS_SYNC_FAILED_EVENT,
} from "@/lib/settings-saved";
import { SETTINGS_MOBILE_BREAKPOINT, initSettingsSync } from "@/lib/settings-sync";
import { showToast } from "@/stores/toast-store";
import { ThreeColumnLayout } from "@/components/layout/three-column-layout";
import { Sheet } from "@/components/ui/sheet";
import { MotionConfig } from "framer-motion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/sidebar";
import { AddFeedPage } from "@/components/add-feed";
import { EntryList } from "@/components/entry-list";
import { PictureMasonry, Lightbox } from "@/components/picture-masonry";
import { ScrollToTopZone } from "@/components/layout/ScrollToTopZone";
import { ImagePreview } from "@/components/ui/image-preview";
import { LoginPage, RegisterPage, NetworkErrorPage } from "@/components/auth";
import { UpdateNotice } from "@/components/update-notice";
import { Toaster } from "@/components/ui/toaster";
import { RefreshReportDialog } from "@/components/refresh/RefreshReportDialog";
import { useRefreshReportWatcher } from "@/hooks/useRefreshReportWatcher";
import { FilterEditorDialog } from "@/components/automation/FilterEditorDialog";
import { SettingsModal, ProfileModal } from "@/components/settings";
import {
  useSettingsModalStore,
  useProfileModalStore,
} from "@/stores/settings-modal-store";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { refreshAllFeeds } from "@/api";
import { ShortcutsHelpDialog } from "@/components/shortcuts/ShortcutsHelpDialog";
import { SearchModal } from "@/components/search/SearchModal";
import { VideoPreview } from "@/components/ui/video-preview";
import { useGlobalHotkeys } from "@/hooks/useGlobalHotkeys";
import {
  shortcutsHelp,
  useShortcutsHelpOpen,
} from "@/stores/shortcuts-store";
import { useSelection, selectionToParams } from "@/hooks/useSelection";
import { useMarkAllAsRead, useEntry } from "@/hooks/useEntries";
import { useMobileLayout } from "@/hooks/useMobileLayout";
import { useMobileDocumentScrollMode } from "@/hooks/useMobileDocumentScrollMode";
import { useAuth } from "@/hooks/useAuth";
import { useFeeds } from "@/hooks/useFeeds";
import { useFolders } from "@/hooks/useFolders";
import { useAppearanceSettings } from "@/hooks/useAppearanceSettings";
import { useTitle, buildTitle } from "@/hooks/useTitle";
import {
  useUISettingKey,
  useUISettingActions,
  hasSidebarVisibilitySetting,
  setUISetting,
  applyAccentColorToDocument,
  applyQuoteStyleToDocument,
  applyComponentRadiusToDocument,
  applyFieldRadiusToDocument,
  applyIconRadiusToDocument,
  applyReduceMotionToDocument,
  applyUiScaleToDocument,
  refreshDeviceScopedSettings,
} from "@/hooks/useUISettings";
import { useRefreshStatus } from "@/hooks/useRefreshStatus";
import { isAddFeedPath } from "@/lib/router";
import { initProxyImageRecovery } from "@/lib/proxy-image-recovery";
import { cn } from "@/lib/utils";
import type { ContentType, Feed, Folder } from "@/types/api";

const defaultContentTypes: ContentType[] = [
  "article",
  "picture",
  "notification",
  "social",
];
const LazyEntryContent = lazy(async () => {
  const module = await import("@/components/entry-content");
  return { default: module.EntryContent };
});

function LoadingScreen() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full w-full items-center justify-center overflow-x-clip bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">{t("entry.loading")}</p>
      </div>
    </div>
  );
}

function EntryContentPlaceholder({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center px-6" />
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-center text-muted-foreground opacity-60">
          <svg
            className="size-16"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <p className="text-sm">{message}</p>
        </div>
      </div>
    </div>
  );
}

function EntryContentFallback() {
  return (
    <div className="relative flex h-full flex-col animate-pulse">
      <div className="absolute inset-x-0 top-0 z-20">
        <div className="h-12" />
      </div>
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 pb-20 pt-16">
          <div className="mb-10 space-y-5">
            <div className="h-10 w-3/4 rounded bg-secondary" />
            <div className="flex gap-6">
              <div className="h-4 w-24 rounded bg-secondary" />
              <div className="h-4 w-32 rounded bg-secondary" />
            </div>
            <hr className="border-border/60" />
          </div>
          <div className="space-y-4">
            <div className="h-4 w-full rounded bg-secondary" />
            <div className="h-4 w-full rounded bg-secondary" />
            <div className="h-4 w-3/4 rounded bg-secondary" />
            <div className="h-4 w-full rounded bg-secondary" />
            <div className="h-4 w-5/6 rounded bg-secondary" />
          </div>
        </div>
      </div>
    </div>
  );
}

function AuthenticatedApp() {
  const [location, navigate] = useLocation();
  const {
    isMobile,
    isTablet,
    mobileView,
    sidebarOpen,
    setSidebarOpen,
    showList,
    openSidebar,
    closeSidebar,
  } = useMobileLayout();

  /**
   * 21 批（2026-09-18）：登录后把「界面设置」与服务端对齐一次。
   *   服务端一条没存过（首次迁移）或本地有没推上去的改动 → 以本地为准推上去；
   *   否则**服务端为准**覆盖本地 —— 这就是「换台设备打开是同一套设置」。
   * 放在这个组件里是因为它只在已登录时渲染，未登录时不会发这个请求。
   */
  useEffect(() => {
    void initSettingsSync();
  }, []);

  /**
   * 21 批：尺寸类（列宽 / 整体缩放 / 侧栏显隐）按设备分套存，
   * 窗口跨过 768px 断点就换到另一套；matchMedia 的 change 只在跨断点时触发，比监听 resize 省事。
   */
  useEffect(() => {
    const media = window.matchMedia(
      `(min-width: ${SETTINGS_MOBILE_BREAKPOINT}px)`,
    );
    const onChange = () => refreshDeviceScopedSettings();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const {
    selection,
    selectAll,
    selectFeed,
    selectFolder,
    selectStarred,
    selectFilter,
    selectedEntryId,
    selectEntry,
    unreadOnly,
    toggleUnreadOnly,
    contentType,
  } = useSelection();

  const { mutate: markAllAsRead } = useMarkAllAsRead();
  const [addFeedContentType, setAddFeedContentType] =
    useState<ContentType>("article");

  // Poll refresh status and auto-invalidate entries when scheduled refresh completes
  useRefreshStatus();

  // ── 全局快捷键：? 快捷键帮助，r 刷新订阅 ──────────────────────────────
  const isShortcutsOpen = useShortcutsHelpOpen();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const queryClient = useQueryClient();
  const refreshFeeds = useMutation({
    // 快捷键 r：普通刷新（强制拉取走中栏刷新图标的右键菜单，带确认）
    mutationFn: () => refreshAllFeeds(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
    },
  });
  const handleToggleShortcuts = useCallback(() => shortcutsHelp.toggle(), []);
  const handleRefreshShortcut = useCallback(
    () => refreshFeeds.mutate(),
    [refreshFeeds],
  );
  useGlobalHotkeys({
    onToggleHelp: handleToggleShortcuts,
    onRefresh: handleRefreshShortcut,
    onSearch: () => setIsSearchOpen(true),
    enabled: !isShortcutsOpen,
  });

  // Sidebar visibility for tablet/desktop
  const sidebarVisible = useUISettingKey("sidebarVisible");
  const { toggleSidebarVisible } = useUISettingActions();

  // Initialize sidebar visibility for tablet on first visit
  useEffect(() => {
    // Only run on tablet, and only if sidebarVisible has never been set
    if (isTablet && !hasSidebarVisibilitySetting()) {
      setUISetting("sidebarVisible", false);
    }
  }, [isTablet]);

  // Calculate whether to show sidebar based on breakpoint
  // Desktop (>= 1366): always show
  // Tablet (768-1366): user preference (default false on first visit)
  // Mobile (< 768): use Sheet overlay
  const showSidebar = useMemo(() => {
    if (isMobile) return false; // Mobile uses Sheet
    if (isTablet) return sidebarVisible; // Tablet respects user preference
    return true; // Desktop always shows sidebar
  }, [isMobile, isTablet, sidebarVisible]);

  // Dynamic title management
  const { t } = useTranslation();
  const { data: feeds = [] } = useFeeds();
  const { data: folders = [] } = useFolders();
  const { data: appearanceSettings, isLoading: isAppearanceLoading } =
    useAppearanceSettings();
  const { data: entry } = useEntry(selectedEntryId);

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

  const title = buildTitle({
    selection,
    contentType,
    entryTitle: entry?.title,
    feedsMap,
    foldersMap,
    t,
  });

  useTitle(title);

  /**
   * 12-6：星标视图下切换「只查看当前视图」（只看当前内容类型的星标）。
   * 侧栏那一档已按 20-2 收敛掉，现在只剩中栏列表头那个图标按钮走这里。
   */
  const handleToggleStarredViewOnly = useCallback(() => {
    if (selection.type !== "starred") return;
    selectStarred({ replace: true }, !selection.viewOnly);
  }, [selectStarred, selection]);

  // Mobile-aware selection handlers (all hooks must be before any conditional returns)
  // Use replace to avoid creating history entries for sidebar navigation
  const handleSelectFeed = useCallback(
    (feedId: string) => {
      closeSidebar();
      selectFeed(feedId, { replace: true });
    },
    [selectFeed, closeSidebar],
  );

  const handleSelectFolder = useCallback(
    (folderId: string) => {
      closeSidebar();
      selectFolder(folderId, { replace: true });
    },
    [selectFolder, closeSidebar],
  );

  /**
   * 20-2：星标入口收敛后只剩这一个入口（侧栏那一行）——**默认进「只当前视图」那一档**
   * （用户 2026-09-18：「默认选中」）。要看全部星标就在第二栏列表头把那个图标按钮关掉。
   */
  const handleSelectStarred = useCallback(() => {
    closeSidebar();
    selectStarred({ replace: true }, true);
  }, [selectStarred, closeSidebar]);

  const handleAddClick = useCallback(
    (ct: ContentType) => {
      setAddFeedContentType(ct);
      closeSidebar();
      navigate(`/add-feed?type=${ct}`, { replace: true });
    },
    [navigate, closeSidebar],
  );

  const handleCloseAddFeed = useCallback(() => {
    navigate(`/all?type=${contentType}`, { replace: true });
  }, [navigate, contentType]);

  const handleMarkAllRead = useCallback(() => {
    markAllAsRead(selectionToParams(selection, contentType));
  }, [markAllAsRead, selection, contentType]);

  const handleSelectAll = useCallback(
    (type?: ContentType) => {
      closeSidebar();
      selectAll(type, { replace: true });
    },
    [selectAll, closeSidebar],
  );

  const handleFilterChange = useCallback(
    (filter: "all" | "unread" | "starred") => {
      closeSidebar();
      selectFilter(filter, { replace: true });
    },
    [selectFilter, closeSidebar],
  );

  // 「减少动态效果」落到 <html data-reduce-motion>，由 CSS 统一压掉动画
  // 刷新结果弹框：盯住「刷新中 → 刷新完」的跳变（用户 11-8）
  useRefreshReportWatcher();

  // 24-4：代理图 401 全局兜底（续期 cookie 后重载），挂一次
  useEffect(() => {
    initProxyImageRecovery();
  }, []);

  const reduceMotion = useUISettingKey("reduceMotion");
  useEffect(() => {
    applyReduceMotionToDocument(Boolean(reduceMotion));
  }, [reduceMotion]);

  // 「引文样式」落到 <html data-quote-style>：强调块 / Folo 式分割线
  const quoteStyle = useUISettingKey("quoteStyle");
  useEffect(() => {
    applyQuoteStyleToDocument(quoteStyle);
  }, [quoteStyle]);

  // 18 批：圆角（设置 → 外观 → 形状）—— 组件 / 表单 / 订阅图标 三个旋钮
  const componentRadius = useUISettingKey("componentRadius");
  const fieldRadius = useUISettingKey("fieldRadius");
  const iconRadius = useUISettingKey("iconRadius");

  // 主题色（设置 → 外观 → 主题 → 主题色）：null = 跟随主题
  const accentColor = useUISettingKey("accentColor");
  useEffect(() => {
    applyAccentColorToDocument(accentColor ?? null);
  }, [accentColor]);

  // 「界面字号」改 <html> 基准字号（界面用的都是 rem，整体跟着缩放）
  const uiScale = useUISettingKey("uiScale");
  useEffect(() => {
    applyUiScaleToDocument(uiScale);
  }, [uiScale]);

  // 18 批：圆角（组件 / 表单 / 订阅图标 三个旋钮），落 <html> 上的 CSS 变量；默认档把变量摘掉
  useEffect(() => {
    applyComponentRadiusToDocument(componentRadius);
  }, [componentRadius]);

  useEffect(() => {
    applyFieldRadiusToDocument(fieldRadius);
  }, [fieldRadius]);

  useEffect(() => {
    applyIconRadiusToDocument(iconRadius);
  }, [iconRadius]);

  /**
   * 12-7：即时型设置项（开关 / 数量 / 下拉）改一下就落库，这里给一句「已保存」。
   * 防抖 700ms：连续拨数字或连点开关只在停手后提示一次，避免刷屏。
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onSaved = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => showToast(t("settings.saved_toast")), 700);
    };
    window.addEventListener(SETTINGS_SAVED_EVENT, onSaved);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener(SETTINGS_SAVED_EVENT, onSaved);
    };
  }, [t]);

  /**
   * 21 批：设置「写服务端」失败必须看得见 —— 本地那份（缓存）已经改好了、界面也已经生效，
   * 只有上传这一步失败；不说的话用户会以为一切都保存好了，换台设备才发现少了一半。
   */
  useEffect(() => {
    const onSyncFailed = (event: Event) => {
      const reason =
        event instanceof CustomEvent && typeof event.detail === "string"
          ? event.detail
          : "";
      showToast(
        t("settings.sync_failed_toast", {
          reason: reason || t("settings.sync_failed_unknown"),
        }),
      );
    };
    window.addEventListener(SETTINGS_SYNC_FAILED_EVENT, onSyncFailed);
    return () => {
      window.removeEventListener(SETTINGS_SYNC_FAILED_EVENT, onSyncFailed);
    };
  }, [t]);

  const visibleContentTypes = useMemo(() => {
    const current = appearanceSettings?.contentTypes;
    if (!current || current.length === 0) return defaultContentTypes;
    return current.filter(
      (item) =>
        item === "article" ||
        item === "picture" ||
        item === "notification" ||
        item === "social",
    );
  }, [appearanceSettings]);

  useEffect(() => {
    if (!visibleContentTypes.includes(contentType)) {
      const next = visibleContentTypes[0] ?? "article";
      selectAll(next, { replace: true });
    }
  }, [visibleContentTypes, contentType, selectAll]);

  const usesMobileDocumentScroll = isMobile && !isAddFeedPath(location);
  useMobileDocumentScrollMode({
    enabled: usesMobileDocumentScroll,
    // Changing root overflow destabilizes viewport-pinned UI in iOS WebKit.
    // Only the full-screen detail view needs a document lock.
    locked: usesMobileDocumentScroll && mobileView === "detail",
  });

  const entryContent = selectedEntryId ? (
    <Suspense fallback={<EntryContentFallback />}>
      <LazyEntryContent key={selectedEntryId} entryId={selectedEntryId} />
    </Suspense>
  ) : (
    <EntryContentPlaceholder message={t("entry.select_article")} />
  );

  const mobileEntryContent = selectedEntryId ? (
    <Suspense fallback={<EntryContentFallback />}>
      <LazyEntryContent
        key={selectedEntryId}
        entryId={selectedEntryId}
        isMobile
        onBack={showList}
      />
    </Suspense>
  ) : (
    <EntryContentPlaceholder message={t("entry.select_article")} />
  );

  // Redirect root to /all with first visible type (must be after ALL hooks including useCallback)
  if (location === "/") {
    // 等待 appearanceSettings 加载完成再跳转，避免先跳 article 再跳正确类型
    if (isAppearanceLoading) {
      return <div className="h-full bg-background" />;
    }
    const defaultType = visibleContentTypes[0] ?? "article";
    return <Redirect to={`/all?type=${defaultType}`} replace />;
  }

  // 等待 appearanceSettings 加载完成，避免显示默认三视图的闪烁
  if (isAppearanceLoading) {
    return <div className="h-full bg-background" />;
  }

  // Sidebar component (shared between mobile and desktop)
  const sidebarContent = (
    <Sidebar
      onAddClick={handleAddClick}
      selection={selection}
      onSelectFeed={handleSelectFeed}
      onSelectFolder={handleSelectFolder}
      onSelectStarred={handleSelectStarred}
      onSelectAll={handleSelectAll}
      contentType={contentType}
      appearanceSettings={appearanceSettings}
      // 移动端：侧栏里的设置/资料弹窗打开时先关 Sheet，否则 Sheet 的滚动锁
      // 会吃掉弹窗内容区的滚动（移动端设置滑不动，2026-09-20）。
      onRequestClose={closeSidebar}
    />
  );

  // Mobile layout - Sheet is rendered once at the top level to prevent animation flickering
  if (isMobile) {
    // Determine mobile content based on current route/mode
    let mobileContent: React.ReactNode;

    if (isAddFeedPath(location)) {
      mobileContent = (
        <div className="h-full safe-area-top">
          <AddFeedPage
            onClose={handleCloseAddFeed}
            contentType={addFeedContentType}
          />
        </div>
      );
    } else if (contentType === "picture") {
      mobileContent = (
        <div className="min-h-[var(--app-dvh)] bg-background">
          <PictureMasonry
            selection={selection}
            contentType={contentType}
            unreadOnly={unreadOnly}
            onToggleUnreadOnly={toggleUnreadOnly}
            onMarkAllRead={handleMarkAllRead}
            isMobile
            onMenuClick={openSidebar}
          />
        </div>
      );
    } else {
      // List and detail views rendered together, controlled by CSS
      mobileContent = (
        <div className="mobile-reading-stack relative min-h-[var(--app-dvh)] w-screen max-w-full bg-background">
          {/* The list stays mounted in normal document flow to preserve state. */}
          <section
            className={cn(
              "mobile-list-page min-h-[var(--app-dvh)] bg-background",
              mobileView === "detail" && "pointer-events-none select-none",
            )}
            aria-hidden={mobileView === "detail"}
            inert={mobileView === "detail" ? true : undefined}
          >
            <EntryList
              selection={selection}
              selectedEntryId={selectedEntryId}
              onSelectEntry={selectEntry}
              onMarkAllRead={handleMarkAllRead}
              unreadOnly={unreadOnly}
              onToggleUnreadOnly={toggleUnreadOnly}
              onFilterChange={handleFilterChange}
              onToggleStarredViewOnly={handleToggleStarredViewOnly}
              onCloseEntry={() => selectEntry(null)}
              contentType={contentType}
              isMobile
              isActive={mobileView === "list"}
              onMenuClick={openSidebar}
            />
          </section>
          {/* Detail remains an internal scroller and slides over the document list. */}
          <section
            className={cn(
              "mobile-detail-page fixed inset-0 z-30 h-[var(--app-dvh)] overflow-hidden bg-background transition-transform duration-300 ease-out",
              mobileView === "detail"
                ? "translate-x-0"
                : "pointer-events-none translate-x-full",
            )}
            aria-hidden={mobileView !== "detail"}
            inert={mobileView !== "detail" ? true : undefined}
          >
            {mobileEntryContent}
          </section>
        </div>
      );
    }

    return (
      <>
        {mobileContent}
        <ScrollToTopZone />
        {/* Lightbox for picture mode */}
        {contentType === "picture" && <Lightbox />}
        {/* ImagePreview for article/notification mode */}
        {contentType !== "picture" && (
          <>
            <ImagePreview />
            <VideoPreview />
          </>
        )}
        {/* Sheet rendered once to prevent animation flickering on route/mode changes */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          {sidebarContent}
        </Sheet>
        <ShortcutsHelpDialog
          open={isShortcutsOpen}
          onOpenChange={(open) => shortcutsHelp.set(open)}
        />
        <SearchModal open={isSearchOpen} onOpenChange={setIsSearchOpen} />
      </>
    );
  }

  // Desktop layout
  if (isAddFeedPath(location)) {
    return (
      <ThreeColumnLayout
        sidebar={sidebarContent}
        list={null}
        content={
          <AddFeedPage
            onClose={handleCloseAddFeed}
            contentType={addFeedContentType}
          />
        }
        hideList
        showSidebar={showSidebar}
      />
    );
  }

  // Desktop social mode —— 两栏（对齐 Folo：SocialMedia 是 wideMode 视图，没有独立列表列；
  // 选中条目时内容在主列内替换时间线，而不是占用第三列）
  if (contentType === "social") {
    return (
      <>
        <ThreeColumnLayout
          sidebar={sidebarContent}
          list={null}
          content={
            /* 列表**常驻**：选中条目时只把详情盖在上面，不卸载列表。
               原来这里是「详情 or 列表」二选一 —— 点开条目会整块卸载 EntryList，关闭时重新挂载，
               滚动位置只能靠模块级 map 还原，表现就是「关掉详情后列表自己往上滚了」（用户报的 BUG-1）。
               移动端那段早就用「列表保持挂载以保留状态」，这里与它对齐。 */
            <div className="relative h-full min-h-0">
              <section
                className={cn(
                  "h-full min-h-0",
                  selectedEntryId && "pointer-events-none select-none",
                )}
                aria-hidden={selectedEntryId ? true : undefined}
                inert={selectedEntryId ? true : undefined}
              >
                <EntryList
                  selection={selection}
                  selectedEntryId={selectedEntryId}
                  onSelectEntry={selectEntry}
                  onMarkAllRead={handleMarkAllRead}
                  unreadOnly={unreadOnly}
                  onToggleUnreadOnly={toggleUnreadOnly}
                  onFilterChange={handleFilterChange}
                  onToggleStarredViewOnly={handleToggleStarredViewOnly}
                  onCloseEntry={() => selectEntry(null)}
                  contentType={contentType}
                  isActive={!selectedEntryId}
                  isTablet={isTablet}
                  onToggleSidebar={toggleSidebarVisible}
                  sidebarVisible={sidebarVisible}
                />
              </section>

              {selectedEntryId && (
                <section className="absolute inset-0 z-10 overflow-hidden bg-background">
                  <Suspense fallback={<EntryContentFallback />}>
                    <LazyEntryContent
                      key={selectedEntryId}
                      entryId={selectedEntryId}
                      onBack={() => selectEntry(null)}
                    />
                  </Suspense>
                </section>
              )}
            </div>
          }
          hideList
          showSidebar={showSidebar}
        />
        <ImagePreview />
        <VideoPreview />
        <ShortcutsHelpDialog
          open={isShortcutsOpen}
          onOpenChange={(open) => shortcutsHelp.set(open)}
        />
        <SearchModal open={isSearchOpen} onOpenChange={setIsSearchOpen} />
      </>
    );
  }

  // Desktop picture mode - two column layout
  if (contentType === "picture") {
    return (
      <>
        <ThreeColumnLayout
          sidebar={sidebarContent}
          list={null}
          content={
            <PictureMasonry
              selection={selection}
              contentType={contentType}
              unreadOnly={unreadOnly}
              onToggleUnreadOnly={toggleUnreadOnly}
              onMarkAllRead={handleMarkAllRead}
              isTablet={isTablet}
              onToggleSidebar={toggleSidebarVisible}
              sidebarVisible={sidebarVisible}
            />
          }
          hideList
          showSidebar={showSidebar}
        />
        <Lightbox />
      </>
    );
  }

  // Desktop notification mode —— 24-8：两栏（侧栏 + 时间线，参照 social/picture），
  // 不再渲染第三栏详情；点条目只在时间线内展开（正文级完整渲染 + 固定高度容器）。
  if (contentType === "notification") {
    return (
      <>
        <ThreeColumnLayout
          sidebar={sidebarContent}
          list={null}
          content={
            <EntryList
              selection={selection}
              selectedEntryId={selectedEntryId}
              onSelectEntry={selectEntry}
              onMarkAllRead={handleMarkAllRead}
              unreadOnly={unreadOnly}
              onToggleUnreadOnly={toggleUnreadOnly}
              onFilterChange={handleFilterChange}
              onCloseEntry={() => selectEntry(null)}
              onToggleStarredViewOnly={handleToggleStarredViewOnly}
              contentType={contentType}
              isTablet={isTablet}
              onToggleSidebar={toggleSidebarVisible}
              sidebarVisible={sidebarVisible}
            />
          }
          hideList
          showSidebar={showSidebar}
        />
        <ImagePreview />
        <VideoPreview />
        <ShortcutsHelpDialog
          open={isShortcutsOpen}
          onOpenChange={(open) => shortcutsHelp.set(open)}
        />
        <SearchModal open={isSearchOpen} onOpenChange={setIsSearchOpen} />
      </>
    );
  }

  return (
    <>
      <ThreeColumnLayout
        sidebar={sidebarContent}
        list={
          <EntryList
            selection={selection}
            selectedEntryId={selectedEntryId}
            onSelectEntry={selectEntry}
            onMarkAllRead={handleMarkAllRead}
            unreadOnly={unreadOnly}
            onToggleUnreadOnly={toggleUnreadOnly}
            onFilterChange={handleFilterChange}
            onCloseEntry={() => selectEntry(null)}
            onToggleStarredViewOnly={handleToggleStarredViewOnly}
            contentType={contentType}
            isTablet={isTablet}
            onToggleSidebar={toggleSidebarVisible}
            sidebarVisible={sidebarVisible}
          />
        }
        content={entryContent}
        showSidebar={showSidebar}
      />
      <ImagePreview />
        <VideoPreview />
      <ShortcutsHelpDialog
        open={isShortcutsOpen}
        onOpenChange={(open) => shortcutsHelp.set(open)}
      />
      <SearchModal open={isSearchOpen} onOpenChange={setIsSearchOpen} />
    </>
  );
}

function AppContent() {
  const [location, navigate] = useLocation();
  const {
    isLoading,
    isAuthenticated,
    needsRegistration,
    needsLogin,
    isNetworkError,
    error,
    shouldRedirectToRoot,
    login,
    register,
    retry,
    clearError,
    consumeRootRedirect,
  } = useAuth();

  useEffect(() => {
    if (!shouldRedirectToRoot) {
      return;
    }
    if (location !== "/") {
      navigate("/", { replace: true });
    }
    consumeRootRedirect();
  }, [shouldRedirectToRoot, location, navigate, consumeRootRedirect]);

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (isNetworkError) {
    return <NetworkErrorPage onRetry={retry} />;
  }

  if (needsRegistration) {
    return (
      <RegisterPage
        onRegister={register}
        error={error}
        onClearError={clearError}
      />
    );
  }

  if (needsLogin) {
    return (
      <LoginPage onLogin={login} error={error} onClearError={clearError} />
    );
  }

  if (isAuthenticated) {
    return <AuthenticatedApp />;
  }

  return <LoadingScreen />;
}

function App() {
  // 「减少动态效果」也要管住 framer-motion 的 JS 动画（CSS 覆盖只影响 CSS 动画）
  const reduceMotion = useUISettingKey("reduceMotion");
  const isSettingsOpen = useSettingsModalStore((state) => state.open);
  const setSettingsOpen = useSettingsModalStore((state) => state.setOpen);
  const isProfileOpen = useProfileModalStore((state) => state.open);
  const setProfileOpen = useProfileModalStore((state) => state.setOpen);

  return (
    <div className="app-shell">
      <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
        <TooltipProvider delayDuration={300}>
          <Router>
            <AppContent />
            <UpdateNotice />
            {/* 规则编辑器：设置页/订阅右键/条目右键都靠 filter-editor-store 唤起它 */}
            <FilterEditorDialog />
            {/*
             * 设置 / 资料弹窗挂在这里（与侧栏 Sheet 平级），不挂在 Sidebar 里 ——
             * 移动端 Sidebar 装在 Sheet 里，Sheet 一关 Sidebar 就卸载，
             * 挂在里面的弹窗会跟着消失；且 Sheet 的滚动锁会吃掉弹窗内容区的滚动
             * （2026-09-20 移动端设置滑不动：sheet.tsx:26 + Combination 两处 preventDefault）。
             */}
            <SettingsModal open={isSettingsOpen} onOpenChange={setSettingsOpen} />
            <ProfileModal open={isProfileOpen} onOpenChange={setProfileOpen} />
            <Toaster />
            <RefreshReportDialog />
          </Router>
        </TooltipProvider>
      </MotionConfig>
    </div>
  );
}

export default App;
