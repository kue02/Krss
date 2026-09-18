import { useEffect } from "react";
import { useSyncExternalStore } from "react";

/**
 * 12-7：设置项的「未保存」登记表。
 *
 * 用户口径（2026-09-18）：「能即时的（开关/数量）自动保存并提示，需要整体提交的（表单）才提示未保存」。
 * 所以这里只服务**表单型**的页（AI / 网络 / 通知 / RSSHub / 通用里的 UA / 资料）：
 * 它们各自把「我这一页有没有未保存的改动」登记进来，设置弹窗在**切页或关闭**时问一句。
 *
 * 为什么用登记表而不是让弹窗去问每一页：
 * 设置页是「只渲染当前这一页」，弹窗拿不到别的页的状态；而且以后新增设置页不用改弹窗。
 */
export interface DirtyEntry {
  /** 给用户看的页名（用于确认框里的文案） */
  label: string;
  /** 「保存并离开」用；没给就只提供「放弃更改 / 继续编辑」 */
  save?: () => void | Promise<void>;
}

const entries = new Map<string, DirtyEntry>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

/** 登记 / 注销（传 null 注销）。切页或关闭时会读这份表。 */
export function registerSettingsDirty(key: string, entry: DirtyEntry | null): void {
  const had = entries.has(key);
  if (entry) entries.set(key, entry);
  else entries.delete(key);
  if (had !== !!entry) emit();
}

export function subscribeSettingsDirty(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前所有「有未保存改动」的页（响应式，给弹窗用） */
export function useDirtySettings(): DirtyEntry[] {
  return useSyncExternalStore(
    subscribeSettingsDirty,
    () => Array.from(entries.values()),
    () => [],
  );
}

/** 命令式读取（在事件回调里用，避免闭包拿到旧值） */
export function getDirtySettings(): DirtyEntry[] {
  return Array.from(entries.values());
}

export function clearDirtySettings(): void {
  if (entries.size === 0) return;
  entries.clear();
  emit();
}

/**
 * 给表单型设置页用的一行登记：`dirty` 为 true 时登记，false/卸载时注销。
 * `save` 变化不重新登记也没关系（每次都写最新的进去）。
 */
export function useSettingsDirty(
  key: string,
  dirty: boolean,
  label: string,
  save?: () => void | Promise<void>,
): void {
  useEffect(() => {
    registerSettingsDirty(key, dirty ? { label, save } : null);
  }, [key, dirty, label, save]);
  useEffect(() => () => registerSettingsDirty(key, null), [key]);
}
