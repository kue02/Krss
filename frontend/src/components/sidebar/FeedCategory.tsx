import { useCallback, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ChevronIcon, FolderIcon } from "@/components/ui/icons";
import { FolderCog, Pencil, RefreshCw, Tags, Trash2 } from "lucide-react";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useCategoryState } from "@/hooks/useCategoryState";
import { Ripple } from "m3-ripple";
import { feedItemStyles, sidebarItemIconStyles } from "./styles";
import { contentTypeMeta } from "@/lib/content-type-meta";
import type { ContentType } from "@/types/api";

/** 12-19：文件夹右键「更改类型」子菜单的图标 —— 与中栏切换器/订阅右键共用同一份 `contentTypeMeta`（11-6 抽的） */
function ContentTypeIcon({ type }: { type: ContentType }) {
  const Icon = contentTypeMeta[type].icon;
  return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}
interface FeedCategoryProps {
  name: string;
  folderId: string;
  unreadCount?: number;
  children: ReactNode;
  defaultOpen?: boolean;
  isSelected?: boolean;
  onSelect?: () => void;
  onBulkOverrides?: (folderId: string) => void;
  /** 12-9：刷新这个分类下的所有订阅 */
  onRefresh?: (folderId: string) => void;
  onRename?: (folderId: string) => void;
  onDelete?: (folderId: string) => void;
  onChangeType?: (folderId: string, type: ContentType) => void;
}

export function FeedCategory({
  name,
  folderId,
  unreadCount,
  children,
  defaultOpen = false,
  isSelected = false,
  onSelect,
  onBulkOverrides,
  onRefresh,
  onRename,
  onDelete,
  onChangeType,
}: FeedCategoryProps) {
  const { t } = useTranslation();
  const [open, , toggle] = useCategoryState(name, defaultOpen);
  const triggerRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent | { pageX: number; pageY: number }) => {
      // Programmatically trigger the context menu for long press
      if (!("button" in e) && triggerRef.current) {
        triggerRef.current.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            clientX: e.pageX,
            clientY: e.pageY,
          }),
        );
      }
    },
    [],
  );

  const contextMenuProps = useContextMenu({
    onContextMenu: handleContextMenu,
  });

  return (
    <div>
      {/* Category header */}
      <ContextMenu>
        <ContextMenuTrigger asChild ref={triggerRef}>
          <div
            data-active={isSelected}
            className={cn(feedItemStyles, "group relative py-0.5 pl-2.5 pr-2")}
            onClick={onSelect}
            {...contextMenuProps}
          >
          <Ripple hoverOpacity={0} pressedOpacity={0.05} duration={100} />
            {/* Arrow button - only this toggles expand/collapse */}
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
            {/* Folder name - clicking selects the folder */}
            <span className="grow truncate text-[0.8125rem] font-semibold">
              {name}
            </span>
            {unreadCount !== undefined && unreadCount > 0 && (
              <span className="ml-2 shrink-0 text-[0.7rem] font-medium tabular-nums text-muted-foreground">
                {unreadCount}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
        {/* 标题行：这是哪个分类的菜单（与订阅右键菜单同一套做法） */}
        <ContextMenuLabel className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
          <FolderIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </ContextMenuLabel>
        <ContextMenuSeparator />
          {onRename && (
            <ContextMenuItem onClick={() => onRename(folderId)}>
              <Pencil className="size-4 shrink-0 text-muted-foreground" />
              {t("actions.rename")}
            </ContextMenuItem>
          )}
          {onRefresh && (
            <ContextMenuItem onClick={() => onRefresh(folderId)}>
              <RefreshCw className="size-4 shrink-0 text-muted-foreground" />
              {t("actions.refresh")}
            </ContextMenuItem>
          )}
          {onBulkOverrides && (
            <ContextMenuItem onClick={() => onBulkOverrides(folderId)}>
              <FolderCog className="size-4 shrink-0 text-muted-foreground" />
              {t("feeds.folder_overrides_menu")}
            </ContextMenuItem>
          )}
          {onChangeType && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Tags className="size-4 shrink-0 text-muted-foreground" />
                {t("actions.change_type")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem
                  onClick={() => onChangeType(folderId, "article")}
                >
                  <ContentTypeIcon type="article" />
                  {t("content_type.article")}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => onChangeType(folderId, "picture")}
                >
                  <ContentTypeIcon type="picture" />
                  {t("content_type.picture")}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => onChangeType(folderId, "notification")}
                >
                  <ContentTypeIcon type="notification" />
                  {t("content_type.notification")}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => onChangeType(folderId, "social")}
                >
                  <ContentTypeIcon type="social" />
                  {t("content_type.social")}
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {onDelete && (
            <>
              {/* 删除是破坏性操作：单独一组，避免误点 */}
              <ContextMenuSeparator />
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onDelete(folderId)}
              >
                <Trash2 className="size-4 shrink-0" />
                {t("actions.delete")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Children list with animation */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-px pt-0.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
