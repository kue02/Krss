import { useCallback, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import {
  FolderCog,
  FolderInput,
  ListFilter,
  Pencil,
  RefreshCw,
  Tags,
  Trash2,
} from "lucide-react";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useCategoryState } from "@/hooks/useCategoryState";
import { Ripple } from "m3-ripple";
import { feedItemStyles, sidebarItemIconStyles } from "./styles";
import { openFilterEditorForFolder } from "@/stores/filter-editor-store";
import type { FilterRule } from "@/types/filters";
import { contentTypeMeta } from "@/lib/content-type-meta";
import type { ContentType, Folder } from "@/types/api";
import { useSidebarDndOptional } from "./sidebar-dnd";

/** 12-19：文件夹右键「更改类型」子菜单的图标 —— 与中栏切换器/订阅右键共用同一份 `contentTypeMeta`（11-6 抽的） */
function ContentTypeIcon({ type }: { type: ContentType }) {
  const Icon = contentTypeMeta[type].icon;
  return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}

/** 收集 rootId 的所有后代文件夹 id（含多级），用于「移动到文件夹」候选排除自身子树、防成环 */
function collectDescendantIds(rootId: string, list: Folder[]): Set<string> {
  const childrenByParent = new Map<string, Folder[]>();
  for (const folder of list) {
    if (!folder.parentId) continue;
    const siblings = childrenByParent.get(folder.parentId) ?? [];
    siblings.push(folder);
    childrenByParent.set(folder.parentId, siblings);
  }
  const result = new Set<string>();
  const stack = [...(childrenByParent.get(rootId) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (result.has(node.id)) continue;
    result.add(node.id);
    stack.push(...(childrenByParent.get(node.id) ?? []));
  }
  return result;
}

interface FeedCategoryProps {
  name: string;
  folderId: string;
  unreadCount?: number;
  children: ReactNode;
  defaultOpen?: boolean;
  isSelected?: boolean;
  /** 21-2：展开态键默认用 name；多层同名文件夹会串，传 folderId 隔离 */
  stateKey?: string;
  /** 21-2：嵌套深度（子文件夹缩进） */
  depth?: number;
  /** 拖拽用：这一行在页面上所处的容器文件夹 id（顶层为 undefined）与内容类型 */
  containerId?: string;
  contentType?: ContentType;
  /** 同内容类型的全部文件夹（用于「移动到文件夹」候选与后代排除） */
  folderOptions?: Folder[];
  onSelect?: () => void;
  onBulkOverrides?: (folderId: string) => void;
  /** 12-9：刷新这个分类下的所有订阅 */
  onRefresh?: (folderId: string) => void;
  onRename?: (folderId: string) => void;
  onDelete?: (folderId: string) => void;
  onChangeType?: (folderId: string, type: ContentType) => void;
  /** 「移动到文件夹」：parentId 为 null 表示移到顶层 */
  onMoveToFolder?: (folderId: string, parentId: string | null) => void;
}

export function FeedCategory({
  name,
  folderId,
  unreadCount,
  children,
  defaultOpen = false,
  isSelected = false,
  stateKey,
  depth = 0,
  containerId,
  contentType,
  folderOptions,
  onSelect,
  onBulkOverrides,
  onRefresh,
  onRename,
  onDelete,
  onChangeType,
  onMoveToFolder,
}: FeedCategoryProps) {
  const { t } = useTranslation();
  const [open, , toggle] = useCategoryState(stateKey ?? name, defaultOpen);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dnd = useSidebarDndOptional();

  /** 「移动到文件夹」候选：同类型文件夹里，排除自己与自己的所有后代（否则会成环） */
  const moveTargets = (() => {
    if (!onMoveToFolder || !folderOptions) return [];
    const descendants = collectDescendantIds(folderId, folderOptions);
    return folderOptions.filter(
      (folder) => folder.id !== folderId && !descendants.has(folder.id),
    );
  })();

  const rowDndProps =
    dnd && dnd.canDrag
      ? dnd.rowProps(
          {
            kind: "folder",
            id: folderId,
            type: contentType ?? "article",
            containerId,
          },
          "folder",
        )
      : {};
  const dropPosition =
    dnd?.dropTarget?.kind === "folder" && dnd.dropTarget.id === folderId
      ? dnd.dropTarget.position
      : null;

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
  const queryClient = useQueryClient();
  /** 51 批 A7：为此文件夹新建规则 —— 已有同文件夹规则时并入 position 最靠前的那条 */
  const handleNewRuleForFolder = () => {
    const rules = queryClient.getQueryData<FilterRule[]>(["filters"]) ?? [];
    openFilterEditorForFolder({ id: folderId, name }, rules, t("automation.rule_merged_note"));
  };

  return (
    <div className={depth > 0 ? "ml-4 border-l border-border/50 pl-1" : undefined}>
      {/* Category header */}
      <ContextMenu>
        <ContextMenuTrigger asChild ref={triggerRef}>
          <div
            data-active={isSelected}
            data-dnd-drop={dropPosition ?? undefined}
            className={cn(
              feedItemStyles,
              "group relative py-0.5 pl-2.5 pr-2",
              dnd?.dragging?.kind === "folder" &&
                dnd.dragging.id === folderId &&
                "opacity-50",
              dropPosition === "inside" &&
                "bg-primary/10 ring-1 ring-inset ring-primary/40",
              dropPosition === "before" &&
                "before:content-[''] before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-primary",
              dropPosition === "after" &&
                "after:content-[''] after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
            )}
            onClick={onSelect}
            {...contextMenuProps}
            {...rowDndProps}
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
          <ContextMenuItem onClick={handleNewRuleForFolder}>
            <ListFilter className="size-4 shrink-0 text-muted-foreground" />
            {t("automation.rule_from_folder")}
          </ContextMenuItem>
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
          {onMoveToFolder && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <FolderInput className="size-4 shrink-0 text-muted-foreground" />
                {t("actions.move_to_folder")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onClick={() => onMoveToFolder(folderId, null)}>
                  <FolderInput className="size-4 shrink-0 text-muted-foreground" />
                  {t("actions.move_to_root")}
                </ContextMenuItem>
                {moveTargets.map((folder) => (
                  <ContextMenuItem
                    key={folder.id}
                    onClick={() => onMoveToFolder(folderId, folder.id)}
                  >
                    {folder.name}
                  </ContextMenuItem>
                ))}
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
