import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { refreshFeeds } from "@/api";
import { showToast } from "@/stores/toast-store";
import {
  useDeleteFeed,
  useFeeds,
  useUpdateFeed,
  useUpdateFeedType,
} from "@/hooks/useFeeds";
import { useFolders } from "@/hooks/useFolders";
import { useEditingFeedStore } from "@/stores/editing-feed-store";
import type { FeedMenuActions } from "@/components/feed/FeedContextMenuItems";
import type { ContentType, Folder } from "@/types/api";

/**
 * 订阅右键菜单的**唯一一份行为**（卡 B：第一栏与第二栏共用）。
 *
 * 原来这五个函数只活在 `Sidebar.tsx` 里（作为 props 传给 FeedItem），
 * 第二栏要复用就得把实现抽出来 —— 与 `FeedContextMenuItems`（呈现）配对，
 * 两栏渲染同一份组件、调用同一份函数，不照抄第二份。
 */
export function useFeedMenuActions(): Required<FeedMenuActions> & {
  folders: Folder[];
} {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: allFeeds = [] } = useFeeds();
  const { data: folders = [] } = useFolders();
  const { mutate: deleteFeed } = useDeleteFeed();
  const { mutate: updateFeed } = useUpdateFeed();
  const { mutate: updateFeedType } = useUpdateFeedType();
  const openForFeed = useEditingFeedStore((state) => state.openForFeed);

  const handleEditFeed = useCallback(
    (feedId: string) => {
      const feed = allFeeds.find((item) => item.id === feedId);
      if (feed) openForFeed(feed);
    },
    [allFeeds, openForFeed],
  );

  const handleDeleteFeed = useCallback(
    (feedId: string) => {
      deleteFeed(feedId);
    },
    [deleteFeed],
  );

  const handleMoveToFolder = useCallback(
    (feedId: string, folderId: string | null) => {
      const feed = allFeeds.find((item) => item.id === feedId);
      if (!feed) return;

      if (folderId !== null) {
        const folder = folders.find((item) => item.id === folderId);
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

  return {
    folders,
    onRefresh: handleRefreshFeed,
    onEdit: handleEditFeed,
    onDelete: handleDeleteFeed,
    onMoveToFolder: handleMoveToFolder,
    onChangeType: handleChangeFeedType,
  };
}
