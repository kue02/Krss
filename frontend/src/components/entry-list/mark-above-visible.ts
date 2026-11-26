import type { Entry } from "@/types/api";

/**
 * 收集「从列表顶部到当前可视区最后一条」范围内的未读条目 id。
 *
 * `lastVisibleIndex` = 当前屏幕里最后一条（顶边还没越过视口底部）的绝对下标，含。
 * 为什么不是「屏幕之前的那些」：需求是「从当前可视区域开始往上标」——即
 * **整屏 + 它上面的**都要标（用户原话：「整屏可视区的基础上往上标」）。
 * 所以范围是 entries[0 .. lastVisibleIndex]，滤掉已读。
 *
 * 抽成纯函数以便单测这段「切片 + 过滤」语义：有未读 → 返回这些 id；
 * 范围内没有未读 → 返回空数组（调用方据此弹 toast，而不是静默返回）。
 */
export function collectUnreadIdsUpToVisible(
  entries: readonly Entry[],
  lastVisibleIndex: number,
): string[] {
  if (lastVisibleIndex < 0) return [];
  const boundary = Math.min(lastVisibleIndex + 1, entries.length);
  const ids: string[] = [];
  for (let i = 0; i < boundary; i += 1) {
    const entry = entries[i];
    if (entry && !entry.read) ids.push(entry.id);
  }
  return ids;
}
