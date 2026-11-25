import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { createStore, del, get, keys, set } from "idb-keyval";
import { LS_KEYS } from "@/lib/settings-storage";

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

/** 恢复阶段最多等这么久，避免 IndexedDB 异常卡住首屏。超时即放弃本次恢复（不 hydrate），
 *  不会阻塞渲染；下次启动再试。 */
const RESTORE_TIMEOUT_MS = 500;

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

/**
 * 缓存归属隔离：快照按「当前登录令牌的指纹」分键存放。
 * - 换账号 / 退出后令牌变化，指纹随之变化，旧快照既读不到也覆盖不了（防跨账号串数据）。
 * - 只存令牌的哈希指纹，不落令牌原文。
 * - 未登录（无令牌）时不落盘，返回 "anon"，persistNow 会直接跳过。
 */
function ownerFingerprint(): string {
  if (typeof localStorage === "undefined") return "anon";
  const token = localStorage.getItem(LS_KEYS.authToken.key) ?? "";
  if (!token) return "anon";
  let h = 5381;
  for (let i = 0; i < token.length; i += 1) {
    h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  }
  return `u${(h >>> 0).toString(36)}`;
}

function getSnapshotKey(): string {
  return `snapshot:${ownerFingerprint()}`;
}

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
  /** 落盘时的账号令牌指纹，恢复前二次校验，防止跨账号串数据。 */
  owner: string;
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
  const trimmed = state.queries.map((query) => {
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
  });

  // 进一步限流（控制落盘体积）：entries 列表只留「最近更新的一条」——每次切视图都会生成
  // 新的 queryKey，全局 gcTime=24h 会把访问过的都留着，全量序列化会是多 MB 的写与膨胀；
  // entry 详情最多留 15 条。其余族（本就不在白名单）原样保留以防将来扩展。
  type DQ = DehydratedState["queries"][number];
  const byUpdatedDesc = (a: DQ, b: DQ): number =>
    (b.state.dataUpdatedAt ?? 0) - (a.state.dataUpdatedAt ?? 0);
  const entries = trimmed
    .filter((q) => q.queryKey[0] === "entries")
    .sort(byUpdatedDesc)
    .slice(0, 1);
  const entryDetails = trimmed
    .filter((q) => q.queryKey[0] === "entry")
    .sort(byUpdatedDesc)
    .slice(0, 15);
  const rest = trimmed.filter(
    (q) => q.queryKey[0] !== "entries" && q.queryKey[0] !== "entry",
  );

  return {
    mutations: state.mutations,
    queries: [...entries, ...entryDetails, ...rest],
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
    return await get<PersistedSnapshot>(getSnapshotKey(), idbStore);
  } catch (error) {
    console.warn("[cache] 读取 IndexedDB 快照失败", error);
    return undefined;
  }
}

/** 把快照写入 IndexedDB；失败仅告警，不影响前台。 */
export async function writeSnapshot(snapshot: PersistedSnapshot): Promise<void> {
  if (!isBrowser()) return;
  try {
    await set(getSnapshotKey(), snapshot, idbStore);
  } catch (error) {
    console.warn("[cache] 写入 IndexedDB 快照失败", error);
  }
}

/** 删除 IndexedDB 快照（版本失配 / 过期时清理）。 */
export async function clearSnapshot(): Promise<void> {
  if (!isBrowser()) return;
  try {
    await del(getSnapshotKey(), idbStore);
  } catch (error) {
    console.warn("[cache] 清理 IndexedDB 快照失败", error);
  }
}

/**
 * 把当前缓存落盘一次。没有可持久化的查询时清空快照，避免留下旧数据。
 */
export async function persistNow(queryClient: QueryClient): Promise<void> {
  if (!isBrowser()) return;
  const owner = ownerFingerprint();
  // 未登录不落盘（避免把登录页 / 上一位用户的残留写进 anon 桶）。
  if (owner === "anon") return;
  const state = boundDehydratedState(computeDehydratedState(queryClient));
  // 空状态多半是「查询正在 refetch（被 shouldDehydrateQuery 跳过）」的瞬时态，
  // 不能据此清空已有快照，否则一次后台重拉就会把本地优先缓存抹掉。
  if (state.queries.length === 0) return;
  await writeSnapshot({
    buster: getCacheBuster(),
    owner,
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
  options?: { now?: number; maxAge?: number; isCancelled?: () => boolean },
): Promise<boolean> {
  if (!isBrowser()) return false;
  const snapshot = await readSnapshot();
  if (!snapshot) return false;

  // 归属二次校验：指纹不一致（换账号 / 令牌轮换）→ 丢弃，绝不跨账号恢复。
  if (snapshot.owner !== ownerFingerprint()) {
    await clearSnapshot();
    return false;
  }

  const now = options?.now ?? Date.now();
  if (!isSnapshotFresh(snapshot, getCacheBuster(), now, options?.maxAge)) {
    await clearSnapshot();
    return false;
  }

  // 引导超时后（此时应用可能已拉到新数据）不再 hydrate，避免旧快照回灌覆盖新数据。
  if (options?.isCancelled?.()) return false;

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
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeoutMs);
  });

  try {
    await Promise.race([
      restoreSnapshot(queryClient, { isCancelled: () => timedOut }),
      timeout,
    ]);
  } catch (error) {
    console.warn("[cache] 恢复 IndexedDB 快照失败", error);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  attachPersister(queryClient);

  // 清理旧版全局快照键与其它账号残留：只做 best-effort，绝不挡住首帧（慢 IndexedDB
  // 若在这里 await，会拖慢 render，极端时触发 index.html 的软重载循环）。
  void del("snapshot", idbStore).catch(() => undefined);
  void purgeOtherSnapshots().catch(() => undefined);
}

/**
 * 清理其它账号留下的 `snapshot:*` 键。
 *
 * 每个账号的快照按令牌指纹分键，换账号后旧键不会被再次读取，但会一直占 IndexedDB；
 * 这里在新账号启动时顺手删掉。未登录（anon）时**不删**，否则会在登录页把真实账号的缓存清空。
 */
async function purgeOtherSnapshots(): Promise<void> {
  if (ownerFingerprint() === "anon") return;
  const keep = getSnapshotKey();
  const all = await keys(idbStore);
  const stale = all.filter(
    (key): key is string =>
      typeof key === "string" &&
      key.startsWith("snapshot:") &&
      key !== keep,
  );
  await Promise.all(stale.map((key) => del(key, idbStore)));
}
