import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { BoltIcon } from "@/components/ui/icons";
import { CONTENT_TYPE_ORDER, contentTypeMeta } from "@/lib/content-type-meta";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import {
  Copy,
  ExternalLink,
  FolderInput,
  Globe,
  Pencil,
  RefreshCw,
  Tags,
  Trash2,
} from "lucide-react";
import { resolveFeedSiteUrl } from "@/lib/feed-site";
import { copyToClipboard } from "@/stores/toast-store";
import { queryClient } from "@/lib/queryClient";
import { openFilterEditorForFeed } from "@/stores/filter-editor-store";
import type { ContentType, Feed, Folder } from "@/types/api";
import type { FilterRule } from "@/types/filters";

/**
 * 订阅右键菜单里那组「订阅操作」的**唯一一份行为入口**（与 `FeedContextMenuItems` 配对）。
 *
 * 原来这五个函数只活在 `Sidebar.tsx` 里（作为 props 传给 FeedItem），
 * 第二栏要复用就得抽出来 —— 实现见 `hooks/useFeedMenuActions.ts`，
 * 两栏调同一份，不照抄第二份。
 */
export interface FeedMenuActions {
  onRefresh?: (feedId: string) => void;
  onEdit?: (feedId: string) => void;
  onDelete?: (feedId: string) => void;
  onMoveToFolder?: (feedId: string, folderId: string | null) => void;
  onChangeType?: (feedId: string, type: ContentType) => void;
}

interface FeedContextMenuItemsProps extends FeedMenuActions {
  /** 完整订阅对象（第二栏从 feedsMap 里拿现成的；第一栏按 props 组装，见 FeedItem） */
  feed: Feed;
  /** 「移动到文件夹」子菜单的候选：调用方给过滤好的（第一栏按当前内容类型过滤，第二栏按 feed.type 过滤） */
  folders?: Folder[];
  /** 标题行文案：第一栏传订阅名，第二栏传「订阅：<名>」（`entry.feed_menu_group`） */
  label: string;
}

/**
 * 订阅操作组 —— 第一栏（`FeedItem`）与第二栏（`EntryContextMenuContent`）渲染同一份。
 *
 * 内容与原来第一栏的 `rowMenu` 一字不差（标题行 → 刷新/编辑/移动/改类型/复制地址/
 * 主站两项/新建规则 → 分隔线 + 删除独立分组），只是订阅对象与标题文案由调用方给。
 */
export function FeedContextMenuItems({
  feed,
  folders = [],
  label,
  onRefresh,
  onEdit,
  onDelete,
  onMoveToFolder,
  onChangeType,
}: FeedContextMenuItemsProps) {
  const { t } = useTranslation();
  // 「前往主站 / 复制主站地址」用：优先订阅元数据，其次从 RSSHub 路由反解；都没有就藏起这两项
  const siteUrlResolved = useMemo(
    () => resolveFeedSiteUrl({ siteUrl: feed.siteUrl, url: feed.url }),
    [feed.siteUrl, feed.url],
  );

  /**
   * 「为此订阅新建规则」：打开规则编辑器抽屉并预填 scope = 这个订阅。
   *
   * 编辑器只用到 feed.id / feed.title（见 stores/filter-editor-store），先从 feeds
   * 缓存里取完整对象，缓存里没有再用传进来的对象（第一栏按 props 组装的兜底）。
   * 51 批 A7：同订阅已有规则时改为打开 position 最靠前的那条累加（杜绝堆积）。
   */
  const handleNewRuleFromFeed = () => {
    const cached = queryClient
      .getQueryData<Feed[]>(["feeds"])
      ?.find((item) => item.id === feed.id);

    const rules = queryClient.getQueryData<FilterRule[]>(["filters"]) ?? [];
    openFilterEditorForFeed(cached ?? feed, rules, t("automation.rule_merged_note"));
  };

  return (
    <>
      {/* 标题行：说清这是「哪个订阅」的菜单 —— Nextflux 的右键菜单顶部也有这么一行，
          这里额外带上 favicon（用户要求：弹出框要有标题、项要有图标） */}
      <ContextMenuLabel className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
        <FeedAvatar iconPath={feed.iconPath} size={16} rounded="circle" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </ContextMenuLabel>
      <ContextMenuSeparator />
      {onRefresh && (
        <ContextMenuItem onClick={() => onRefresh(feed.id)}>
          <RefreshCw className="size-4 shrink-0 text-muted-foreground" />
          {t("actions.refresh")}
        </ContextMenuItem>
      )}
      {onEdit && (
        <ContextMenuItem onClick={() => onEdit(feed.id)}>
          <Pencil className="size-4 shrink-0 text-muted-foreground" />
          {t("actions.edit")}
        </ContextMenuItem>
      )}
      {onMoveToFolder && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderInput className="size-4 shrink-0 text-muted-foreground" />
            {t("actions.move_to_folder")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onClick={() => onMoveToFolder(feed.id, null)}>
              <FolderInput className="size-4 shrink-0 text-muted-foreground" />
              {t("actions.no_folder")}
            </ContextMenuItem>
            {folders.map((folder) => (
              <ContextMenuItem
                key={folder.id}
                onClick={() => onMoveToFolder(feed.id, folder.id)}
              >
                {folder.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {onChangeType && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Tags className="size-4 shrink-0 text-muted-foreground" />
            {t("actions.change_type")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {/* 每个类型带自己的视图图标（与中栏切换器同一套映射，11-6） */}
            {CONTENT_TYPE_ORDER.map((type) => {
              const { icon: Icon, labelKey } = contentTypeMeta[type];
              return (
                <ContextMenuItem
                  key={type}
                  onClick={() => onChangeType(feed.id, type)}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  {t(labelKey)}
                </ContextMenuItem>
              );
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {feed.url && (
        <ContextMenuItem
          onClick={() => {
            void copyToClipboard(feed.url, t("actions.copied_feed_url"), t("actions.copy_failed"));
          }}
        >
          <Copy className="size-4 shrink-0 text-muted-foreground" />
          {t("actions.copy_feed_url")}
        </ContextMenuItem>
      )}
      {/* 主站（用户 11-11）：能拿到主页地址才显示，拿不到就藏起来，不给假地址 */}
      {siteUrlResolved && (
        <>
          <ContextMenuItem
            onClick={() => {
              window.open(siteUrlResolved, "_blank", "noopener,noreferrer");
            }}
          >
            <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
            {t("actions.open_site")}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void copyToClipboard(siteUrlResolved, t("actions.copied_site_url"), t("actions.copy_failed"));
            }}
          >
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            {t("actions.copy_site_url")}
          </ContextMenuItem>
        </>
      )}
      {/* 规则入口与上面的订阅操作同组；删除是破坏性操作，仍单独分组压在下面 */}
      <ContextMenuItem onClick={handleNewRuleFromFeed}>
        <BoltIcon className="size-4 shrink-0 text-muted-foreground" />
        {t("automation.rule_from_feed")}
      </ContextMenuItem>
      {onDelete && (
        <>
          {/* 删除是破坏性操作：单独一组，避免误点 */}
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => onDelete(feed.id)}
          >
            <Trash2 className="size-4 shrink-0" />
            {t("actions.delete")}
          </ContextMenuItem>
        </>
      )}
    </>
  );
}
