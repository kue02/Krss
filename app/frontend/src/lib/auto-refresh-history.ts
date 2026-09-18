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
 * 不是设置；同步过去会让两台设备互相污染。这里只做了键名迁移（gist-* → krss-*）。
 */
export interface AutoRefreshRecord {
  /** 这一轮结束时间（后端 lastRefreshedAt） */
  at: string;
  newCount: number;
  updatedCount: number;
  failedCount: number;
  results: RefreshFeedResult[];
}

const STORAGE_SPEC = LS_KEYS.autoRefreshHistory;
const LIMIT = 20;
const EVENT = "gist-auto-refresh-history-changed";

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
  const next = [record, ...loadAutoRefreshHistory()].slice(0, LIMIT);
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
