import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ToggleButton } from "@heroui/react";
import {
  AlignJustify,
  Filter,
  GalleryHorizontalEnd,
  Images,
  LayoutGrid,
  LayoutList,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { RefreshStatus } from "@/api";
import { RefreshTooltip } from "./RefreshTooltip";
import {
  BackIcon,
  CircleOutlineIcon,
  CircleFilledIcon,
  CheckCircleIcon,
  FileTextIcon,
  MenuIcon,
  SearchIcon,
  RefreshIcon,
  RefreshSpinner,
} from "@/components/ui/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { dispatchScrollToTop } from "@/hooks/useScrollToTop";
import { PluginSlot } from "@/plugins/PluginSlot";
import {
  MobileActionSheet,
  MobileActionSheetItem,
} from "@/components/mobile/MobileActionSheet";

/**
 * 23-1：星标视图那颗「只看当前视图」的图标（接 20-2）。
 *
 * 这颗按钮的语义是**把星标列表收窄到当前内容类型（当前视图）**，不是「星标」本身 ——
 * 侧栏那一行已经写着「星标」，所以这里该表达的是「范围 = 当前视图」。
 * 原来的五角星与旁边的星标概念撞脸，用户反馈有歧义（2026-09-18）。
 *
 * 候选（都用项目里已在用的 lucide，32px 圆钮里显示 16px；选中态给 `fill-current` 实心化，
 * 与相邻那颗「未读」的实心/描边语汇一致）：
 *   A. `Filter`（漏斗）—— **默认选它**：最直白的「只显示筛出来的这一部分」
 *   B. `ListFilter`（列表 + 漏斗）—— 更强调「当前这个列表」
 *   C. `Focus`（准星）—— 更强调「聚焦在当前视图」
 * 换档只改这一行。
 */
const StarredViewIcon = Filter;

interface EntryListHeaderProps {
  title: string;
  /** 标题下的一行说明（如「已静音」视图的解释）；有它时不再显示未读计数 */
  subtitle?: string;
  unreadCount: number;
  unreadOnly: boolean;
  onToggleUnreadOnly: () => void;
  /**
   * 58-1（用户 2026-10-29）：「星标视图里别显示这颗已读/未读切换」——
   * 星标本来就是看过了才收藏的，切「只看未读」没有意义。
   * 不传 = 显示（其余视图一行不动）。
   */
  showUnreadToggle?: boolean;
  onMarkAllRead: () => void;
  /** 刷新当前选中范围（文件夹 / 单个源 / 某个视图） */
  onRefresh?: () => void;
  /** 强制拉取当前范围（用户 11-19：忽略缓存标记整轮重抓；右键刷新图标出这个菜单） */
  onForceRefresh?: () => void;
  /**
   * 12-6：星标视图下多一档「只查看当前视图」（只看当前内容类型的星标）。
   * 带了这个回调才渲染这一档 —— 星标视图以外没有意义。
   */
  starredViewOnly?: boolean;
  onToggleStarredViewOnly?: () => void;
  isRefreshing?: boolean;
  /** 本次刷新待刷新的源总数 */
  refreshTotal?: number;
  /** 本次刷新已完成的源数 */
  refreshCompleted?: number;
  /** 后端轮询到的刷新状态（悬浮浮层用：进度/逐源结果/上次摘要） */
  refreshStatus?: RefreshStatus;
  scrollToTopScope?: string;
  isMobile?: boolean;
  onMenuClick?: () => void;
  isTablet?: boolean;
  onToggleSidebar?: () => void;
  sidebarVisible?: boolean;
  /**
   * 28-1：文章视图的「展示方式」切换。
   * 不传这两项就不渲染那颗按钮 —— 其它视图行为不变。
   * 28-6：按钮位置按用户要求放在**标题文字的右边**（不是标题左边）。
   * 实验布局批：档位由 `articleLayoutOrder`（已按实验可见性过滤）驱动循环。
   */
  articleLayout?: "list" | "inoreader" | "rows" | "hover";
  onToggleArticleLayout?: () => void;
  /**
   * 实验布局批：文章视图可切换的档位顺序（已按实验可见性过滤好的）。
   * 顶栏按钮据此算「下一档」；长度 ≤1 时调用方不传 onToggleArticleLayout，按钮自然不渲染。
   * 缺省为常规两档（传统三栏 → 列表），兼容旧调用。
   */
  articleLayoutOrder?: Array<"list" | "inoreader" | "rows" | "hover">;
  /** 通知视图可切换排布档：timeline（时间轴，默认）/ cards（卡片流）。 */
  notificationLayout?: "timeline" | "cards";
  onToggleNotificationLayout?: () => void;
  /** 顶栏按钮据此算「下一档」；长度 ≤1 时不渲染。 */
  notificationLayoutOrder?: Array<"timeline" | "cards">;
  /**
   * 28-7：图片视图的「展示方式」切换（网格 ⇄ 悬停大图，两档循环）。
   * 同上，不传则不渲染。
   */
  pictureLayout?: "grid" | "hover" | "wall";
  onTogglePictureLayout?: () => void;
  /**
   * 实验布局批：图片视图可切换的档位顺序（已按实验可见性过滤好的）。
   * 顶栏按钮据此算「下一档」；长度 ≤1 时调用方不传 onTogglePictureLayout，按钮自然不渲染。
   * 缺省为全部三档（兼容旧调用）。
   */
  pictureLayoutOrder?: Array<"grid" | "hover" | "wall">;
  /**
   * 52-4：从条目点源名跳进来的订阅 → 标题左边多一颗「返回」，
   * 点了回到跳转前的样子（上一个选中是文件夹就回文件夹，正看着某条详情也一并还原）。
   * 不传（没跳转过来）就不渲染 —— 与 articleLayout / pictureLayout 同一口径。
   */
  onBackFromFeedJump?: () => void;
  /**
   * 56-15：插件 toolbar 挂点的选中态（列表里当前选中的条目 id，没有就空数组）。
   * 工具栏本身不持选中状态，由调用方传 —— `selection:"multi"` 的插件项因此在
   * 「没有选中条目」时自然不出现（那类项是「对选中的若干条做事」）。
   */
  selectedEntryIds?: string[];
  /** 向下滚动时收起这条列表 TOP 栏（桌面与手机共用同一套方向判定） */
  hidden?: boolean;
  /** 移动端顶栏的搜索入口；不传则不渲染搜索按钮 */
  onSearchClick?: () => void;
}

export function EntryListHeader({
  title,
  subtitle,
  onBackFromFeedJump,
  unreadCount,
  unreadOnly,
  showUnreadToggle = true,
  onToggleUnreadOnly,
  onMarkAllRead,
  onRefresh,
  onForceRefresh,
  starredViewOnly,
  onToggleStarredViewOnly,
  isRefreshing = false,
  refreshTotal = 0,
  refreshCompleted = 0,
  refreshStatus,
  scrollToTopScope,
  isMobile,
  onMenuClick,
  isTablet,
  onToggleSidebar,
  sidebarVisible,
  articleLayout,
  onToggleArticleLayout,
  articleLayoutOrder,
  notificationLayout,
  onToggleNotificationLayout,
  notificationLayoutOrder,
  pictureLayout,
  onTogglePictureLayout,
  pictureLayoutOrder,
  selectedEntryIds,
  onSearchClick,
  hidden = false,
}: EntryListHeaderProps) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  /* 实验布局批：图片可切换档位顺序（已过滤）；只有 ≥2 档才在顶栏给按钮 */
  const pictureOrder: Array<"grid" | "hover" | "wall"> =
    pictureLayoutOrder && pictureLayoutOrder.length > 0
      ? pictureLayoutOrder
      : ["grid", "hover", "wall"];
  const showPictureToggle =
    Boolean(onTogglePictureLayout) && pictureOrder.length > 1;
  /* 顶栏那颗档位按钮：提示文案表达「点下去会变成什么」，所以取下一档的名字 */
  const currentPictureIdx = Math.max(0, pictureOrder.indexOf(pictureLayout ?? "grid"));
  const nextPictureLayoutKey =
    pictureOrder[(currentPictureIdx + 1) % pictureOrder.length];
  /* 实验布局批：文章可切换档位顺序（已过滤：常规 传统三栏→列表，悬停正文仅在实验开关打开时加入） */
  const articleOrder: Array<"list" | "inoreader" | "rows" | "hover"> =
    articleLayoutOrder && articleLayoutOrder.length > 0
      ? articleLayoutOrder
      : ["list", "inoreader"];
  const showArticleToggle =
    Boolean(onToggleArticleLayout) && articleOrder.length > 1;
  /* 顶栏那颗档位按钮：提示文案表达「点下去会变成什么」，所以取下一档的名字 */
  const currentArticleIdx = Math.max(0, articleOrder.indexOf(articleLayout ?? "list"));
  const nextArticleLayoutKey: "list" | "inoreader" | "rows" | "hover" =
    articleOrder[(currentArticleIdx + 1) % articleOrder.length] ?? "inoreader";
  /* 通知视图：时间轴 / 卡片流 两档切换 */
  const notificationOrder: Array<"timeline" | "cards"> =
    notificationLayoutOrder && notificationLayoutOrder.length > 0
      ? notificationLayoutOrder
      : ["timeline", "cards"];
  const showNotificationToggle =
    Boolean(onToggleNotificationLayout) && notificationOrder.length > 1;
  const currentNotificationIdx = Math.max(
    0,
    notificationOrder.indexOf(notificationLayout ?? "timeline"),
  );
  const nextNotificationLayoutKey: "timeline" | "cards" =
    notificationOrder[(currentNotificationIdx + 1) % notificationOrder.length] ??
    "cards";

  if (isMobile) {
    return (
      <>
        <div className="flex h-11 items-center gap-0.5 px-1">
          {onMenuClick ? (
            <button
              type="button"
              onClick={onMenuClick}
              aria-label={t("actions.show_sidebar")}
              className="-ml-1 flex size-11 shrink-0 items-center justify-center rounded-full text-foreground transition-colors active:bg-item-hover"
            >
              <MenuIcon className="size-5" />
            </button>
          ) : onBackFromFeedJump ? (
            <button
              type="button"
              onClick={onBackFromFeedJump}
              aria-label={t("entry.back_to_previous")}
              className="-ml-1 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-item-hover"
            >
              <BackIcon className="size-5" />
            </button>
          ) : null}

          <div className="min-w-0 flex-1 px-1">
            <div className="flex items-center gap-1.5">
              <h1
                className="min-w-0 truncate text-[15px] font-bold leading-5 tracking-[-0.01em] text-foreground active:opacity-60"
                onClick={() => dispatchScrollToTop(scrollToTopScope)}
              >
                {title}
              </h1>
              {unreadCount > 0 ? (
                <span
                  aria-label={t("entry.unread_count", { count: unreadCount })}
                  className="shrink-0 rounded-full bg-default/70 px-1.5 py-0.5 text-[10px] font-semibold leading-3 tabular-nums text-muted-foreground"
                >
                  {unreadCount > 999 ? "999+" : unreadCount}
                </span>
              ) : null}
            </div>
            {subtitle ? (
              <p className="truncate text-[10px] leading-3 text-muted-foreground">
                {subtitle}
              </p>
            ) : null}
          </div>

          {/* 右侧动作区直接沿用 Web 端同一套：按钮 size-8、间距 gap-0.5、各图标尺寸按 Web 端
              （刷新/全部已读 size-4、未读切换 size-5），不再在移动端另造一套尺寸。 */}
          {onRefresh ? (
            <button
              type="button"
              onClick={() => onRefresh()}
              disabled={isRefreshing}
              aria-label={
                isRefreshing ? t("entry.refreshing") : t("entry.refresh_view")
              }
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground transition-colors active:bg-item-hover disabled:opacity-60"
            >
              {isRefreshing ? (
                <RefreshSpinner
                  remaining={Math.max(0, refreshTotal - refreshCompleted)}
                />
              ) : (
                /* 与 Web 端同一颗图标、同一尺寸 */
                <RefreshIcon className="size-4" />
              )}
            </button>
          ) : null}
          {showUnreadToggle ? (
            <button
              type="button"
              onClick={onToggleUnreadOnly}
              aria-label={
                unreadOnly ? t("entry.show_all") : t("entry.show_unread_only")
              }
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors active:bg-item-hover",
                unreadOnly ? "text-accent" : "text-muted-foreground",
              )}
            >
              {unreadOnly ? (
                <CircleFilledIcon className="size-5" />
              ) : (
                <CircleOutlineIcon className="size-5" />
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onMarkAllRead}
            aria-label={t("entry.mark_all_read")}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground transition-colors active:bg-item-hover"
          >
            <CheckCircleIcon className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label={t("actions.more")}
            className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-foreground transition-colors active:bg-item-hover"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </div>

        <MobileActionSheet
          open={moreOpen}
          onOpenChange={setMoreOpen}
          title={title}
        >
          {onSearchClick ? (
            <MobileActionSheetItem
              icon={<SearchIcon className="size-5" />}
              label={t("search.title")}
              onClick={() => {
                setMoreOpen(false);
                onSearchClick();
              }}
            />
          ) : null}
          {onForceRefresh ? (
            <MobileActionSheetItem
              icon={<RefreshIcon className="size-5" />}
              label={t("entry.force_refresh")}
              description={t("entry.force_refresh_hint")}
              onClick={() => {
                setMoreOpen(false);
                onForceRefresh();
              }}
            />
          ) : null}
          {onToggleStarredViewOnly ? (
            <MobileActionSheetItem
              icon={<StarredViewIcon className="size-5" />}
              label={t("sidebar.starred_view")}
              selected={Boolean(starredViewOnly)}
              onClick={() => {
                setMoreOpen(false);
                onToggleStarredViewOnly();
              }}
            />
          ) : null}
          {showArticleToggle ? (
            <MobileActionSheetItem
              icon={
                articleLayout === "rows" ? (
                  <FileTextIcon className="size-5" />
                ) : articleLayout === "inoreader" ? (
                  <AlignJustify className="size-5" />
                ) : articleLayout === "hover" ? (
                  <Images className="size-5" />
                ) : (
                  <LayoutList className="size-5" />
                )
              }
              label={t(`appearance_view.article_layout_${nextArticleLayoutKey}`)}
              onClick={() => {
                setMoreOpen(false);
                onToggleArticleLayout?.();
              }}
            />
          ) : null}
          {showNotificationToggle ? (
            <MobileActionSheetItem
              icon={
                notificationLayout === "cards" ? (
                  <LayoutGrid className="size-5" />
                ) : (
                  <LayoutList className="size-5" />
                )
              }
              label={t(
                `appearance_view.notification_layout_${nextNotificationLayoutKey}`,
              )}
              onClick={() => {
                setMoreOpen(false);
                onToggleNotificationLayout?.();
              }}
            />
          ) : null}
          {showPictureToggle ? (
            <MobileActionSheetItem
              icon={
                pictureLayout === "wall" ? (
                  <GalleryHorizontalEnd className="size-5" />
                ) : pictureLayout === "hover" ? (
                  <Images className="size-5" />
                ) : (
                  <LayoutGrid className="size-5" />
                )
              }
              label={t(`appearance_view.picture_layout_${nextPictureLayoutKey}`)}
              onClick={() => {
                setMoreOpen(false);
                onTogglePictureLayout?.();
              }}
            />
          ) : null}
          {(selectedEntryIds?.length ?? 0) > 0 ? (
            <div className="border-t border-border/50 px-4 py-2">
              <PluginSlot
                surface="entry.list.toolbar"
                variant="toolbar"
                selection={{ entryIds: selectedEntryIds ?? [] }}
              />
            </div>
          ) : null}
        </MobileActionSheet>
      </>
    );
  }

  return (
    <div
      data-testid="entry-list-topbar"
      className={cn(
        "flex items-center justify-between gap-4 overflow-hidden px-4 shrink-0 transition-[max-height,opacity] duration-300 ease-out",
        hidden
          ? "h-0 max-h-0 opacity-0 pointer-events-none"
          : "h-14 max-h-14 opacity-100",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isMobile && onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius)] transition-colors hover:bg-item-hover -ml-1.5"
          >
            <MenuIcon className="size-5" />
          </button>
        )}
        {isTablet && onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            title={
              sidebarVisible
                ? t("actions.hide_sidebar")
                : t("actions.show_sidebar")
            }
            className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius)] transition-all duration-200 ease-[var(--ease-ios)] hover:bg-item-hover active:scale-95 -ml-1.5"
          >
            <MenuIcon className="size-5" />
          </button>
        )}
        {onBackFromFeedJump && (
          /* 52-4：与详情页那颗「返回」同一语汇（BackIcon + 文案），放在标题左边 */
          <button
            type="button"
            onClick={onBackFromFeedJump}
            title={t("entry.back_to_previous")}
            className={cn(
              "-ml-1.5 flex shrink-0 items-center gap-1 rounded-[var(--radius)] px-2 py-1",
              "text-xs text-muted-foreground transition-colors duration-200",
              "hover:bg-item-hover hover:text-foreground",
            )}
          >
            <BackIcon className="size-4" />
          </button>
        )}
        <div className="min-w-0">
          <h2
            className="truncate text-[0.9375rem] font-bold leading-tight cursor-pointer active:opacity-70 transition-opacity"
            onClick={() => dispatchScrollToTop(scrollToTopScope)}
          >
            {title}
          </h2>
          {subtitle ? (
            <span className="block truncate text-xs text-muted-foreground">
              {subtitle}
            </span>
          ) : (
            unreadCount > 0 && (
              <span className="block truncate text-xs text-muted-foreground">
                {t("entry.unread_count", { count: unreadCount })}
              </span>
            )
          )}
        </div>
        {/* 28-1 / 28-6（用户：「把它放在右侧，右侧就是文字的右侧…不是右侧三个按钮的位置」）：
            展示方式切换按钮，紧跟在标题文字右边；图标表达「点下去会变成什么」。
            文章视图两档循环；图片视图三档循环（瀑布流 → 网格 → 悬停大图）。 */}
        {showArticleToggle && (
          <button
            type="button"
            onClick={onToggleArticleLayout}
            aria-label={t(`appearance_view.article_layout_${nextArticleLayoutKey}`)}
            {...{
              title: t(`appearance_view.article_layout_${nextArticleLayoutKey}`),
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 hover:bg-item-hover active:scale-95"
          >
            {articleLayout === "rows" ? (
              /* 缩略图列表档 */
              <FileTextIcon className="size-4" />
            ) : articleLayout === "inoreader" ? (
              /* Inoreader 列表档（静态行） */
              <AlignJustify className="size-4" />
            ) : articleLayout === "hover" ? (
              /* 悬停正文档 */
              <Images className="size-4" />
            ) : (
              /* 传统三栏 */
              <LayoutList className="size-4" />
            )}
          </button>
        )}
        {showNotificationToggle && (
          <button
            type="button"
            onClick={onToggleNotificationLayout}
            aria-label={t(
              `appearance_view.notification_layout_${nextNotificationLayoutKey}`,
            )}
            {...{
              title: t(
                `appearance_view.notification_layout_${nextNotificationLayoutKey}`,
              ),
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 hover:bg-item-hover active:scale-95"
          >
            {notificationLayout === "cards" ? (
              <LayoutGrid className="size-4" />
            ) : (
              <LayoutList className="size-4" />
            )}
          </button>
        )}
        {showPictureToggle && (
          /* 28-7：图片视图档位循环 —— 网格 → 悬停大图 → 照片墙（31-1 加第三档）。
             图标画当前档，提示文案说「点下去会变成什么」。 */
          <button
            type="button"
            onClick={onTogglePictureLayout}
            aria-label={t(`appearance_view.picture_layout_${nextPictureLayoutKey}`)}
            {...{
              title: t(`appearance_view.picture_layout_${nextPictureLayoutKey}`),
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 hover:bg-item-hover active:scale-95"
          >
            {pictureLayout === "wall" ? (
              <GalleryHorizontalEnd className="size-4" />
            ) : pictureLayout === "hover" ? (
              <Images className="size-4" />
            ) : (
              <LayoutGrid className="size-4" />
            )}
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {onRefresh && (
          <RefreshTooltip status={refreshStatus}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => onRefresh()}
                title={t("entry.refresh_view")}
                aria-busy={isRefreshing}
                className="flex size-8 items-center justify-center rounded-full transition-colors duration-200 hover:bg-item-hover active:scale-95"
              >
                {isRefreshing ? (
                  <RefreshSpinner
                    remaining={Math.max(0, refreshTotal - refreshCompleted)}
                  />
                ) : (
                  <RefreshIcon className="size-4" />
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onRefresh()}>
                <RefreshIcon className="size-4 shrink-0 text-muted-foreground" />
                {t("actions.refresh")}
              </ContextMenuItem>
              {onForceRefresh && (
                <ContextMenuItem onClick={() => onForceRefresh()}>
                  <RefreshIcon className="size-4 shrink-0 text-muted-foreground" />
                  {t("entry.force_refresh")}
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
          </RefreshTooltip>
        )}
        {showUnreadToggle && (
          <button
            type="button"
            onClick={onToggleUnreadOnly}
            title={unreadOnly ? t("entry.show_all") : t("entry.show_unread_only")}
            className="flex size-8 items-center justify-center rounded-full transition-colors duration-200 hover:bg-item-hover active:scale-95"
          >
            {unreadOnly ? (
              <CircleFilledIcon className="size-5" />
            ) : (
              <CircleOutlineIcon className="size-5" />
            )}
          </button>
        )}
        {onToggleStarredViewOnly && (
          /* 20-2（用户：「把这个当前视图也改成图标的那种形式，然后默认选中」）：
             与相邻的刷新/未读/全读按钮同款 —— 32px 圆形图标按钮，选中态用组件库自带的
             柔和强调底，图标本身也实心化（与未读那颗「实心/描边」的写法一致） */
          <ToggleButton
            isIconOnly
            size="sm"
            variant="ghost"
            isSelected={Boolean(starredViewOnly)}
            onChange={onToggleStarredViewOnly}
            aria-label={t("sidebar.starred_view")}
            /* RAC 的 ToggleButton props 类型里没有 DOM 的 title（运行时照传），
               用 spread 绕开 excess property 检查 */
            {...{
              title: starredViewOnly
                ? t("entry.starred_view_only_off")
                : t("entry.starred_view_only_on"),
            }}
            className="size-8 min-w-8 shrink-0 rounded-full"
          >
            <StarredViewIcon
              className={cn("size-4", starredViewOnly && "fill-current")}
            />
          </ToggleButton>
        )}
        <button
          type="button"
          onClick={onMarkAllRead}
          title={t("entry.mark_all_read")}
          className="flex size-8 items-center justify-center rounded-full transition-colors duration-200 hover:bg-item-hover active:scale-95"
        >
          <CheckCircleIcon className="size-4" />
        </button>
        {/* 56-15：列表工具栏的插件挂点（`entry.list.toolbar`）。插在宿主按钮之后 ——
            插件项是「附加」，不改既有按钮的顺序与位置；没有贡献时插槽什么都不渲染。
            选中态来自调用方（列表的选条目状态），没有选中就是空数组。 */}
        <PluginSlot
          surface="entry.list.toolbar"
          variant="toolbar"
          selection={{ entryIds: selectedEntryIds ?? [] }}
        />
      </div>
    </div>
  );
}
