import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createFeed,
  createFolder,
  listFeeds,
  listFolders,
  moveFeedToFolder,
  previewFeed,
} from "@/api";
import { getErrorMessage } from "@/lib/errors";
import { rewriteRssHubUrl } from "@/lib/rsshub";
import { planDomainGroup } from "@/lib/feed-group";
import { showToast } from "@/stores/toast-store";
import type { TFunction } from "i18next";
import { useGeneralSettings } from "@/hooks/useGeneralSettings";
import type { ContentType, FeedPreview, Folder } from "@/types/api";

export interface SubscribeOptions {
  folderName?: string;
  title?: string;
  targetFolderType?: ContentType;
}

interface UseAddFeedReturn {
  feedPreview: FeedPreview | null;
  isLoading: boolean;
  error: string | null;
  /** 用户输入的是 RSSHub 地址且被换到自有实例时，这里是原始地址 */
  rewrittenFrom: string | null;
  discoverFeed: (url: string) => Promise<void>;
  subscribeFeed: (
    feedUrl: string,
    options: SubscribeOptions,
  ) => Promise<boolean>;
  clearPreview: () => void;
  clearError: () => void;
}

/**
 * 52-5：添加成功后试着「按网站域名自动分组」。
 *
 * 只在调用方确认「用户没手选文件夹」后执行；判定逻辑在 `planDomainGroup`（纯函数、可单测），
 * 这里只负责取数、建文件夹、挪订阅、失效缓存、说一句人话。
 * 任何一步出错都吞掉（订阅已经成功了，不能因为收拾失败反过来报错）。
 */
async function maybeAutoGroupByDomain(
  feedId: string,
  contentType: ContentType,
  queryClient: ReturnType<typeof useQueryClient>,
  t: TFunction,
): Promise<void> {
  try {
    const feeds = await listFeeds();
    const plan = planDomainGroup(feeds, feedId, contentType);
    if (!plan) return;

    // 文件夹必须**按域名找、没有才建**：同名同层的文件夹后端回 409（folder_service.go:81），
    // 直接 createFolder 会在「用户早就有一个同名夹」时整个抛错、被下面的 catch 吞掉，
    // 表现成「分组静默没生效」（真机实测抓到：库里有 127.0.0.1 夹后，两次添加都没挪）。
    const folders = await listFolders();
    let folder = folders.find(
      (item) =>
        item.name.toLowerCase() === plan.name.toLowerCase() &&
        item.type === contentType &&
        !item.parentId,
    );
    if (!folder) {
      folder = await createFolder({ name: plan.name, type: contentType });
    }
    await Promise.all(
      plan.feedIds.map((id) => moveFeedToFolder(id, folder.id)),
    );
    await queryClient.invalidateQueries({ queryKey: ["folders"] });
    await queryClient.invalidateQueries({ queryKey: ["feeds"] });
    showToast(
      t("add_feed.auto_grouped", { name: plan.name, count: plan.feedIds.length }),
    );
  } catch (err) {
    console.warn("auto group by domain failed", err);
  }
}

async function findOrCreateFolder(
  folderName: string,
  existingFolders: Folder[],
  targetType: ContentType,
): Promise<string> {
  // 20-3：支持多层路径（`父 / 子` 或 `父/子`），逐层 find-or-create。
  // 不这么做的话，同名子文件夹会误匹配到别的层，新建也只能建在根目录。
  const segments = folderName
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (segments.length === 0) {
    throw new Error("empty folder name");
  }
  const knownFolders = [...existingFolders];
  let parentId: string | undefined;
  for (const segment of segments) {
    const existing = knownFolders.find(
      (folder) =>
        folder.name.toLowerCase() === segment.toLowerCase() &&
        folder.type === targetType &&
        (folder.parentId ?? undefined) === parentId,
    );
    if (existing) {
      parentId = existing.id;
    } else {
      const created = await createFolder({
        name: segment,
        parentId,
        type: targetType,
      });
      knownFolders.push(created);
      parentId = created.id;
    }
  }
  return parentId as string;
}

export function useAddFeed(
  contentType: ContentType = "article",
): UseAddFeedReturn {
  const [feedPreview, setFeedPreview] = useState<FeedPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: generalSettings } = useGeneralSettings();
  const [rewrittenFrom, setRewrittenFrom] = useState<string | null>(null);

  // RSSHub 地址自动换到自有实例（设置里配了才生效）
  const applyRssHubBase = useCallback(
    (rawUrl: string): string => {
      const baseUrl = generalSettings?.rsshubBaseUrl ?? "";
      if (!baseUrl) return rawUrl;

      const rewritten = rewriteRssHubUrl(
        rawUrl,
        baseUrl,
        generalSettings?.rsshubAccessKey ?? "",
      );
      if (!rewritten || rewritten === rawUrl) return rawUrl;

      setRewrittenFrom(rawUrl);
      return rewritten;
    },
    [generalSettings],
  );

  const clearPreview = useCallback(() => {
    setFeedPreview(null);
    setRewrittenFrom(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const discoverFeed = useCallback(async (url: string) => {
    setIsLoading(true);
    setError(null);
    setFeedPreview(null);
    setRewrittenFrom(null);

    try {
      const data = await previewFeed(applyRssHubBase(url));
      setFeedPreview(data);
    } catch (err) {
      setError(
        getErrorMessage(
          err,
          "Failed to fetch feed. Please check the URL and try again.",
        ),
      );
    } finally {
      setIsLoading(false);
    }
  }, [applyRssHubBase]);

  const subscribeFeed = useCallback(
    async (feedUrl: string, options: SubscribeOptions): Promise<boolean> => {
      setIsLoading(true);
      setError(null);

      try {
        let folderId: string | undefined;
        let feedType: ContentType = contentType;

        if (options.folderName) {
          const folders = await listFolders();
          const targetType = options.targetFolderType || contentType;
          folderId = await findOrCreateFolder(
            options.folderName,
            folders,
            targetType,
          );
          feedType = targetType;
          await queryClient.invalidateQueries({ queryKey: ["folders"] });
        }

        const created = await createFeed({
          url: applyRssHubBase(feedUrl),
          folderId,
          title: options.title,
          type: feedType,
        });
        await queryClient.invalidateQueries({ queryKey: ["feeds"] });
        await queryClient.invalidateQueries({ queryKey: ["entries"] });
        await queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });

        // 52-5：这条也没进文件夹时，试着按网站域名自动分组（口径与触发条件见 lib/feed-group.ts）。
        // 失败不影响订阅本身 —— 已经订阅成功了，分组只是顺手收拾。
        if (!folderId) {
          await maybeAutoGroupByDomain(
            created.id,
            feedType,
            queryClient,
            t,
          );
        }
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.message === "feed_exists") {
          setError(t("add_feed.feed_exists"));
        } else {
          setError(getErrorMessage(err, "Failed to subscribe to feed."));
        }
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [applyRssHubBase, queryClient, contentType, t],
  );

  return {
    feedPreview,
    isLoading,
    error,
    rewrittenFrom,
    discoverFeed,
    subscribeFeed,
    clearPreview,
    clearError,
  };
}
