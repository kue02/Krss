import type { Entry } from "@/types/api";

/**
 * 20-3 / 22-3：**「先别消失」的那些已读条目要在列表刷新后继续留着**。
 *
 * 20-3 做的是「标成已读后不立刻摘掉，等离开这个列表（`resetKey` 变）再摘」
 * （`useScrollMarkRead` 的 `deferRemoval`）—— 那部分只挡住了「摘除」这一条路。
 * 但列表内容来自 react-query 的 `["entries"]` 查询，**任何一次重拉都会把已读条目换掉**：
 * 自动刷新跑完（`useRefreshStatus` 变更 `lastRefreshedAt` → `invalidateQueries(["entries"])`）、
 * 手动点刷新、窗口重新聚焦（默认 `refetchOnWindowFocus`）、>30s 陈旧后的重挂载……
 * 重拉回来的「只看未读」分页里没有这些条目，它们就整批从 DOM 里消失、列表往上顶 ——
 * 用户看到的就是「这个功能失效了」。真机量：未读列表滚 6400px（100 条，0 条当场消失），
 * 触发一次刷新后重拉 → **100 条里消失 46 条**、scrollHeight 13613 → 13431。
 *
 * 办法：标已读、并且要「先别摘」的那一刻，把条目对象和它当时的**下标**记在这里；
 * 渲染前把「服务端这次没返回、但我们记着」的条目按下标插回去 ——
 * 只要没离开这个列表，看到的顺序和之前一模一样。离开列表时（`resetKey` 变）
 * 由 `useScrollMarkRead` 清空这里并真正从缓存里摘掉，这就是用户要的语义。
 *
 * 为什么放模块级：`useScrollMarkRead` 知道「哪些 id 推迟摘除」，`EntryList` 才知道
 * 「渲染哪些条目」，两边隔着一个 hook 边界。这里同 `scroll-key.ts` 的
 * `entryListScrollPositions` 一样用模块级存储 —— 同一时刻只有一个条目列表在用，
 * 离开列表时清空，不需要按 key 分桶。
 */
interface DeferredEntry {
  entry: Entry;
  /** 记录时它在渲染列表里的下标（重拉丢条目后按下标插回原位） */
  index: number;
}

const deferredEntries = new Map<string, DeferredEntry>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** 记下「这条已读但先别摘」：`entry` 传已读态的那份（列表上要显示成已读） */
export function deferEntryRemoval(
  id: string,
  entry: Entry,
  index: number,
): void {
  deferredEntries.set(id, { entry, index });
  emit();
}

/** 离开这个列表时清空（配合把 id 从缓存里摘掉） */
export function clearDeferredRemovals(): void {
  if (deferredEntries.size === 0) return;
  deferredEntries.clear();
  emit();
}

export function hasDeferredRemovals(): boolean {
  return deferredEntries.size > 0;
}

/** 已记下的 id（测试与调试用） */
export function deferredRemovalIds(): string[] {
  return [...deferredEntries.keys()];
}

/**
 * 把「这次查询没返回、但记着要留着」的条目按下标插回列表。
 * 没有任何缺失时**原样返回**（保持引用不变，免得白触发一轮渲染）。
 */
export function mergeDeferredRemovals(entries: Entry[]): Entry[] {
  if (deferredEntries.size === 0) return entries;

  const present = new Set(entries.map((entry) => entry.id));
  const missing: DeferredEntry[] = [];
  for (const [id, item] of deferredEntries) {
    if (!present.has(id)) missing.push(item);
  }
  if (missing.length === 0) return entries;

  missing.sort((a, b) => a.index - b.index);
  const merged = entries.slice();
  for (const item of missing) {
    const at = Math.min(Math.max(item.index, 0), merged.length);
    merged.splice(at, 0, item.entry);
  }
  return merged;
}

export function subscribeDeferredRemovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDeferredRemovalsVersion(): number {
  return version;
}

/** 测试用：清掉模块级状态 */
export function resetDeferredRemovals(): void {
  deferredEntries.clear();
  listeners.clear();
  version = 0;
}
