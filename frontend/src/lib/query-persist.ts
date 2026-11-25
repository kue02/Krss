import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { createStore, del, get, set } from "idb-keyval";

/**
 * 29：把 react-query 缓存持久化到 IndexedDB，让「切换视图 / 刷新页面」先秒出上次的条目，
 * 再在后台重新拉取（stale-but-instant），对齐 Nextflux 的本地优先体验。
 *
 * 之所以不引 `@tanstack/react-query-persist-client`：本机网络被 TLS 中间人拦截、
 * `bun add` 装不下来；而 react-query 本身已经导出 `dehydrate` / `hydrate`，
 * 用几行手动 persister 就能得到同样效果，且少一个依赖更可控。`idb-keyval` 已是既有依赖。
 *
 * 语义约束（务必保留）：
 * - 只持久化白名单里的查询（条目列表 `["entries", ...]` 为主，条目详情 `["entry", id]` 为辅）。
 *   未读数 / 视图计数 / 各种 mutation / 未完成（pending / fetching）查询一律不落盘。
 * - 恢复出来的缓存是「有意保留的旧数据」：组件挂载后靠既有 staleTime=30s 自动后台重拉，
 *   乐观更新、延迟摘除（deferred-removal）等语义完全不动。
 * - 浏览器专属；无 window / 无 indexedDB（测试）时全部降级为 no-op。
 */

/** 缓存最长保留时间：24h。需 <= QueryClient 的 gcTime，否则恢复的查询会被立刻 GC。 */
export const PERSIST_MAX_AGE = 24 * 60 * 60 * 1000;

/** 落盘节流窗口（ms）：queryCache 变动再频繁，最多每秒写一次。 */
export const PERSIST_THROTTLE_MS = 1000;

/** 恢复阶段最多等这么久，避免 IndexedDB 异常卡住首屏（超时后照常渲染，后台仍会补 hydrate）。 */
const RESTORE_TIMEOUT_MS = 1500;

/**
 * 每个「条目列表」无限查询只持久化**第一页**（约 pageSize 条）。
 *
 * 为什么截断：列表条目带 `content`（正文字段），一页 50 条最大可能到几 MB；用户滚动后
 * 缓存里会累积多页，若全量落盘，滚动时每秒写几 MB 会卡顿、IndexedDB 也会膨胀。
 * 只留第一页足以支撑「刷新后首屏立刻有条目」，且**分页语义不变**：
 * `getNextPageParam` 用 `countLoadedEntries(allPages)` 作为下一页 offset，只有一页时
 * 正好等于 pageSize，用户继续滚动会从 offset=pageSize 接着拉，与未截断时一致。
 */
const MAX_PERSISTED_PAGES = 1;

const IDB_DB_NAME = "krss-query-cache";
const IDB_STORE_NAME = "cache";
const SNAPSHOT_KEY = "snapshot";

/**
 * 落盘白名单：按 queryKey[0]（查询族根）判断。
 * - `entries`：条目列表（无限查询分页），本地优先的主收益来源。
 * - `entry`：单条详情，让「直接点开某篇文章」也能秒出。
 */
const PERSISTED_ROOT_KEYS: ReadonlySet<string> = new Set(["entries", "entry"]);

const idbStore = createStore(IDB_DB_NAME, IDB_STORE_NAME);

export interface PersistedSnapshot {
  /** 版本号（app version），版本一变即视为不可用并丢弃旧缓存。 */
  buster: string;
  /** 落盘时间戳（ms），用于 maxAge 过期判断。 */
  savedAt: number;
  state: DehydratedState;
}

function isBrowser(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof indexedDB !== "undefined" &&
    typeof document !== "undefined"
  );
}

/** 应用版本，作为持久化 buster（版本升级后旧缓存自动作废）。 */
export function getCacheBuster(): string {
  return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
}

/**
 * 只持久化「已完成且当前没在拉取」的白名单查询。
 * - `status !== "success"` 排除 pending / error（没有可用的 data）。
 * - `fetchStatus === "fetching"` 排除正在跑（running）的查询，避免把半途状态落盘。
 */
export function shouldDehydrateQuery(query: Query): boolean {
  if (query.state.status !== "success") return false;
  if (query.state.fetchStatus === "fetching") return false;
  const root = query.queryKey[0];
  return typeof root === "string" && PERSISTED_ROOT_KEYS.has(root);
}

/** 当前缓存 → 可持久化的 dehydrated 状态（纯内存操作，便于测试）。 */
export function computeDehydratedState(
  queryClient: QueryClient,
): DehydratedState {
  return dehydrate(queryClient, {
    shouldDehydrateQuery,
    // mutation 一律不落盘
    shouldDehydrateMutation: () => false,
  });
}

interface InfiniteLikeData {
  pages?: unknown[];
  pageParams?: unknown[];
}

/**
 * 给 dehydrated 状态「瘦身」：无限查询只保留第一页，控制落盘体积。
 * 非无限查询（条目详情）原样保留。
 */
export function boundDehydratedState(state: DehydratedState): DehydratedState {
  return {
    mutations: state.mutations,
    queries: state.queries.map((query) => {
      if (query.queryType !== "infinite") return query;
      const data = query.state.data as InfiniteLikeData | undefined;
      if (!data || !Array.isArray(data.pages)) return query;
      if (data.pages.length <= MAX_PERSISTED_PAGES) return query;
      return {
        ...query,
        state: {
          ...query.state,
          data: {
            ...data,
            pages: data.pages.slice(0, MAX_PERSISTED_PAGES),
            pageParams: Array.isArray(data.pageParams)
              ? data.pageParams.slice(0, MAX_PERSISTED_PAGES)
              : data.pageParams,
          },
        },
      };
    }),
  };
}

/** 快照是否仍然可用（buster 匹配且未超过 maxAge）。 */
export function isSnapshotFresh(
  snapshot: PersistedSnapshot,
  buster: string,
  now: number,
  maxAge: number = PERSIST_MAX_AGE,
): boolean {
  if (snapshot.buster !== buster) return false;
  const age = now - snapshot.savedAt;
  // 未来时间戳（时钟回拨）也当作过期，避免永远命中脏数据
  return age >= 0 && age <= maxAge;
}

/** 从 IndexedDB 读快照；失败/无数据返回 undefined。 */
export async function readSnapshot(): Promise<PersistedSnapshot | undefined> {
  if (!isBrowser()) return undefined;
  try {
    return await get<PersistedSnapshot>(SNAPSHOT_KEY, idbStore);
  } catch (error) {
    console.warn("[cache] 读取 IndexedDB 快照失败", error);
    return undefined;
  }
}

/** 把快照写入 IndexedDB；失败仅告警，不影响前台。 */
export async function writeSnapshot(snapshot: PersistedSnapshot): Promise<void> {
  if (!isBrowser()) return;
  try {
    await set(SNAPSHOT_KEY, snapshot, idbStore);
  } catch (error) {
    console.warn("[cache] 写入 IndexedDB 快照失败", error);
  }
}

/** 删除 IndexedDB 快照（版本失配 / 过期时清理）。 */
export async function clearSnapshot(): Promise<void> {
  if (!isBrowser()) return;
  try {
    await del(SNAPSHOT_KEY, idbStore);
  } catch (error) {
    console.warn("[cache] 清理 IndexedDB 快照失败", error);
  }
}

/**
 * 把当前缓存落盘一次。没有可持久化的查询时清空快照，避免留下旧数据。
 */
export async function persistNow(queryClient: QueryClient): Promise<void> {
  if (!isBrowser()) return;
  const state = boundDehydratedState(computeDehydratedState(queryClient));
  if (state.queries.length === 0) {
    await clearSnapshot();
    return;
  }
  await writeSnapshot({
    buster: getCacheBuster(),
    savedAt: Date.now(),
    state,
  });
}

/**
 * 订阅 queryCache，节流落盘；页面隐藏 / 卸载时再补一次 best-effort 落盘。
 * 返回取消订阅函数。
 */
export function attachPersister(queryClient: QueryClient): () => void {
  if (!isBrowser()) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let disposed = false;

  const flush = (): void => {
    timer = null;
    if (!dirty || disposed) return;
    dirty = false;
    void persistNow(queryClient);
  };

  const schedule = (): void => {
    dirty = true;
    if (timer !== null) return; // 节流：窗口内的多次变动合并成一次写
    timer = setTimeout(flush, PERSIST_THROTTLE_MS);
  };

  const unsubscribe = queryClient.getQueryCache().subscribe(schedule);

  const onPageHide = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    dirty = true;
    flush();
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") onPageHide();
  };

  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    disposed = true;
    unsubscribe();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * 从 IndexedDB 恢复缓存到 queryClient。
 * 版本失配 / 过期 → 清掉快照并返回 false。返回是否真正 hydrate 了数据。
 */
export async function restoreSnapshot(
  queryClient: QueryClient,
  options?: { now?: number; maxAge?: number },
): Promise<boolean> {
  if (!isBrowser()) return false;
  const snapshot = await readSnapshot();
  if (!snapshot) return false;

  const now = options?.now ?? Date.now();
  if (!isSnapshotFresh(snapshot, getCacheBuster(), now, options?.maxAge)) {
    await clearSnapshot();
    return false;
  }

  hydrate(queryClient, snapshot.state);
  return true;
}

/**
 * 启动引导：先尝试恢复（带超时兜底），再挂上节流落盘订阅。
 * 在渲染根组件之前 await 它，让缓存数据在首帧就位；即使超时也不会阻塞应用启动。
 */
export async function bootstrapQueryCache(
  queryClient: QueryClient,
  options?: { timeoutMs?: number },
): Promise<void> {
  if (!isBrowser()) return;

  const timeoutMs = options?.timeoutMs ?? RESTORE_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    await Promise.race([restoreSnapshot(queryClient), timeout]);
  } catch (error) {
    console.warn("[cache] 恢复 IndexedDB 快照失败", error);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  attachPersister(queryClient);
}
