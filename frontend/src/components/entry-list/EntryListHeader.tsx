import { useTranslation } from "react-i18next";
import { ToggleButton } from "@heroui/react";
import { Filter, Images, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RefreshStatus } from "@/api";
import { RefreshTooltip } from "./RefreshTooltip";
import {
  CircleOutlineIcon,
  CircleFilledIcon,
  CheckCircleIcon,
  FileTextIcon,
  ImageIcon,
  MenuIcon,
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
   * 28-1：文章视图的「展示方式」切换（卡片列表 ↔ 悬停大图）。
   * 不传这两项就不渲染那颗按钮 —— 其它视图行为不变。
   * 28-6：按钮位置按用户要求放在**标题文字的右边**（不是标题左边）。
   */
  articleLayout?: "list" | "hover";
  onToggleArticleLayout?: () => void;
  /**
   * 28-7：图片视图的「展示方式」切换（网格 ⇄ 悬停大图，两档循环）。
   * 同上，不传则不渲染。
   */
  pictureLayout?: "grid" | "hover";
  onTogglePictureLayout?: () => void;
}

export function EntryListHeader({
  title,
  subtitle,
  unreadCount,
  unreadOnly,
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
  pictureLayout,
  onTogglePictureLayout,
}: EntryListHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-14 items-center justify-between gap-4 px-4 shrink-0">
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
        {onToggleArticleLayout && (
          <button
            type="button"
            onClick={onToggleArticleLayout}
            aria-label={
              articleLayout === "hover"
                ? t("appearance_view.article_layout_list")
                : t("appearance_view.article_layout_hover")
            }
            {...{
              title:
                articleLayout === "hover"
                  ? t("appearance_view.article_layout_list")
                  : t("appearance_view.article_layout_hover"),
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 hover:bg-item-hover active:scale-95"
          >
            {articleLayout === "hover" ? (
              <FileTextIcon className="size-4" />
            ) : (
              <ImageIcon className="size-4" />
            )}
          </button>
        )}
        {onTogglePictureLayout && (
          /* 28-7：图片视图档位循环 —— 网格 ⇄ 悬停大图。
             图标与提示都表达「点下去会变成什么」。 */
          <button
            type="button"
            onClick={onTogglePictureLayout}
            aria-label={t(
              pictureLayout === "hover"
                ? "appearance_view.picture_layout_grid"
                : "appearance_view.picture_layout_hover",
            )}
            {...{
              title: t(
                pictureLayout === "hover"
                  ? "appearance_view.picture_layout_grid"
                  : "appearance_view.picture_layout_hover",
              ),
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 hover:bg-item-hover active:scale-95"
          >
            {pictureLayout === "hover" ? (
              <LayoutGrid className="size-4" />
            ) : (
              <Images className="size-4" />
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
      </div>
    </div>
  );
}
