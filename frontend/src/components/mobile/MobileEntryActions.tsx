import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  BellOff,
  Bolt,
  ChevronsUp,
  Copy,
  ExternalLink,
  FolderInput,
  Globe,
  Pencil,
  RefreshCw,
  ShieldOff,
  Star,
  Tags,
  Trash2,
  Wand2,
} from "lucide-react";
import { useMarkAsRead, useMarkAsStarred } from "@/hooks/useEntries";
import { useFeeds } from "@/hooks/useFeeds";
import { useFeedMenuActions } from "@/hooks/useFeedMenuActions";
import { useUnmuteEntry, useCreateFilterException } from "@/hooks/useFilters";
import { useUISettingKey } from "@/hooks/useUISettings";
import { readToggleAction } from "@/components/entry-list/read-toggle-action";
import { FeedAvatar } from "@/components/ui/feed-avatar";
import { CONTENT_TYPE_ORDER, contentTypeMeta } from "@/lib/content-type-meta";
import { resolveFeedSiteUrl } from "@/lib/feed-site";
import { copyToClipboard, showToast } from "@/stores/toast-store";
import { openFilterEditorForEntry } from "@/stores/filter-editor-store";
import { openFilterEditorForFeed } from "@/stores/filter-editor-store";
import { queryClient } from "@/lib/queryClient";
import type { ContentType, Entry, Folder } from "@/types/api";
import type { FilterRule } from "@/types/filters";
import { MobileActionSheet, MobileActionSheetItem } from "./MobileActionSheet";

type FeedSubmenu = "folder" | "type" | null;

interface MobileEntryActionsProps {
  entry: Entry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 长按触点；只有设置选「长按位置浮层」时才传给面板 */
  anchor?: { x: number; y: number } | null;
  onMarkAbove?: (entryId: string) => void;
}

/**
 * 移动端长按条目后的操作面板。
 *
 * 除了「这条内容」的高频动作，还带一组「所属订阅」操作（与桌面右键、
 * 第一栏订阅菜单共用 `useFeedMenuActions` 的行为）；长按面板的位置由
 * 外观 → 移动端样式决定：底部面板（默认）或贴着触点弹出。
 */
export function MobileEntryActions({
  entry,
  open,
  onOpenChange,
  anchor,
  onMarkAbove,
}: MobileEntryActionsProps) {
  const { t } = useTranslation();
  const unmute = useUnmuteEntry();
  const exception = useCreateFilterException();
  const { mutate: markAsRead } = useMarkAsRead();
  const { mutate: markAsStarred } = useMarkAsStarred();
  const { data: feeds = [] } = useFeeds();
  const feedMenu = useFeedMenuActions();
  const placement = useUISettingKey("mobileEntryMenuPlacement");
  const [submenu, setSubmenu] = useState<FeedSubmenu>(null);

  const feed = entry ? feeds.find((item) => item.id === entry.feedId) : undefined;
  const readAction = entry ? readToggleAction(!entry.read) : null;
  const siteUrl = useMemo(
    () =>
      feed
        ? resolveFeedSiteUrl({ siteUrl: feed.siteUrl, url: feed.url })
        : null,
    [feed],
  );
  const compatibleFolders = useMemo<Folder[]>(
    () =>
      feed
        ? (feedMenu.folders ?? []).filter((folder) => folder.type === feed.type)
        : [],
    [feed, feedMenu.folders],
  );

  if (!entry || !readAction) return null;

  const close = () => {
    onOpenChange(false);
    setSubmenu(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) setSubmenu(null);
    onOpenChange(next);
  };

  const handleMoveToFolder = (folderId: string | null) => {
    if (!feed) return;
    feedMenu.onMoveToFolder?.(feed.id, folderId);
    close();
  };

  const handleChangeType = (type: ContentType) => {
    if (!feed) return;
    feedMenu.onChangeType?.(feed.id, type);
    close();
  };

  const handleNewRule = () => {
    if (!feed) return;
    const cached = feeds.find((item) => item.id === feed.id) ?? feed;
    const rules = queryClient.getQueryData<FilterRule[]>(["filters"]) ?? [];
    openFilterEditorForFeed(cached, rules, t("automation.rule_merged_note"));
    close();
  };

  const title =
    submenu === "folder"
      ? t("actions.move_to_folder")
      : submenu === "type"
        ? t("actions.change_type")
        : entry.title || t("entry.untitled");

  return (
    <MobileActionSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      anchor={placement === "anchor" ? anchor : null}
    >
      {submenu === "folder" ? (
        <>
          <MobileActionSheetItem
            icon={<ArrowLeft className="size-5" />}
            label={t("actions.back")}
            onClick={() => setSubmenu(null)}
          />
          <MobileActionSheetItem
            icon={<FolderInput className="size-5" />}
            label={t("actions.no_folder")}
            selected={!feed?.folderId}
            onClick={() => handleMoveToFolder(null)}
          />
          {compatibleFolders.map((folder) => (
            <MobileActionSheetItem
              key={folder.id}
              icon={<FolderInput className="size-5" />}
              label={folder.name}
              selected={feed?.folderId === folder.id}
              onClick={() => handleMoveToFolder(folder.id)}
            />
          ))}
        </>
      ) : submenu === "type" ? (
        <>
          <MobileActionSheetItem
            icon={<ArrowLeft className="size-5" />}
            label={t("actions.back")}
            onClick={() => setSubmenu(null)}
          />
          {CONTENT_TYPE_ORDER.map((type) => {
            const { icon: Icon, labelKey } = contentTypeMeta[type];
            return (
              <MobileActionSheetItem
                key={type}
                icon={<Icon className="size-5" />}
                label={t(labelKey)}
                selected={feed?.type === type}
                onClick={() => handleChangeType(type)}
              />
            );
          })}
        </>
      ) : (
        <>
          <MobileActionSheetItem
            icon={<readAction.Icon className="size-5" />}
            label={t(readAction.labelKey)}
            selected={!entry.read}
            onClick={() => {
              close();
              markAsRead({ id: entry.id, read: readAction.nextRead });
            }}
          />
          <MobileActionSheetItem
            icon={
              <Star
                className="size-5"
                fill={entry.starred ? "currentColor" : "none"}
              />
            }
            label={
              entry.starred
                ? t("entry.remove_from_starred")
                : t("entry.add_to_starred")
            }
            selected={entry.starred}
            onClick={() => {
              close();
              markAsStarred({ id: entry.id, starred: !entry.starred });
            }}
          />
          {onMarkAbove && (
            <MobileActionSheetItem
              icon={<ChevronsUp className="size-5" />}
              label={t("entry.mark_above_read")}
              onClick={() => {
                close();
                onMarkAbove(entry.id);
              }}
            />
          )}
          {entry.muted && (
            <MobileActionSheetItem
              icon={<BellOff className="size-5" />}
              label={t("automation.unmute_entry")}
              onClick={() => {
                close();
                unmute.mutate(entry.id, {
                  onSuccess: () => showToast(t("automation.unmuted")),
                });
              }}
            />
          )}
          <MobileActionSheetItem
            icon={<ShieldOff className="size-5" />}
            label={t("automation.exception_entry")}
            disabled={exception.isPending}
            onClick={() => {
              close();
              exception.mutate(entry.id, {
                onSuccess: (rule) =>
                  showToast(
                    t("automation.exception_created", { name: rule.name }),
                  ),
                onError: () => showToast(t("automation.exception_failed")),
              });
            }}
          />
          <MobileActionSheetItem
            icon={<Wand2 className="size-5" />}
            label={t("automation.rule_from_entry")}
            onClick={() => {
              close();
              openFilterEditorForEntry(entry);
            }}
          />

          {feed ? (
            <>
              <div className="mt-1 border-t border-border/50 pt-2">
                <div className="flex items-center gap-2 px-5 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  <FeedAvatar
                    iconPath={feed.iconPath}
                    size={16}
                    rounded="circle"
                  />
                  <span className="min-w-0 truncate">
                    {t("entry.feed_menu_group", { name: feed.title })}
                  </span>
                </div>
              </div>
              <MobileActionSheetItem
                icon={<RefreshCw className="size-5" />}
                label={t("actions.refresh")}
                onClick={() => {
                  feedMenu.onRefresh?.(feed.id);
                  close();
                }}
              />
              <MobileActionSheetItem
                icon={<Pencil className="size-5" />}
                label={t("actions.edit")}
                onClick={() => {
                  feedMenu.onEdit?.(feed.id);
                  close();
                }}
              />
              <MobileActionSheetItem
                icon={<FolderInput className="size-5" />}
                label={t("actions.move_to_folder")}
                onClick={() => setSubmenu("folder")}
              />
              <MobileActionSheetItem
                icon={<Tags className="size-5" />}
                label={t("actions.change_type")}
                onClick={() => setSubmenu("type")}
              />
              {feed.url ? (
                <MobileActionSheetItem
                  icon={<Copy className="size-5" />}
                  label={t("actions.copy_feed_url")}
                  onClick={() => {
                    void copyToClipboard(
                      feed.url,
                      t("actions.copied_feed_url"),
                      t("actions.copy_failed"),
                    );
                    close();
                  }}
                />
              ) : null}
              {siteUrl ? (
                <>
                  <MobileActionSheetItem
                    icon={<ExternalLink className="size-5" />}
                    label={t("actions.open_site")}
                    onClick={() => {
                      window.open(
                        siteUrl,
                        "_blank",
                        "noopener,noreferrer",
                      );
                      close();
                    }}
                  />
                  <MobileActionSheetItem
                    icon={<Globe className="size-5" />}
                    label={t("actions.copy_site_url")}
                    onClick={() => {
                      void copyToClipboard(
                        siteUrl,
                        t("actions.copied_site_url"),
                        t("actions.copy_failed"),
                      );
                      close();
                    }}
                  />
                </>
              ) : null}
              <MobileActionSheetItem
                icon={<Bolt className="size-5" />}
                label={t("automation.rule_from_feed")}
                onClick={handleNewRule}
              />
              {feedMenu.onDelete ? (
                <MobileActionSheetItem
                  icon={<Trash2 className="size-5" />}
                  label={t("actions.delete")}
                  danger
                  onClick={() => {
                    feedMenu.onDelete?.(feed.id);
                    close();
                  }}
                />
              ) : null}
            </>
          ) : null}
        </>
      )}
    </MobileActionSheet>
  );
}
