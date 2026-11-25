import type { QueryClient } from "@tanstack/react-query";
import type { Entry } from "@/types/api";

/**
 * 从已加载的条目列表缓存里找同 id 的条目。
 *
 * 用途：列表来自本地持久化缓存（IndexedDB）时，旧条目可能在服务端已被清理，
 * `GET /api/entries/{id}` 会 404。此时正文位如果只显示「选择一篇文章」会误导用户；
 * 列表本身带着（被后端截断到 2000 字的）content，可以先拿来展示，并明确提示可能不完整。
 *
 * 注意：这里返回的 content 是列表口径（后端 `ListContentTruncate = 2000`，且没有
 * readable_content），只能作为降级预览，不能写回 `["entry", id]` 详情缓存。
 */
export function findCachedListEntry(
  queryClient: QueryClient,
  id: string,
): Entry | undefined {
  for (const [, data] of queryClient.getQueriesData<unknown>({
    queryKey: ["entries"],
  })) {
    if (!data || typeof data !== "object") continue;
    const pages = (data as { pages?: unknown }).pages;
    if (!Array.isArray(pages)) continue;
    for (const page of pages) {
      if (!page || typeof page !== "object") continue;
      const entries = (page as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) continue;
      for (const candidate of entries) {
        if (
          candidate &&
          typeof candidate === "object" &&
          (candidate as { id?: unknown }).id === id &&
          typeof (candidate as { content?: unknown }).content === "string" &&
          (candidate as { content: string }).content.length > 0
        ) {
          return candidate as Entry;
        }
      }
    }
  }
  return undefined;
}
