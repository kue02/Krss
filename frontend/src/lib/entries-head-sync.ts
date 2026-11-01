import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { listEntries } from "@/api";
import type { Entry, EntryListParams, EntryListResponse } from "@/types/api";

/**
 * 58-3「新条目无感添加」：刷新完成时把新条目并到已加载列表的头部，
 * 而不是按旧 offset 把整个窗口重拉一遍。
 *
 * 为什么不能整窗重拉：列表是 offset 分页（pageSize 50），已加载 N 页时窗口覆盖
 * 「第 0 ~ 50N 条」。刷新往头部插入 S 条后，按旧 offset 重拉拿到的是**新的**第
 * 0 ~ 50N 条 —— 用户正在读的那张卡被顶到 50N 之外，节点直接从 DOM 里消失，
 * 浏览器原生 scroll anchoring 也失去锚点，表现就是「读着读着列表整块滚过去/
 * 内容换了一批」（2026-11-01 实测：头部插 300 条后目标节点 dead、卡片数 250→724）。
 *
 * 这里的做法：往上翻页直到撞见列表里已有的 id，把撞见之前的条目并进第一页。
 * 已加载的节点一个都不动，新增的高度交给浏览器 anchoring / 虚拟列表补偿去吃掉。
 */

/** 一次头部同步最多往上翻多少条（防止「缓存被清空」这类极端场景无限翻页） */
const MAX_SCAN_ENTRIES = 600;

const DEFAULT_PAGE_SIZE = 50;

export interface HeadSyncSummary {
  /** 处理过的列表查询数 */
  queries: number;
  /** 并入的新条目数 */
  added: number;
  /** 与已有列表对不上（如缓存被清空/条目被删）而退回整体重拉的查询数 */
  reloads: number;
}

function isInfiniteEntriesData(
  value: unknown,
): value is InfiniteData<EntryListResponse> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as InfiniteData<EntryListResponse>).pages)
  );
}

/**
 * 对缓存里所有「有数据的条目列表查询」做一次头部同步。
 * 返回统计，便于 DEV 日志与测试断言。
 */
export async function syncEntriesHeads(
  queryClient: QueryClient,
): Promise<HeadSyncSummary> {
  const summary: HeadSyncSummary = { queries: 0, added: 0, reloads: 0 };

  // 只同步当前挂着的列表（切走的视图下次挂载时自己会取最新数据，别在这里白翻页）
  const queries = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["entries"] })
    .filter((query) => query.isActive() && query.getObserversCount() > 0);

  for (const query of queries) {
    const data = query.state.data;
    if (!isInfiniteEntriesData(data) || data.pages.length === 0) continue;

    const knownIds = new Set<string>();
    for (const page of data.pages) {
      for (const entry of page.entries) knownIds.add(entry.id);
    }
    // 列表当前是空的：没有可锚定的窗口，交给普通重拉
    if (knownIds.size === 0) {
      summary.reloads += 1;
      void queryClient.invalidateQueries({ queryKey: query.queryKey });
      continue;
    }

    const params = query.queryKey[1] as EntryListParams;

    /**
     * 文章列表是虚拟列表（行按 index 绝对定位、实测行高缓存在 index 上），
     * 头部插进来的行会让所有行的下标整体后移，实测缓存与下标全部错位，
     * 连「读着的那一行」都可能被卸载 —— 这类列表无法靠并入保住位置，
     * 保持原来的整窗重取（位置保不住，但至少不会把新旧行混着排）。
     */
    if (params.contentType === "article") continue;
    const pageSize = params.limit ?? DEFAULT_PAGE_SIZE;
    const listParams: EntryListParams = { ...params, limit: pageSize };

    const collected: Entry[] = [];
    let offset = 0;
    let matched = false;

    while (offset < MAX_SCAN_ENTRIES) {
      const page = await listEntries({ ...listParams, offset });
      for (const entry of page.entries) {
        if (knownIds.has(entry.id)) {
          matched = true;
          break;
        }
        collected.push(entry);
      }
      if (matched || !page.hasMore || page.entries.length === 0) break;
      offset += page.entries.length;
    }

    summary.queries += 1;

    // 一路翻到上限都没撞见已有条目：说明列表内容被整体换掉了（例如清空缓存后重建），
    // 这时候「并入」只会把过期条目留在屏幕上，退回整体重拉。
    if (!matched) {
      summary.reloads += 1;
      void queryClient.invalidateQueries({ queryKey: query.queryKey });
      continue;
    }

    if (collected.length === 0) continue;

    queryClient.setQueryData<InfiniteData<EntryListResponse>>(
      query.queryKey,
      (old) => {
        if (!old || old.pages.length === 0) return old;
        const first = old.pages[0];
        if (!first) return old;
        const existing = new Set<string>();
        for (const page of old.pages) {
          for (const entry of page.entries) existing.add(entry.id);
        }
        const fresh = collected.filter((entry) => !existing.has(entry.id));
        if (fresh.length === 0) return old;
        summary.added += fresh.length;
        return {
          pages: [
            { ...first, entries: [...fresh, ...first.entries] },
            ...old.pages.slice(1),
          ],
          pageParams: old.pageParams,
        };
      },
    );
  }

  return summary;
}

let inFlight: Promise<HeadSyncSummary> | null = null;
let rerunRequested = false;

/**
 * 供刷新回调调用的入口：同一时刻只跑一次，跑的过程中又被叫到就排队补一次
 * （一轮刷新里每刷完一个源都会并一次，2 秒轮询天然节流）。
 */
export function requestEntriesHeadSync(
  queryClient: QueryClient,
): Promise<HeadSyncSummary> {
  if (inFlight) {
    rerunRequested = true;
    return inFlight;
  }

  const run = async (): Promise<HeadSyncSummary> => {
    let summary = await syncEntriesHeads(queryClient);
    while (rerunRequested) {
      rerunRequested = false;
      summary = await syncEntriesHeads(queryClient);
    }
    return summary;
  };

  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}