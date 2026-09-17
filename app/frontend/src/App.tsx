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
import { ThreeColumnLayout } from "@/components/layout/three-column-layout";
import { Sheet } from "@/components/ui/sheet";
import { MotionConfig } from "motion/react";
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { refreshAllFeeds } from "@/api";
import { ShortcutsHelpDialog } from "@/components/shortcuts/ShortcutsHelpDialog";
import { SearchModal } from "@/components/search/SearchModal";
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
  applyQuoteStyleToDocument,
  applyReduceMotionToDocument,
  applyUiScaleToDocument,
} from "@/hooks/useUISettings";
import { useRefreshStatus } from "@/hooks/useRefreshStatus";
import { isAddFeedPath } from "@/lib/router";
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
            <div className="h-10 w-3/4 rounded bg-muted" />
            <div className="flex gap-6">
              <div className="h-4 w-24 rounded bg-muted" />
              <div className="h-4 w-32 rounded bg-muted" />
            </div>
            <hr className="border-border/60" />
          </div>
          <div className="space-y-4">
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-3/4 rounded bg-muted" />
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-5/6 rounded bg-muted" />
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
    mutationFn: refreshAllFeeds,
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

  const handleSelectStarred = useCallback(() => {
    closeSidebar();
    selectStarred({ replace: true });
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
  const reduceMotion = useUISettingKey("reduceMotion");
  useEffect(() => {
    applyReduceMotionToDocument(Boolean(reduceMotion));
  }, [reduceMotion]);

  // 「引文样式」落到 <html data-quote-style>：强调块 / Folo 式分割线
  const quoteStyle = useUISettingKey("quoteStyle");
  useEffect(() => {
    applyQuoteStyleToDocument(quoteStyle === "divider" ? "divider" : "block");
  }, [quoteStyle]);

  // 「界面字号」改 <html> 基准字号（界面用的都是 rem，整体跟着缩放）
  const uiScale = useUISettingKey("uiScale");
  useEffect(() => {
    applyUiScaleToDocument(uiScale);
  }, [uiScale]);

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
        {contentType !== "picture" && <ImagePreview />}
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
            selectedEntryId ? (
              <Suspense fallback={<EntryContentFallback />}>
                <LazyEntryContent
                  key={selectedEntryId}
                  entryId={selectedEntryId}
                  onBack={() => selectEntry(null)}
                />
              </Suspense>
            ) : (
              <EntryList
                selection={selection}
                selectedEntryId={selectedEntryId}
                onSelectEntry={selectEntry}
                onMarkAllRead={handleMarkAllRead}
                unreadOnly={unreadOnly}
                onToggleUnreadOnly={toggleUnreadOnly}
                onFilterChange={handleFilterChange}
                onCloseEntry={() => selectEntry(null)}
                contentType={contentType}
                isTablet={isTablet}
                onToggleSidebar={toggleSidebarVisible}
                sidebarVisible={sidebarVisible}
              />
            )
          }
          hideList
          showSidebar={showSidebar}
        />
        <ImagePreview />
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

  return (
    <div className="app-shell">
      <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
        <TooltipProvider delayDuration={300}>
          <Router>
            <AppContent />
            <UpdateNotice />
            <Toaster />
          </Router>
        </TooltipProvider>
      </MotionConfig>
    </div>
  );
}

export default App;
