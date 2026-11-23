import { useCallback } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  useInfiniteQuery,
} from "@tanstack/react-query";
import {
  listEntries,
  getEntry,
  updateEntryReadStatus,
  updateManyEntryReadStatus,
  updateEntryStarred,
  markAllAsRead,
  getUnreadCounts,
  getStarredCount,
} from "@/api";
import { countLoadedEntries } from "@/lib/entry-pagination";
import {
  deferUnreadRemovals,
  patchDeferredEntry,
} from "@/components/entry-list/deferred-removal";
import type {
  ContentType,
  Entry,
  EntryListParams,
  MarkAllReadParams,
} from "@/types/api";

function entriesQueryKey(params: EntryListParams) {
  return ["entries", params] as const;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function useEntriesInfinite(params: Omit<EntryListParams, "offset">) {
  const pageSize = params.limit ?? 50;

  return useInfiniteQuery({
    queryKey: entriesQueryKey({ ...params, limit: pageSize }),
    queryFn: ({ pageParam = 0 }) =>
      listEntries({ ...params, limit: pageSize, offset: pageParam }),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined;
      return countLoadedEntries(allPages);
    },
    initialPageParam: 0,
  });
}

export function useEntry(id: string | null) {
  return useQuery({
    queryKey: ["entry", id],
    queryFn: () => getEntry(id!),
    enabled: id !== null,
    staleTime: 60_000,
  });
}

export function useUnreadCounts() {
  return useQuery({
    queryKey: ["unreadCounts"],
    queryFn: getUnreadCounts,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

interface MarkAsReadOptions {
  id: string;
  read: boolean;
  /** Skip invalidating entries query (for lightbox to avoid list refresh during viewing) */
  skipInvalidate?: boolean;
}

interface MarkManyAsReadOptions {
  ids: string[];
  read: boolean;
  skipInvalidate?: boolean;
}

export function useMarkAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, read }: MarkAsReadOptions) =>
      updateEntryReadStatus(id, read),

    // Optimistic update: immediately update UI before API call completes
    onMutate: async ({ id, read }) => {
      // Cancel outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: ["entry", id] });
      await queryClient.cancelQueries({ queryKey: ["entries"] });

      // Snapshot previous values for rollback
      const previousEntry = queryClient.getQueryData<Entry>(["entry", id]);
      const previousEntries = queryClient.getQueriesData<{
        pages: { entries: Entry[] }[];
      }>({
        queryKey: ["entries"],
      });

      // Optimistically update single entry cache
      queryClient.setQueryData(["entry", id], (old: Entry | undefined) => {
        if (!old) return old;
        return { ...old, read };
      });

      // Optimistically update entries list cache
      queryClient.setQueriesData<{ pages: { entries: Entry[] }[] }>(
        { queryKey: ["entries"] },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              entries: page.entries.map((entry) =>
                entry.id === id ? { ...entry, read } : entry,
              ),
            })),
          };
        },
      );

      return { previousEntry, previousEntries };
    },

    onSuccess: (_, { id, read, skipInvalidate }) => {
      // Always update unread counts immediately
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      // viewCounts 靠 useViewCounts 自带 120s 自动刷，这里不手动 invalidate
      if (skipInvalidate) return;
      // 47-1：手动标已读时**不要当场把条目从「只看未读」列表里摘掉**。
      // 留到离开这个列表（resetKey 变）时由 useScrollMarkRead 统一清理；
      // 期间任何一次重拉丢掉的条目由 mergeDeferredRemovals 按原位插回。
      // 只标已读才需要「留」；标未读不影响列表归属，照旧刷新。
      if (read) {
        deferUnreadRemovals(queryClient, new Set([id]));
        // 乐观更新在 onMutate 已把各缓存里的 read 置真，这里再确保 deferred 快照同步。
        patchDeferredEntry(id, { read: true });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["entries"] });
    },

    onError: (_, { id }, context) => {
      // Rollback to previous values on error
      if (context?.previousEntry) {
        queryClient.setQueryData(["entry", id], context.previousEntry);
      }
      if (context?.previousEntries) {
        for (const [queryKey, data] of context.previousEntries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
  });
}

export function useMarkManyAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ ids, read }: MarkManyAsReadOptions) => {
      const uniqueIds = uniqueStrings(ids);
      if (uniqueIds.length === 0) return;
      await updateManyEntryReadStatus(uniqueIds, read);
    },

    onMutate: async ({ ids, read }) => {
      const uniqueIds = uniqueStrings(ids);
      await Promise.all(
        uniqueIds.map((id) =>
          queryClient.cancelQueries({ queryKey: ["entry", id] }),
        ),
      );
      await queryClient.cancelQueries({ queryKey: ["entries"] });

      const previousEntriesById = new Map(
        uniqueIds.map(
          (id) => [id, queryClient.getQueryData<Entry>(["entry", id])] as const,
        ),
      );
      const previousEntries = queryClient.getQueriesData<{
        pages: { entries: Entry[] }[];
      }>({
        queryKey: ["entries"],
      });
      const idSet = new Set(uniqueIds);

      for (const id of uniqueIds) {
        queryClient.setQueryData(["entry", id], (old: Entry | undefined) => {
          if (!old) return old;
          return { ...old, read };
        });
      }

      queryClient.setQueriesData<{ pages: { entries: Entry[] }[] }>(
        { queryKey: ["entries"] },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              entries: page.entries.map((entry) =>
                idSet.has(entry.id) ? { ...entry, read } : entry,
              ),
            })),
          };
        },
      );

      return { previousEntriesById, previousEntries };
    },

    onSuccess: (_, { skipInvalidate }) => {
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      // viewCounts 靠 useViewCounts 自带 120s 自动刷，这里不手动 invalidate
      if (!skipInvalidate) {
        queryClient.invalidateQueries({ queryKey: ["entries"] });
      }
    },

    onError: (_, { ids }, context) => {
      const uniqueIds = uniqueStrings(ids);
      for (const id of uniqueIds) {
        const previousEntry = context?.previousEntriesById.get(id);
        if (previousEntry) {
          queryClient.setQueryData(["entry", id], previousEntry);
        }
      }
      if (context?.previousEntries) {
        for (const [queryKey, data] of context.previousEntries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
  });
}

/** Remove specific entries from unreadOnly list cache (for delayed removal) */
export function useRemoveFromUnreadList() {
  const queryClient = useQueryClient();

  return useCallback(
    (idsToRemove: Set<string>) => {
      const queries = queryClient.getQueriesData<{
        pages: { entries: Entry[]; hasMore: boolean }[];
      }>({
        queryKey: ["entries"],
      });

      for (const [queryKey, data] of queries) {
        // Only process unreadOnly queries
        const params = queryKey[1] as EntryListParams | undefined;
        if (!params?.unreadOnly || !data) continue;

        const updatedData = {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            entries: page.entries.filter((entry) => !idsToRemove.has(entry.id)),
          })),
        };

        queryClient.setQueryData(queryKey, updatedData);
      }
    },
    [queryClient],
  );
}

export function useMarkAllAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: MarkAllReadParams) => markAllAsRead(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      // 已读/星标都是视图条件里会用到的字段，命中数要跟着刷新
      queryClient.invalidateQueries({ queryKey: ["viewCounts"] });
    },
  });
}

export function useStarredCount(contentType?: ContentType) {
  return useQuery({
    // 两档星标各一个数（全部 / 只当前内容类型），缓存键要带内容类型
    queryKey: ["starredCount", contentType ?? "all"],
    queryFn: () => getStarredCount(contentType),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useMarkAsStarred() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, starred }: { id: string; starred: boolean }) =>
      updateEntryStarred(id, starred),

    // 乐观更新：点星标的瞬间就把单条缓存与列表行改成新状态，不等接口返回
    onMutate: async ({ id, starred }) => {
      // 先取消在途的请求，避免它们回来覆盖乐观更新
      await queryClient.cancelQueries({ queryKey: ["entry", id] });
      await queryClient.cancelQueries({ queryKey: ["entries"] });

      // 快照旧值，出错时回滚
      const previousEntry = queryClient.getQueryData<Entry>(["entry", id]);
      const previousEntries = queryClient.getQueriesData<{
        pages: { entries: Entry[] }[];
      }>({
        queryKey: ["entries"],
      });

      // 单条条目缓存
      queryClient.setQueryData(["entry", id], (old: Entry | undefined) => {
        if (!old) return old;
        return { ...old, starred };
      });

      // 列表无限查询缓存：把匹配条目的 starred 就地 patch（不重拉）
      queryClient.setQueriesData<{ pages: { entries: Entry[] }[] }>(
        { queryKey: ["entries"] },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              entries: page.entries.map((entry) =>
                entry.id === id ? { ...entry, starred } : entry,
              ),
            })),
          };
        },
      );

      return { previousEntry, previousEntries };
    },

    onSuccess: (_, { id, starred }) => {
      // 47-1：若这条正被「先别摘」记着，同步快照里的星标态，
      // 免得列表重拉时 mergeDeferredRemovals 用旧快照把星标盖回去。
      patchDeferredEntry(id, { starred });
      queryClient.invalidateQueries({ queryKey: ["starredCount"] });
      // viewCounts 靠 useViewCounts 自带 120s 自动刷，这里不手动 invalidate
      //
      // ⚠️ 这里**不要** invalidateQueries(["entries"])：星标不改变「只看未读 / 全部」的
      // 列表归属（unreadOnly 只按已读态过滤）。整表重拉会把刚在正文里自动标成已读、
      // 仅靠 deferred 机制留住的条目换掉 —— 条目随之消失、列表跳动（用户报的 BUG）。
      // 可见行的星标态已由上面的乐观 patch 更新，无需再重拉。
    },

    onError: (_, { id }, context) => {
      // 出错回滚到旧值
      if (context?.previousEntry) {
        queryClient.setQueryData(["entry", id], context.previousEntry);
      }
      if (context?.previousEntries) {
        for (const [queryKey, data] of context.previousEntries) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
  });
}
