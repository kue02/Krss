import { useEffect, useRef, useSyncExternalStore } from "react";

/** 空快照也必须是**同一个**对象，否则 SSR/首次渲染那条路同样会无限循环 */
const EMPTY_SNAPSHOT: never[] = [];

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

/**
 * ⚠️ `useSyncExternalStore` 要求 `getSnapshot()` **返回缓存对象**：
 * 如果每次调用都 `Array.from(entries.values())` 造一个新数组，React 会认为「快照每次都变了」，
 * 于是无限重渲染 —— 表现是**整个页面白屏**（我第一版就是这么写坏的，单测还查不出来，
 * 因为测试没渲染消费这个 store 的组件）。
 * 所以：任何变更后重建这一份缓存，快照只读它。
 */
let snapshot: DirtyEntry[] = [];
let lastSignature = "";

function signature(list: DirtyEntry[]): string {
  return list.map((entry) => `${entry.label}:${entry.save ? 1 : 0}`).join("|");
}

function rebuild(): void {
  const next = Array.from(entries.values());
  const nextSignature = signature(next);
  /**
   * 内容没变就**保持同一份快照对象**。
   * 换个新数组也算「快照变了」→ 消费端重渲染 → 子页 effect 又登记一次 → 又是新数组……
   * 实测就是这么转成 `Maximum update depth exceeded` 把整页搞白的。
   */
  if (nextSignature === lastSignature) return;
  lastSignature = nextSignature;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** 登记 / 注销（传 null 注销）。切页或关闭时会读这份表。 */
export function registerSettingsDirty(key: string, entry: DirtyEntry | null): void {
  if (entry) entries.set(key, entry);
  else entries.delete(key);
  rebuild();
}

export function subscribeSettingsDirty(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前所有「有未保存改动」的页（响应式，给弹窗用） */
export function useDirtySettings(): DirtyEntry[] {
  return useSyncExternalStore(
    subscribeSettingsDirty,
    () => snapshot,
    () => EMPTY_SNAPSHOT,
  );
}

/** 命令式读取（在事件回调里用，避免闭包拿到旧值） */
/**
 * 命令式读取给事件回调用 —— 这里必须**现读**，不能返回渲染用的缓存快照：
 * 快照里存的是登记那一刻的 `save` 闭包，可能已经捕获了旧的草稿值。
 */
export function getDirtySettings(): DirtyEntry[] {
  return Array.from(entries.values());
}

export function clearDirtySettings(): void {
  if (entries.size === 0) return;
  entries.clear();
  rebuild();
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
  /** `save` 每次渲染都是新箭头函数，直接进 deps 会让这个 effect 每次都跑（登记 → 通知 → 再登记） */
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => {
    registerSettingsDirty(key, dirty ? { label, save: () => saveRef.current?.() } : null);
  }, [key, dirty, label]);
  useEffect(() => () => registerSettingsDirty(key, null), [key]);
}
