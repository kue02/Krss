import { useSyncExternalStore } from "react";

/**
 * 快捷键帮助弹窗的开关状态。
 *
 * 弹窗挂在 App（全局唯一），但入口有两处：`?` 键（useGlobalHotkeys）
 * 与侧栏账户菜单里的一项。用一个极小的模块级 store 让两边共享状态，
 * 避免把 open 状态在组件树里层层传递。
 */

let open = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export const shortcutsHelp = {
  isOpen: () => open,
  set: (next: boolean) => {
    if (open === next) return;
    open = next;
    emit();
  },
  toggle: () => {
    open = !open;
    emit();
  },
  subscribe: (callback: () => void) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
};

export function useShortcutsHelpOpen(): boolean {
  return useSyncExternalStore(
    shortcutsHelp.subscribe,
    shortcutsHelp.isOpen,
    () => false,
  );
}
