import type { RefreshFeedResult } from "@/api";
import { LS_KEYS, readLocalValue, removeLocalValue, writeLocalValue } from "@/lib/settings-storage";

/**
 * 自动（定时）刷新历史 —— 用户 12-17：定时刷新不再弹结果框，改成设置里的一份历史。
 * 每条可下拉看逐订阅详情（HeroUI Disclosure）。
 *
 * 存 localStorage：这是「给我自己看最近几次自动刷新跑了什么」的轻量记录，
 * 不值得为它加后端表；上限 20 条，避免无限增长。
 *
 * 21 批：**故意不进服务端同步**（用户拍板）—— 这是「本机跑过什么」的运行记录，
 * 不是设置；同步过去会让两台设备互相污染。键名 `krss-*`（改名清理后不留老键兼容）。
 */
export interface AutoRefreshRecord {
  /** 这一轮结束时间（后端 lastRefreshedAt） */
  at: string;
  newCount: number;
  updatedCount: number;
  failedCount: number;
  results: RefreshFeedResult[];
}

/**
 * 展开后按失败原因分组的组（19-3：失败置顶 + 按原因分组 + 可复制 + 可直接重试）。
 * 原因文本就是分组键 —— 同一轮里 N 个源常因同一件事失败（同一个 RSSHub 实例 502、
 * 同一次网络抖动），按「源逐条列」会把这些重复的长错误刷满屏。
 */
export interface RefreshFailureGroup {
  reason: string;
  feeds: RefreshFeedResult[];
}

/** 失败项按原因分组；组内保持后端给的顺序，组间按「组内条数」降序（大片的先看） */
export function groupRefreshFailures(
  results: RefreshFeedResult[],
): RefreshFailureGroup[] {
  const groups = new Map<string, RefreshFeedResult[]>();
  for (const result of results) {
    const reason = result.error?.trim();
    if (!reason) continue;
    const bucket = groups.get(reason);
    if (bucket) bucket.push(result);
    else groups.set(reason, [result]);
  }
  return [...groups.entries()]
    .map(([reason, feeds]) => ({ reason, feeds }))
    .sort(
      (a, b) =>
        b.feeds.length - a.feeds.length || a.reason.localeCompare(b.reason),
    );
}

/** 成功项按更新条数降序（同数按新增降序、再按标题）—— 与草图「成功 · 按更新条数排序」一致 */
export function sortRefreshSuccesses(
  results: RefreshFeedResult[],
): RefreshFeedResult[] {
  return results
    .filter((result) => !result.error)
    .sort(
      (a, b) =>
        b.updated - a.updated ||
        b.new - a.new ||
        a.title.localeCompare(b.title),
    );
}

const STORAGE_SPEC = LS_KEYS.autoRefreshHistory;
/**
 * 固定保留最近 20 次（19-6 已拍板：**不做可配**）。
 * 导出出来是为了让测试把「固定 20」钉死 —— 别再顺手加设置项。
 */
export const AUTO_REFRESH_HISTORY_LIMIT = 20;
const EVENT = "krss-auto-refresh-history-changed";

export function loadAutoRefreshHistory(): AutoRefreshRecord[] {
  try {
    const raw = readLocalValue(STORAGE_SPEC);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AutoRefreshRecord[]) : [];
  } catch {
    return [];
  }
}

export function appendAutoRefreshHistory(record: AutoRefreshRecord): void {
  const next = [record, ...loadAutoRefreshHistory()].slice(
    0,
    AUTO_REFRESH_HISTORY_LIMIT,
  );
  try {
    writeLocalValue(STORAGE_SPEC, JSON.stringify(next));
  } catch {
    // 存不下（配额）就算了：历史是锦上添花，不能因此影响刷新本身
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function clearAutoRefreshHistory(): void {
  try {
    removeLocalValue(STORAGE_SPEC);
  } catch {
    // 同上
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** 订阅历史变化（同标签页靠自定义事件，跨标签页靠 storage 事件） */
export function subscribeAutoRefreshHistory(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_SPEC.key) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
