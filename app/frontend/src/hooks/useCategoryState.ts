import { useCallback, useMemo, useSyncExternalStore } from "react";
import { LS_KEYS, readLocalValue, writeLocalValue } from "@/lib/settings-storage";
import { registerSettingsGroup, scheduleSettingsFlush } from "@/lib/settings-sync";

interface CategoryState {
  [categoryName: string]: boolean;
}

// 本地缓存键名见 LS_KEYS（改名清理后只有 krss-*）
const STORAGE_SPEC = LS_KEYS.categoryState;

function getStoredState(): CategoryState {
  if (typeof window === "undefined") return {};

  const stored = readLocalValue(STORAGE_SPEC);
  if (!stored) return {};

  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: CategoryState = {};
    for (const [name, open] of Object.entries(parsed)) {
      if (typeof open === "boolean") out[name] = open;
    }
    return out;
  } catch {
    return {};
  }
}

let cachedState: CategoryState = getStoredState();
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): CategoryState {
  return cachedState;
}

function persistState(): void {
  writeLocalValue(STORAGE_SPEC, JSON.stringify(cachedState));
}

function setCategoryState(category: string, isOpen: boolean): void {
  setCategoriesState([category], isOpen);
}

/**
 * 一次改多个分类（「全部展开 / 全部收起」）：只写一次、只发一次同步。
 * 旧写法是在循环里挨个调 setCategoryState，10 个分类就是 10 次落盘 + 10 次通知。
 */
function setCategoriesState(categories: string[], isOpen: boolean): void {
  if (categories.length === 0) return;

  const next = { ...cachedState };
  for (const category of categories) {
    next[category] = isOpen;
  }
  cachedState = next;

  persistState();
  emitChange();
  scheduleSettingsFlush("ui.sidebar_state");
}

/** 21 批：服务端那份展开态覆盖本地（登录后首次拉取时走） */
export function applyCategoryStateFromServer(state: Record<string, boolean>): void {
  const next: CategoryState = {};
  for (const [name, open] of Object.entries(state)) {
    if (typeof open === "boolean") next[name] = open;
  }

  cachedState = next;
  persistState();
  emitChange();
}

function toggleCategoryState(category: string): void {
  const currentState = cachedState[category] ?? false;
  setCategoryState(category, !currentState);
}

export function useCategoryState(
  category: string,
  defaultOpen = false,
): [boolean, (isOpen: boolean) => void, () => void] {
  const state = useSyncExternalStore(subscribe, getSnapshot, getStoredState);
  const isOpen = state[category] ?? defaultOpen;

  const setOpen = useCallback(
    (open: boolean) => {
      setCategoryState(category, open);
    },
    [category],
  );

  const toggle = useCallback(() => {
    toggleCategoryState(category);
  }, [category]);

  return [isOpen, setOpen, toggle];
}

/** 按分类名读取展开态（默认折叠） */
export function isCategoryOpen(category: string): boolean {
  return cachedState[category] ?? false;
}

/** 按分类名切换展开态（快捷键 x 用；分类状态以「名字」为键） */
export function toggleCategory(category: string): void {
  toggleCategoryState(category);
}

export function useCategoryActions() {
  const setAllCategories = useCallback(
    (categories: string[], isOpen: boolean) => {
      setCategoriesState(categories, isOpen);
    },
    [],
  );

  const expandAll = useCallback(
    (categories: string[]) => {
      setAllCategories(categories, true);
    },
    [setAllCategories],
  );

  const collapseAll = useCallback(
    (categories: string[]) => {
      setAllCategories(categories, false);
    },
    [setAllCategories],
  );

  return { expandAll, collapseAll, setAllCategories };
}

/**
 * 这批分类是否全部展开（订阅式：状态变化会触发重渲染，按钮图标能跟着变）。
 * 键是分类名（与 isCategoryOpen / toggleCategory 一致）。
 */
export function useAllCategoriesOpen(categories: string[]): boolean {
  const state = useSyncExternalStore(subscribe, getSnapshot, getStoredState);
  const key = categories.join("\u0000");

  return useMemo(() => {
    const names = key ? key.split("\u0000") : [];
    return names.length > 0 && names.every((name) => state[name] ?? false);
  }, [key, state]);
}

// ---------- 21 批：注册「侧栏分类展开态」同步组 ----------

registerSettingsGroup({
  key: "ui.sidebar_state",
  read: () => ({ ...cachedState }),
  apply: (value) => applyCategoryStateFromServer(value),
});
