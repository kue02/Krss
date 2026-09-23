import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowDownAZIcon,
  CalendarIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
} from "@/components/ui/icons";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarAccountBar } from "./SidebarAccountBar";
import { StarredItem } from "./StarredItem";
import { FeedCategory } from "./FeedCategory";
import { ListBox } from "@heroui/react";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ViewIcon } from "@/components/automation/ViewIcon";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import { FeedItem } from "./FeedItem";
import { ContentTypeSwitcher } from "./ContentTypeSwitcher";
import {
  useFilterMutations,
  useFilters,
  useViewCounts,
} from "@/hooks/useFilters";
import { useUISettingKey } from "@/hooks/useUISettings";
import { useFilterViewStore } from "@/stores/filter-view-store";
import { useSettingsModalStore, useProfileModalStore } from "@/stores/settings-modal-store";
import { shortcutsHelp } from "@/stores/shortcuts-store";
import { feedItemStyles, sidebarItemIconStyles } from "./styles";
import { EditFeedDialog } from "@/components/settings/tabs/EditFeedDialog";
import { RenameFolderDialog } from "./RenameFolderDialog";
import { CreateFolderDialog } from "./CreateFolderDialog";
import { FolderOverridesDialog } from "./FolderOverridesDialog";
import {
  useFolders,
  useDeleteFolder,
  useUpdateFolderType,
} from "@/hooks/useFolders";
import {
  useFeeds,
  useDeleteFeed,
  useUpdateFeed,
  useUpdateFeedType,
} from "@/hooks/useFeeds";
import { useUnreadCounts, useStarredCount } from "@/hooks/useEntries";
import {
  useAllCategoriesOpen,
  useCategoryActions,
} from "@/hooks/useCategoryState";
import { useAuth } from "@/hooks/useAuth";
import type { SelectionType } from "@/hooks/useSelection";
import type { Folder, Feed, ContentType } from "@/types/api";
import {
  useSidebarHotkeys,
  type SidebarTarget,
} from "@/hooks/useSidebarHotkeys";
import { refreshFeeds } from "@/api";
import { showToast } from "@/stores/toast-store";
import { queryClient } from "@/lib/queryClient";
import type { AppearanceSettings } from "@/types/settings";

const defaultContentTypes: ContentType[] = [
  "article",
  "picture",
  "notification",
  "social",
];

// Per-contentType scroll position cache (module-level to survive unmount/remount)
const sidebarScrollPositions = new Map<string, number>();

type SortBy = "name" | "date";

// ASCII first (English/numbers before Chinese)
function compareNames(a: string, b: string): number {
  /* eslint-disable no-control-regex */
  const isAsciiA = /^[\u0000-\u007f]/.test(a);
  const isAsciiB = /^[\u0000-\u007f]/.test(b);
  /* eslint-enable no-control-regex */
  if (isAsciiA && !isAsciiB) return -1;
  if (!isAsciiA && isAsciiB) return 1;
  return a.localeCompare(b, "zh-CN");
}

interface SidebarProps {
  onAddClick?: (contentType: ContentType) => void;
  selection: SelectionType;
  onSelectFeed: (feedId: string) => void;
  onSelectFolder: (folderId: string) => void;
  onSelectStarred: () => void;
  onSelectAll?: (contentType?: ContentType) => void;
  contentType: ContentType;
  appearanceSettings?: AppearanceSettings;
  /**
   * 移动端侧栏 Sheet 关掉自己（App 传下来的 closeSidebar）。
   * 设置/资料弹窗是从侧栏里打开的：不先关 Sheet，它的 touchmove/wheel 锁
   * （`ui/sheet.tsx` 的 preventBackgroundScroll）会把 Radix Dialog 内容区的
   * 滚动事件一起吃掉 —— 移动端打开设置后滑不动就是这么来的（2026-09-20 实锤，
   * 调用栈见 sheet.tsx:26 + Combination-*.js:956 两处 preventDefault）。
   * 桌面端不走 Sheet，传不传都行。
   */
  onRequestClose?: () => void;
}

interface FolderWithFeeds {
  folder: Folder;
  feeds: Feed[];
}

/** 21-2：文件夹树节点（子文件夹嵌套渲染） */
interface FolderTreeNode extends FolderWithFeeds {
  children: FolderTreeNode[];
}

/** 视图数量角标：数组可能还没回来（后端一次算全部视图），取不到就是 0。 */
function viewCountOf(
  counts: Record<string, number> | undefined,
  viewId: string,
): number {
  return counts?.[viewId] ?? 0;
}

export function Sidebar({
  onAddClick,
  selection,
  onSelectFeed,
  onSelectFolder,
  onSelectStarred,
  onSelectAll,
  contentType,
  appearanceSettings,
  onRequestClose,
}: SidebarProps) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const setIsSettingsOpen = useSettingsModalStore((state) => state.setOpen);
  const setIsProfileOpen = useProfileModalStore((state) => state.setOpen);
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<Folder | null>(null);
  const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
  /** 分类批量设置：非 null 表示正在给这个分类批量设置订阅 */
  const [bulkOverridesFolderId, setBulkOverridesFolderId] = useState<
    string | null
  >(null);
  const [sortBy, setSortBy] = useState<SortBy>("name");

  const visibleContentTypes = useMemo(() => {
    const current = appearanceSettings?.contentTypes;
    if (!current || current.length === 0) return defaultContentTypes;
    return current.filter(
      (type) =>
        type === "article" ||
        type === "picture" ||
        type === "notification" ||
        type === "social",
    );
  }, [appearanceSettings]);

  // Animation direction tracking:
  // 1. direction is a state (set synchronously in effect, BEFORE setTimeout)
  // 2. prevOrderIndexRef tracks contentType's orderIndex (not animatedContentType)
  // 3. animatedContentType update is delayed via setTimeout
  const orderIndex = visibleContentTypes.indexOf(contentType);
  const prevOrderIndexRef = useRef(-1);
  const [isAnimationReady, setIsAnimationReady] = useState(false);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [animatedContentType, setAnimatedContentType] = useState(contentType);

  useLayoutEffect(() => {
    const prevOrderIndex = prevOrderIndexRef.current;
    if (prevOrderIndex !== orderIndex && prevOrderIndex !== -1) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: must set direction BEFORE setTimeout schedules key update
      setDirection(orderIndex > prevOrderIndex ? 1 : -1);
    }
    setTimeout(() => {
      setAnimatedContentType(contentType);
    }, 0);
    if (prevOrderIndexRef.current !== -1) {
      setIsAnimationReady(true);
    }
    prevOrderIndexRef.current = orderIndex;
  }, [orderIndex, contentType]);

  const { data: allFolders = [] } = useFolders();
  const { data: allFeeds = [] } = useFeeds();
  const { mutate: deleteFeed } = useDeleteFeed();
  const { mutate: deleteFolder } = useDeleteFolder();
  const { mutate: updateFeed } = useUpdateFeed();
  const { mutate: updateFeedType } = useUpdateFeedType();
  const { mutate: updateFolderType } = useUpdateFolderType();

  // Filter by content type - use animatedContentType to keep content in sync with animation
  const folders = useMemo(
    () => allFolders.filter((f) => f.type === animatedContentType),
    [allFolders, animatedContentType],
  );
  const feeds = useMemo(
    () => allFeeds.filter((f) => f.type === animatedContentType),
    [allFeeds, animatedContentType],
  );

  const { data: unreadCountsData } = useUnreadCounts();

  // Handlers for menu actions
  const handleEditFeed = useCallback(
    (feedId: string) => {
      const feed = allFeeds.find((f) => f.id === feedId);
      if (feed) setEditingFeed(feed);
    },
    [allFeeds],
  );

  const handleDeleteFeed = useCallback(
    (feedId: string) => {
      deleteFeed(feedId);
    },
    [deleteFeed],
  );

  const handleDeleteFolder = useCallback(
    (folderId: string) => {
      deleteFolder(folderId);
    },
    [deleteFolder],
  );

  const handleMoveToFolder = useCallback(
    (feedId: string, folderId: string | null) => {
      const feed = allFeeds.find((f) => f.id === feedId);
      if (!feed) return;

      if (folderId !== null) {
        const folder = folders.find((f) => f.id === folderId);
        if (!folder || folder.type !== feed.type) {
          return;
        }
      }

      updateFeed({
        id: feedId,
        title: feed.title,
        folderId: folderId ?? undefined,
      });
    },
    [allFeeds, folders, updateFeed],
  );

  const handleChangeFeedType = useCallback(
    (feedId: string, type: ContentType) => {
      updateFeedType({ id: feedId, type });
    },
    [updateFeedType],
  );

  const handleChangeFolderType = useCallback(
    (folderId: string, type: ContentType) => {
      updateFolderType({ id: folderId, type });
    },
    [updateFolderType],
  );

  const unreadCounts = useMemo(() => {
    if (!unreadCountsData) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const [key, value] of Object.entries(unreadCountsData.counts)) {
      map.set(key, value);
    }
    return map;
  }, [unreadCountsData]);

  // Calculate unread count for each content type
  const contentTypeCounts = useMemo(() => {
    const counts = { article: 0, picture: 0, notification: 0, social: 0 };
    for (const feed of allFeeds) {
      counts[feed.type] += unreadCounts.get(feed.id) || 0;
    }
    for (const type of Object.keys(counts) as ContentType[]) {
      if (!visibleContentTypes.includes(type)) {
        counts[type] = 0;
      }
    }
    return counts;
  }, [allFeeds, unreadCounts, visibleContentTypes]);

  const folderUnreadCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const feed of feeds) {
      if (feed.folderId) {
        const current = map.get(feed.folderId) || 0;
        const feedUnread = unreadCounts.get(feed.id) || 0;
        map.set(feed.folderId, current + feedUnread);
      }
    }
    return map;
  }, [feeds, unreadCounts]);

  // Group feeds by folder (uses animatedContentType for content sync with animation)
  const { foldersWithFeeds, uncategorizedFeeds } = groupFeedsByFolder(
    folders,
    feeds,
  );

  // Sort feeds helper
  const sortFeeds = useCallback(
    (feedList: Feed[]) => {
      const sorted = [...feedList];
      if (sortBy === "date") {
        sorted.sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
      } else {
        sorted.sort((a, b) => compareNames(a.title, b.title));
      }
      return sorted;
    },
    [sortBy],
  );

  // Sorted folders with feeds
  const sortedFoldersWithFeeds = useMemo(() => {
    const sorted = [...foldersWithFeeds];
    if (sortBy === "date") {
      sorted.sort(
        (a, b) =>
          new Date(a.folder.createdAt).getTime() -
          new Date(b.folder.createdAt).getTime(),
      );
    } else {
      sorted.sort((a, b) => compareNames(a.folder.name, b.folder.name));
    }
    return sorted.map((item) => ({
      ...item,
      feeds: sortFeeds(item.feeds),
    }));
  }, [foldersWithFeeds, sortBy, sortFeeds]);

  // 21-2：按 parentId 建树（顶层 = 无父级或父级不在当前视图；排序与扁平一致）
  const folderTree = useMemo(() => {
    const byId = new Map<string, FolderTreeNode>();
    for (const item of sortedFoldersWithFeeds) {
      byId.set(item.folder.id, { ...item, children: [] });
    }
    const roots: FolderTreeNode[] = [];
    for (const node of byId.values()) {
      const parentId = node.folder.parentId;
      const parent = parentId ? byId.get(parentId) : undefined;
      if (parent && parent !== node) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
    const sortNodes = (nodes: FolderTreeNode[]) => {
      if (sortBy === "date") {
        nodes.sort(
          (a, b) =>
            new Date(a.folder.createdAt).getTime() -
            new Date(b.folder.createdAt).getTime(),
        );
      } else {
        nodes.sort((a, b) => compareNames(a.folder.name, b.folder.name));
      }
      for (const node of nodes) sortNodes(node.children);
    };
    sortNodes(roots);
    return roots;
  }, [sortedFoldersWithFeeds, sortBy]);

  // 订阅区头部那个「全部展开 / 全部收起」按钮：分类的展开态以文件夹 id 为键存在 localStorage
  //（21-2：原来用 name，多层同名文件夹会串）
  const folderNames = useMemo(
    () => sortedFoldersWithFeeds.map(({ folder }) => folder.id),
    [sortedFoldersWithFeeds],
  );
  const allFoldersOpen = useAllCategoriesOpen(folderNames);
  const { expandAll, collapseAll } = useCategoryActions();
  const handleToggleAllFolders = useCallback(() => {
    if (allFoldersOpen) {
      collapseAll(folderNames);
    } else {
      expandAll(folderNames);
    }
  }, [allFoldersOpen, collapseAll, expandAll, folderNames]);

  // Sorted uncategorized feeds
  const sortedUncategorizedFeeds = useMemo(
    () => sortFeeds(uncategorizedFeeds),
    [uncategorizedFeeds, sortFeeds],
  );

  // 侧栏键盘导航目标（视觉顺序：分组 → 组内订阅 → 未分组订阅）
  const navTargets = useMemo(() => {
    const targets: SidebarTarget[] = [];
    for (const { folder, feeds } of sortedFoldersWithFeeds) {
      targets.push({ kind: "folder", id: folder.id, name: folder.name });
      for (const feed of feeds) {
        targets.push({
          kind: "feed",
          id: feed.id,
          name: feed.title,
          folderId: folder.id,
        });
      }
    }
    for (const feed of sortedUncategorizedFeeds) {
      targets.push({ kind: "feed", id: feed.id, name: feed.title });
    }
    return targets;
  }, [sortedFoldersWithFeeds, sortedUncategorizedFeeds]);

  // n / p 上下切换订阅，x 折叠所在分组，Shift+N 添加订阅（对齐 Nextflux）
  useSidebarHotkeys({
    targets: navTargets,
    selection,
    onSelectFeed,
    onSelectFolder,
    onAddFeed: onAddClick ? () => onAddClick(contentType) : undefined,
  });

  /**
   * 12-9：分类 / 视图的右键「刷新」。
   * 口径与中栏刷新一致 —— 把范围里涉及到的订阅交给同一个刷新接口（后端按范围刷）。
   */
  const handleRefreshScope = useCallback(
    async (ids: string[], label: string) => {
      // 范围为空（例如视图里选的是「全部订阅」）就整轮刷新
      try {
        await refreshFeeds(ids, false);
        queryClient.invalidateQueries({ queryKey: ["entries"] });
        queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
        queryClient.invalidateQueries({ queryKey: ["feeds"] });
        queryClient.invalidateQueries({ queryKey: ["refreshStatus"] });
        showToast(
          ids.length > 0
            ? t("entry.refreshing_n_feeds", { count: ids.length })
            : t("entry.refreshing_all"),
        );
      } catch {
        showToast(t("entry.refresh_failed"));
      }
      void label;
    },
    [queryClient, t],
  );

  const handleRefreshFolder = useCallback(
    (folderId: string) => {
      const ids = (feeds ?? [])
        .filter((feed) => feed.folderId === folderId)
        .map((feed) => feed.id);
      void handleRefreshScope(ids, "folder");
    },
    [feeds, handleRefreshScope],
  );

  /** 视图的范围（scopeType=all 时返回空数组 = 整轮刷新） */
  const handleRefreshView = useCallback(
    (view: { scopeType?: string; scopeId?: string; scopeIds?: string[] }) => {
      let ids: string[] = [];
      if (view.scopeType === "feed") {
        ids = view.scopeIds?.length ? view.scopeIds : view.scopeId ? [view.scopeId] : [];
      } else if (view.scopeType === "folder") {
        ids = (feeds ?? [])
          .filter((feed) => feed.folderId === view.scopeId)
          .map((feed) => feed.id);
      }
      void handleRefreshScope(ids, "view");
    },
    [feeds, handleRefreshScope],
  );

  // 侧栏右键「刷新」：只刷这一个源
  const handleRefreshFeed = useCallback(
    async (feedId: string) => {
      try {
        await refreshFeeds([feedId]);
        queryClient.invalidateQueries({ queryKey: ["entries"] });
        queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
        queryClient.invalidateQueries({ queryKey: ["feeds"] });
        // 12-10：立刻拉一次刷新状态，中栏进度条与结果弹框不用等下一轮轮询
        queryClient.invalidateQueries({ queryKey: ["refreshStatus"] });
        showToast(t("entry.refreshing_n_feeds", { count: 1 }));
      } catch {
        showToast(t("entry.refresh_failed"));
      }
    },
    [queryClient, t],
  );

  // 文件夹重命名（右键菜单）
  const handleBulkOverrides = useCallback((folderId: string) => {
    setBulkOverridesFolderId(folderId);
  }, []);

  const handleRenameFolder = useCallback(
    (folderId: string) => {
      setRenamingFolder(folders.find((item) => item.id === folderId) ?? null);
    },
    [folders],
  );

  const isStarredSelected = selection.type === "starred";
  /** 「只显示当前视图的星标」与「已加星标」是两档，别同时点亮 */
  const isStarredViewSelected =
    selection.type === "starred" && Boolean(selection.viewOnly);
  const isFeedSelected = (feedId: string) =>
    selection.type === "feed" && selection.feedId === feedId;
  const isFolderSelected = (folderId: string) =>
    selection.type === "folder" && selection.folderId === folderId;

  // 保存的筛选视图：设置 → 自动化里建的「范围 + 条件」，这里只是快捷入口
  const { data: filterList } = useFilters();
  // 第一栏订阅外观（用户 11-12）：「名称 + @源站」这一档把订阅行放进 HeroUI ListBox。
  // ListBox 的项要求是它的直接子元素，所以 FeedItem 在那一档下换成 ListBox.Item 当根
  //（两侧根共用同一份行内容与右键菜单，见 FeedItem 的 asListBoxItem）。
  const feedAppearance = useUISettingKey("sidebarFeedAppearance");
  const listBoxMode = feedAppearance === "name_and_site";
  const selectedFeedKeys = new Set<string>(
    selection.type === "feed" && selection.feedId ? [selection.feedId] : [],
  );

  // 数量角标（用户 11-15）：两档星标各一个数 + 每条视图的命中数，都跟进当前内容类型
  const starredCountAll = useStarredCount().data?.count ?? 0;
  const starredCountView = useStarredCount(contentType).data?.count ?? 0;
  const viewCounts = useViewCounts(contentType).data?.counts;
  // 视图可以固定只在某些内容类型下显示（用户 11-5）：没设 = 都显示（老行为）
  const savedViews = useMemo(
    () =>
      (filterList ?? []).filter(
        (item) =>
          item.kind === "view" &&
          (!item.contentTypes?.length || item.contentTypes.includes(contentType)),
      ),
    [filterList, contentType],
  );
  const activeViewId = useFilterViewStore((state) => state.viewId);
  const openEdit = useFilterEditorStore((state) => state.openEdit);
  const { remove } = useFilterMutations();
  const selectView = useFilterViewStore((state) => state.selectView);
  const handleSelectView = useCallback(
    (view: { id: string; name: string }) => {
      // 视图自带作用域，列表这边统一回到「全部」再叠加视图筛选
      onSelectAll?.(contentType);
      selectView(view, `all:${contentType}`);
    },
    [contentType, onSelectAll, selectView],
  );

  return (
    <div className="flex h-full flex-col bg-transparent">
      <SidebarHeader
        onAddClick={() => onAddClick?.(contentType)}
        onCreateFolder={() => setIsCreateFolderOpen(true)}
      />

      <ContentTypeSwitcher
        contentType={contentType}
        counts={contentTypeCounts}
        onSelect={(type) => onSelectAll?.(type)}
        visibleContentTypes={visibleContentTypes}
      />

      {/* Content */}
      <div className="relative flex-1 overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={animatedContentType}
            initial={
              isAnimationReady
                ? { x: direction > 0 ? "100%" : "-100%", opacity: 0 }
                : false
            }
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: direction > 0 ? "-100%" : "100%", opacity: 0 }}
            transition={{
              x: { type: "spring", stiffness: 300, damping: 30 },
              opacity: { duration: 0.2 },
            }}
            className="absolute inset-0 will-change-[transform,opacity]"
          >
            <SidebarScrollArea scrollKey={animatedContentType}>
              {/* 星标入口：原先只在账户菜单里（那颗已按用户要求去掉），改放侧栏导航顶部 —— Nextflux 也是这个位置。
                  2026-09-18 收敛：只剩这一行（行尾的「当前视图」开关已删，那一档挪到第二栏列表头的图标按钮），
                  点进来默认就是「只当前视图」那一档 */}
              <StarredItem
                count={isStarredViewSelected ? starredCountView : starredCountAll}
                isActive={isStarredSelected}
                onClick={onSelectStarred}
              />

              {/* 保存的筛选视图（设置 → 自动化 里维护；这里只是快捷入口，没有就不显示这一段） */}
              {savedViews.length > 0 && (
                <div className="mb-1.5">
                  <div className="px-2.5">
                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                      {t("sidebar.views")}
                    </span>
                  </div>
                  <div className="mt-0.5 space-y-px">
                    {savedViews.map((view) => (
                      <ContextMenu key={view.id}>
                        <ContextMenuTrigger asChild>
                      <div
                        data-active={activeViewId === view.id}
                        className={cn(feedItemStyles, "pl-2.5")}
                        onClick={() => handleSelectView(view)}
                      >
                        <span className={sidebarItemIconStyles}>
                          <ViewIcon icon={view.icon} />
                        </span>
                        <span className="grow truncate">{view.name}</span>
                        {viewCountOf(viewCounts, view.id) > 0 && (
                          <span className="shrink-0 text-[0.7rem] font-medium tabular-nums text-muted-foreground">
                            {viewCountOf(viewCounts, view.id) > 99
                              ? "99+"
                              : viewCountOf(viewCounts, view.id)}
                          </span>
                        )}
                      </div>
                        </ContextMenuTrigger>
                        {/* 视图右键菜单（用户 11-5）：编辑 / 删除 */}
                        <ContextMenuContent>
                          <ContextMenuLabel className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
                            <ViewIcon icon={view.icon} />
                            <span className="min-w-0 flex-1 truncate">{view.name}</span>
                          </ContextMenuLabel>
                          <ContextMenuSeparator />
                          <ContextMenuItem onClick={() => handleRefreshView(view)}>
                            <RefreshCw className="size-4 shrink-0 text-muted-foreground" />
                            {t("actions.refresh")}
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => openEdit(view)}>
                            <Pencil className="size-4 shrink-0 text-muted-foreground" />
                            {t("actions.edit")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => remove.mutate({ id: view.id })}
                          >
                            <Trash2 className="size-4 shrink-0" />
                            {t("actions.delete")}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
                  </div>
                </div>
              )}

              {/* Feed categories header with sort */}
              <div className="flex items-center justify-between px-2.5">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                  {t("sidebar.feeds")}
                </span>
                <div className="flex items-center gap-0.5">
                  {/* 全部展开 / 全部收起（放在排序之前，和 NextFlux 的订阅区头部一致） */}
                  <button
                    type="button"
                    onClick={handleToggleAllFolders}
                    title={
                      allFoldersOpen
                        ? t("sidebar.collapse_all")
                        : t("sidebar.expand_all")
                    }
                    aria-label={
                      allFoldersOpen
                        ? t("sidebar.collapse_all")
                        : t("sidebar.expand_all")
                    }
                    disabled={folderNames.length === 0}
                    className="flex size-6 items-center justify-center rounded-[var(--radius)] text-muted-foreground transition-colors duration-200 hover:bg-secondary/50 hover:text-foreground disabled:opacity-40"
                  >
                    {allFoldersOpen ? (
                      <ChevronsDownUpIcon className="size-3.5" />
                    ) : (
                      <ChevronsUpDownIcon className="size-3.5" />
                    )}
                  </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex size-6 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-secondary/50 hover:text-foreground">
                      {sortBy === "name" ? (
                        <ArrowDownAZIcon className="size-3.5" />
                      ) : (
                        <CalendarIcon className="size-3.5" />
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => setSortBy("name")}
                      className={cn(sortBy === "name" && "bg-secondary")}
                    >
                      <ArrowDownAZIcon className="mr-2 size-4" />
                      {t("sidebar.sort_name")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setSortBy("date")}
                      className={cn(sortBy === "date" && "bg-secondary")}
                    >
                      <CalendarIcon className="mr-2 size-4" />
                      {t("sidebar.sort_date")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                </div>
              </div>

              {/* Feed categories —— 分组之间留一点间距，让「一组订阅」读起来是一块；
                  21-2：按 parentId 建树，子文件夹缩进渲染在父级下面（OPML 多层导入的数据） */}
              <div className="space-y-px">
                {folderTree.map((node, nodeIndex) => (
                  <div
                    key={node.folder.id}
                    className={nodeIndex > 0 ? "mt-1.5" : undefined}
                  >
                    <FolderNode
                      node={node}
                      depth={0}
                      listBoxMode={listBoxMode}
                      selectedFeedKeys={selectedFeedKeys}
                      folderUnreadCounts={folderUnreadCounts}
                      isFolderSelected={isFolderSelected}
                      onSelectFolder={onSelectFolder}
                      onSelectFeed={onSelectFeed}
                      handleRenameFolder={handleRenameFolder}
                      handleDeleteFolder={handleDeleteFolder}
                      handleChangeFolderType={handleChangeFolderType}
                      handleBulkOverrides={handleBulkOverrides}
                      handleRefreshFolder={handleRefreshFolder}
                      handleRefreshFeed={handleRefreshFeed}
                      handleEditFeed={handleEditFeed}
                      handleDeleteFeed={handleDeleteFeed}
                      handleMoveToFolder={handleMoveToFolder}
                      handleChangeFeedType={handleChangeFeedType}
                      folders={folders}
                      unreadCounts={unreadCounts}
                      sortFeeds={sortFeeds}
                      isFeedSelected={isFeedSelected}
                    />
                  </div>
                ))}

                {listBoxMode ? (
                  <ListBox
                    aria-label="feeds"
                    selectionMode="single"
                    selectedKeys={selectedFeedKeys}
                    onAction={(key) => onSelectFeed(String(key))}
                    className="space-y-px"
                  >
                    {sortedUncategorizedFeeds.map((feed) => (
                  <FeedItem
                    asListBoxItem
                      key={feed.id}
                      feedId={feed.id}
                      name={feed.title}
                      feedUrl={feed.url}
                              siteUrl={feed.siteUrl}
                      onRefresh={handleRefreshFeed}
                      iconPath={feed.iconPath}
                      unreadCount={unreadCounts.get(feed.id) || 0}
                      isActive={isFeedSelected(feed.id)}
                      errorMessage={feed.errorMessage}
                      onClick={() => onSelectFeed(feed.id)}
                      className="pl-2.5"
                      folders={folders}
                      onEdit={handleEditFeed}
                      onDelete={handleDeleteFeed}
                      onMoveToFolder={handleMoveToFolder}
                      onChangeType={handleChangeFeedType}
                    />
                    ))}
                  </ListBox>
                ) : (
                  sortedUncategorizedFeeds.map((feed) => (
                  <FeedItem
                    key={feed.id}
                    feedId={feed.id}
                    name={feed.title}
                    feedUrl={feed.url}
                            siteUrl={feed.siteUrl}
                    onRefresh={handleRefreshFeed}
                    iconPath={feed.iconPath}
                    unreadCount={unreadCounts.get(feed.id) || 0}
                    isActive={isFeedSelected(feed.id)}
                    errorMessage={feed.errorMessage}
                    onClick={() => onSelectFeed(feed.id)}
                    className="pl-2.5"
                    folders={folders}
                    onEdit={handleEditFeed}
                    onDelete={handleDeleteFeed}
                    onMoveToFolder={handleMoveToFolder}
                    onChangeType={handleChangeFeedType}
                  />
                  ))
                )}
              </div>
            </SidebarScrollArea>
          </motion.div>
        </AnimatePresence>
      </div>

      <SidebarAccountBar
        avatarUrl={user?.avatarUrl}
        userName={user?.nickname || user?.username}
        onProfileClick={() => {
          onRequestClose?.();
          setIsProfileOpen(true);
        }}
        onSettingsClick={() => {
          onRequestClose?.();
          setIsSettingsOpen(true);
        }}
        onShortcutsClick={() => {
          onRequestClose?.();
          shortcutsHelp.toggle();
        }}
        onLogoutClick={logout}
      />

      {/* 设置 / 资料弹窗挂在 App 顶层（与 Sheet 平级），不在这里 ——
          移动端 Sidebar 装在 Sheet 里，Sheet 一关 Sidebar 就卸载，
          挂在这里的弹窗会跟着消失（2026-09-20 移动端设置滑不动）。 */}
      <RenameFolderDialog
        folder={renamingFolder}
        open={renamingFolder !== null}
        onOpenChange={(open) => {
          if (!open) setRenamingFolder(null);
        }}
      />

      <CreateFolderDialog
        open={isCreateFolderOpen}
        onOpenChange={setIsCreateFolderOpen}
        contentType={contentType}
      />

      <FolderOverridesDialog
        open={bulkOverridesFolderId !== null}
        onOpenChange={(open) => {
          if (!open) setBulkOverridesFolderId(null);
        }}
        folderName={
          folders.find((item) => item.id === bulkOverridesFolderId)?.name
        }
        feedIds={feeds
          .filter((feed) => feed.folderId === bulkOverridesFolderId)
          .map((feed) => feed.id)}
      />

      <EditFeedDialog
        feed={editingFeed}
        open={editingFeed !== null}
        onOpenChange={(open) => {
          if (!open) setEditingFeed(null);
        }}
      />
    </div>
  );
}

// Isolated scroll container - each AnimatePresence keyed child creates its own instance,
// so refs and effects never conflict between entering/exiting elements.
function SidebarScrollArea({
  scrollKey,
  children,
}: {
  scrollKey: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Restore saved position
    const saved = sidebarScrollPositions.get(scrollKey);
    if (saved) {
      node.scrollTop = saved;
    }

    // Save on scroll
    const handleScroll = () => {
      sidebarScrollPositions.set(scrollKey, node.scrollTop);
    };

    node.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", handleScroll);
    };
  }, [scrollKey]);

  return (
    <div
      ref={ref}
      className="h-full overflow-y-auto overscroll-y-contain px-1 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] space-y-1"
    >
      {children}
    </div>
  );
}

/** 21-2：文件夹树递归节点（子文件夹缩进渲染在父级 children 里，订阅排在子文件夹前面） */
function FolderNode({
  node,
  depth,
  listBoxMode,
  selectedFeedKeys,
  folderUnreadCounts,
  isFolderSelected,
  onSelectFolder,
  onSelectFeed,
  handleRenameFolder,
  handleDeleteFolder,
  handleChangeFolderType,
  handleBulkOverrides,
  handleRefreshFolder,
  handleRefreshFeed,
  handleEditFeed,
  handleDeleteFeed,
  handleMoveToFolder,
  handleChangeFeedType,
  folders,
  unreadCounts,
  sortFeeds,
  isFeedSelected,
}: {
  node: FolderTreeNode;
  depth: number;
  listBoxMode: boolean;
  selectedFeedKeys: Set<string> | string[];
  folderUnreadCounts: Map<string, number>;
  isFolderSelected: (folderId: string) => boolean;
  onSelectFolder: (folderId: string) => void;
  onSelectFeed: (feedId: string) => void;
  handleRenameFolder: (folderId: string) => void;
  handleDeleteFolder: (folderId: string) => void;
  handleChangeFolderType: (folderId: string, type: ContentType) => void;
  handleBulkOverrides: (folderId: string) => void;
  handleRefreshFolder: (folderId: string) => void;
  handleRefreshFeed: (feedId: string) => void;
  handleEditFeed: (feedId: string) => void;
  handleDeleteFeed: (feedId: string) => void;
  handleMoveToFolder: (feedId: string, folderId: string | null) => void;
  handleChangeFeedType: (feedId: string, type: ContentType) => void;
  folders: Folder[];
  unreadCounts: Map<string, number>;
  sortFeeds: (feeds: Feed[]) => Feed[];
  isFeedSelected: (feedId: string) => boolean;
}) {
  const { folder } = node;
  const folderFeeds = sortFeeds(node.feeds);
  const childProps = {
    listBoxMode,
    selectedFeedKeys,
    folderUnreadCounts,
    isFolderSelected,
    onSelectFolder,
    onSelectFeed,
    handleRenameFolder,
    handleDeleteFolder,
    handleChangeFolderType,
    handleBulkOverrides,
    handleRefreshFolder,
    handleRefreshFeed,
    handleEditFeed,
    handleDeleteFeed,
    handleMoveToFolder,
    handleChangeFeedType,
    folders,
    unreadCounts,
    sortFeeds,
    isFeedSelected,
  };
  return (
    <FeedCategory
      folderId={folder.id}
      name={folder.name}
      stateKey={folder.id}
      depth={depth}
      unreadCount={folderUnreadCounts.get(folder.id) || 0}
      isSelected={isFolderSelected(folder.id)}
      onSelect={() => onSelectFolder(folder.id)}
      onRename={handleRenameFolder}
      onDelete={handleDeleteFolder}
      onChangeType={handleChangeFolderType}
      onBulkOverrides={handleBulkOverrides}
      onRefresh={handleRefreshFolder}
    >
      {node.children.map((child) => (
        <FolderNode
          key={child.folder.id}
          node={child}
          depth={depth + 1}
          {...childProps}
        />
      ))}
      {listBoxMode ? (
        <ListBox
          aria-label={folder.name}
          selectionMode="single"
          selectedKeys={selectedFeedKeys}
          onAction={(key) => onSelectFeed(String(key))}
          className="space-y-px"
        >
          {folderFeeds.map((feed) => (
            <FeedItem
              asListBoxItem
              key={feed.id}
              feedId={feed.id}
              name={feed.title}
              feedUrl={feed.url}
              siteUrl={feed.siteUrl}
              onRefresh={handleRefreshFeed}
              iconPath={feed.iconPath}
              unreadCount={unreadCounts.get(feed.id) || 0}
              isActive={isFeedSelected(feed.id)}
              errorMessage={feed.errorMessage}
              onClick={() => onSelectFeed(feed.id)}
              className="pl-6"
              folders={folders}
              onEdit={handleEditFeed}
              onDelete={handleDeleteFeed}
              onMoveToFolder={handleMoveToFolder}
              onChangeType={handleChangeFeedType}
            />
          ))}
        </ListBox>
      ) : (
        folderFeeds.map((feed) => (
          <FeedItem
            key={feed.id}
            feedId={feed.id}
            name={feed.title}
            feedUrl={feed.url}
            siteUrl={feed.siteUrl}
            onRefresh={handleRefreshFeed}
            iconPath={feed.iconPath}
            unreadCount={unreadCounts.get(feed.id) || 0}
            isActive={isFeedSelected(feed.id)}
            errorMessage={feed.errorMessage}
            onClick={() => onSelectFeed(feed.id)}
            className="pl-6"
            folders={folders}
            onEdit={handleEditFeed}
            onDelete={handleDeleteFeed}
            onMoveToFolder={handleMoveToFolder}
            onChangeType={handleChangeFeedType}
          />
        ))
      )}
    </FeedCategory>
  );
}

function groupFeedsByFolder(
  folders: Folder[],
  feeds: Feed[],
): {
  foldersWithFeeds: FolderWithFeeds[];
  uncategorizedFeeds: Feed[];
} {
  const folderMap = new Map<string, Feed[]>();

  for (const folder of folders) {
    folderMap.set(folder.id, []);
  }

  const uncategorizedFeeds: Feed[] = [];

  for (const feed of feeds) {
    if (feed.folderId !== null && feed.folderId !== undefined) {
      const folderFeeds = folderMap.get(feed.folderId);
      if (folderFeeds) {
        folderFeeds.push(feed);
      } else {
        uncategorizedFeeds.push(feed);
      }
    } else {
      uncategorizedFeeds.push(feed);
    }
  }

  const foldersWithFeeds: FolderWithFeeds[] = folders.map((folder) => ({
    folder,
    feeds: folderMap.get(folder.id) || [],
  }));

  return { foldersWithFeeds, uncategorizedFeeds };
}
