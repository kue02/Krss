import { useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@heroui/react";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Ripple } from "m3-ripple";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ChevronIcon } from "@/components/ui/icons";
import { ViewIcon } from "@/components/automation/ViewIcon";
import { useCategoryState } from "@/hooks/useCategoryState";
import { getViewMatchedFeeds } from "@/api";
import type { FilterRule, ViewMatchedFeed } from "@/types/filters";
import type { ContentType, Feed, Folder } from "@/types/api";
import { FeedItem } from "./FeedItem";
import { feedItemStyles, sidebarItemIconStyles } from "./styles";

/**
 * 把后端返回的「匹配订阅」合并进侧栏已有的 Feed 元数据（标题/地址/图标等）。
 * 纯函数，便于单测：本地找不到该 Feed 时用后端给的 feedTitle 兜底照常显示。
 */
export interface ResolvedMatchedFeed {
  feedId: string;
  /** 展示名：优先本地 Feed 标题，取不到则用后端 feedTitle */
  name: string;
  feedUrl?: string;
  siteUrl?: string;
  iconPath?: string;
  folderId?: string;
  contentType?: ContentType;
  /** 该源命中的条目数（角标） */
  count: number;
}

export function resolveMatchedFeeds(
  matched: ViewMatchedFeed[],
  feeds: Feed[],
): ResolvedMatchedFeed[] {
  return matched.map((m) => {
    const feed = feeds.find((f) => f.id === m.feedId);
    return {
      feedId: m.feedId,
      name: feed?.title || m.feedTitle,
      feedUrl: feed?.url,
      siteUrl: feed?.siteUrl,
      iconPath: feed?.iconPath,
      folderId: feed?.folderId,
      contentType: feed?.type,
      count: m.count,
    };
  });
}

interface SmartViewFolderProps {
  view: FilterRule;
  /** 视图总数角标（沿用 viewCountOf，>99 显示 99+） */
  count: number;
  isActive: boolean;
  isMobile?: boolean;
  contentType?: ContentType;
  /** 当前内容类型下侧栏已有的订阅（用于拿标题/图标等完整元数据） */
  feeds: Feed[];
  folders?: Folder[];
  isFeedSelected: (feedId: string) => boolean;
  onSelectView: () => void;
  onSelectFeed: (feedId: string) => void;
  onRefreshView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * 侧栏「智能文件夹」：把保存的筛选视图渲染成可展开的文件夹行。
 * 行首 chevron 只负责展开/收起（不选中视图），展开后以动画显出**动态**匹配订阅列表；
 * 列表来自 `getViewMatchedFeeds`，只在展开时请求（懒加载），匹配内容消失的源会自动不再显示。
 */
export function SmartViewFolder({
  view,
  count,
  isActive,
  isMobile,
  contentType,
  feeds,
  folders,
  isFeedSelected,
  onSelectView,
  onSelectFeed,
  onRefreshView,
  onEdit,
  onDelete,
}: SmartViewFolderProps) {
  const { t } = useTranslation();
  const [open, , toggle] = useCategoryState(`view:${view.id}`, false);

  // 只有展开时才请求（enabled: open）；15s 内的展开直接复用缓存，避免来回切时反复打接口
  const { data, isLoading } = useQuery({
    queryKey: ["view-matched-feeds", view.id, contentType],
    queryFn: () => getViewMatchedFeeds(view.id, contentType),
    enabled: open,
    staleTime: 15_000,
  });

  const resolved = useMemo(
    () => resolveMatchedFeeds(data?.feeds ?? [], feeds),
    [data, feeds],
  );

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-active={isActive}
            className={cn(
              feedItemStyles,
              "group relative py-0.5 pl-2.5 pr-2",
              isMobile && "h-10",
            )}
            onClick={onSelectView}
          >
            <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />
            {/* 箭头按钮 —— 只有它切换展开/收起 */}
            <button
              type="button"
              className="flex h-full items-center"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
            >
              <span className={sidebarItemIconStyles}>
                <ChevronIcon
                  className={cn(
                    "size-4 transition-transform duration-200",
                    open && "rotate-90",
                  )}
                />
              </span>
            </button>
            <span className={sidebarItemIconStyles}>
              <ViewIcon icon={view.icon} />
            </span>
            <span className="grow truncate">{view.name}</span>
            {count > 0 && (
              <span className="shrink-0 text-[0.7rem] font-medium tabular-nums text-muted-foreground">
                {count > 99 ? "99+" : count}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        {/* 视图右键菜单（照搬原侧栏视图行）：刷新 / 编辑 / 删除 */}
        <ContextMenuContent>
          <ContextMenuLabel className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
            <ViewIcon icon={view.icon} />
            <span className="min-w-0 flex-1 truncate">{view.name}</span>
          </ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onRefreshView}>
            <RefreshCw className="size-4 shrink-0 text-muted-foreground" />
            {t("actions.refresh")}
          </ContextMenuItem>
          <ContextMenuItem onClick={onEdit}>
            <Pencil className="size-4 shrink-0 text-muted-foreground" />
            {t("actions.edit")}
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="size-4 shrink-0" />
            {t("actions.delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* 展开的匹配订阅列表（动态）：动画与 FeedCategory 一致 */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-px pt-0.5">
              {isLoading ? (
                <>
                  <Skeleton className="ml-6 h-6 rounded" />
                  <Skeleton className="ml-6 h-6 rounded" />
                  <Skeleton className="ml-6 h-6 rounded" />
                </>
              ) : resolved.length === 0 ? (
                <div className="ml-6 px-2 py-1 text-xs text-muted-foreground">
                  {t("sidebar.view_no_matches")}
                </div>
              ) : (
                resolved.map((match) => (
                  <FeedItem
                    key={match.feedId}
                    feedId={match.feedId}
                    name={match.name}
                    feedUrl={match.feedUrl}
                    siteUrl={match.siteUrl}
                    iconPath={match.iconPath}
                    unreadCount={match.count}
                    isActive={isFeedSelected(match.feedId)}
                    onClick={() => onSelectFeed(match.feedId)}
                    className="pl-6"
                    folders={folders ?? []}
                    folderId={match.folderId}
                    contentType={match.contentType ?? contentType}
                  />
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
