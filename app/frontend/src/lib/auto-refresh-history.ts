import type { RefreshFeedResult } from "@/api";

/**
 * 自动（定时）刷新历史 —— 用户 12-17：定时刷新不再弹结果框，改成设置里的一份历史。
 * 每条可下拉看逐订阅详情（HeroUI Disclosure）。
 *
 * 存 localStorage：这是「给我自己看最近几次自动刷新跑了什么」的轻量记录，
 * 不值得为它加后端表；上限 20 条，避免无限增长。
 */
export interface AutoRefreshRecord {
  /** 这一轮结束时间（后端 lastRefreshedAt） */
  at: string;
  newCount: number;
  updatedCount: number;
  failedCount: number;
  results: RefreshFeedResult[];
}

const STORAGE_KEY = "gist-auto-refresh-history";
const LIMIT = 20;
const EVENT = "gist-auto-refresh-history-changed";

export function loadAutoRefreshHistory(): AutoRefreshRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存不下（配额）就算了：历史是锦上添花，不能因此影响刷新本身
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function clearAutoRefreshHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** 订阅历史变化（同标签页靠自定义事件，跨标签页靠 storage 事件） */
export function subscribeAutoRefreshHistory(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
