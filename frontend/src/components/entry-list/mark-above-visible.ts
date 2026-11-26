import type { Entry } from "@/types/api";

/**
 * 收集「可视区域以上」的未读条目 id。
 *
 * firstVisibleIndex = 第一个底边仍落在视口内的行（即其上方已滚出屏幕的行数），
 * 由列表滚动测量 effect 维护。取 entries 的前 firstVisibleIndex 条、滤掉已读，
 * 即本次「可视区域以上标为已读」应批量标记的条目。
 *
 * 抽成纯函数以便单测「切片 + 过滤」这段语义：有未读 → 只返回上方的未读 id；
 * 上方没有未读 → 返回空数组（调用方据此弹 toast，而不是静默返回）。
 */
export function collectUnreadIdsAboveVisible(
  entries: readonly Entry[],
  firstVisibleIndex: number,
): string[] {
  if (firstVisibleIndex <= 0) return [];
  const visibleBoundary = Math.min(firstVisibleIndex, entries.length);
  const ids: string[] = [];
  for (let i = 0; i < visibleBoundary; i += 1) {
    const entry = entries[i];
    if (entry && !entry.read) ids.push(entry.id);
  }
  return ids;
}
