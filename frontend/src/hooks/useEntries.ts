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
    queryFn: ({ pageParam = 0, signal }) =>
      listEntries({ ...params, limit: pageSize, offset: pageParam }, signal),
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
    queryFn: ({ signal }) => getEntry(id!, signal),
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

/**
 * 兜底清理：把「只看未读」缓存里**所有已读（read === true）**的条目一次性摘掉。
 *
 * 为什么需要它：延迟摘除（`deferRemoval`）只对**记过账**的 id 生效。但「点开条目」
 * 路径（`EntryContent` 卸载走 `deferUnreadRemovals`）和「滚动标已读批次还没落账就导航」
 * 的竞态，都会出现「服务端已标已读、乐观更新也把缓存里的 read 置真，却没进 deferred 记账」
 * 的条目。这类条目留在 unreadOnly 缓存里，回到列表时就变成「已读却不消失」，只有刷新
 * 或重拉才会清（用户报的 BUG：「分享」读完 → 点回内容类型视图 → 再回「分享」不消失）。
 *
 * 语义：任何时候**离开**一个列表，unreadOnly 缓存里都不该再出现已读条目。所以在
 * `useScrollMarkRead` 的 flush effect（resetKey 变 = 离开列表）里调用它，按 read 字段
 * 扫一遍所有 unreadOnly 查询，把已读条目统一摘掉 —— 不依赖具体 id 记账，覆盖所有路径。
 */
export function useRemoveReadEntriesFromUnreadList() {
  const queryClient = useQueryClient();

  return useCallback(() => {
    const queries = queryClient.getQueriesData<{
      pages: { entries: Entry[]; hasMore?: boolean }[];
    }>({
      queryKey: ["entries"],
    });

    for (const [queryKey, data] of queries) {
      const params = queryKey[1] as EntryListParams | undefined;
      // 只处理「只看未读」的查询：非 unreadOnly 列表本来就可以有已读条目
      if (!params?.unreadOnly || !data) continue;

      let changed = false;
      const pages = data.pages.map((page) => {
        const kept = page.entries.filter((entry) => !entry.read);
        if (kept.length === page.entries.length) return page;
        changed = true;
        return { ...page, entries: kept };
      });

      if (changed) {
        queryClient.setQueryData(queryKey, { ...data, pages });
      }
    }
  }, [queryClient]);
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
      // ⚠️ 默认**不要** invalidateQueries(["entries"])：星标本身不改变「只看未读 / 全部」的
      // 列表归属（unreadOnly 只按已读态过滤）。整表重拉会把刚在正文里自动标成已读、
      // 仅靠 deferred 机制留住的条目换掉 —— 条目随之消失、列表跳动（用户报的 BUG）。
      // 可见行的星标态已由上面的乐观 patch 更新，无需再重拉。
      //
      // 例外：取消星标（starred===false）时「仅星标」视图（starredOnly 过滤）需要重拉，
      // 否则乐观 patch 只把该行 starred 改成 false，行仍留在星标列表里直到手动刷新。
      // 只对 starredOnly===true 的 entries 查询 invalidate，其它视图一律不动，避免重新引入消失 bug。
      if (!starred) {
        queryClient.invalidateQueries({
          queryKey: ["entries"],
          predicate: (query) => {
            const params = query.queryKey[1] as
              | { starredOnly?: boolean }
              | undefined;
            return params?.starredOnly === true;
          },
        });
      }
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
