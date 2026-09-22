import { useSyncExternalStore } from "react";

/**
 * 极小的全局提示条（复制成功、刷新发起之类的即时反馈）。
 *
 * 项目里原本没有 toast，这里只做最小可用版本：模块级 store + useSyncExternalStore，
 * 一条消息自动消失，不引入新依赖。
 */
export interface Toast {
  id: number;
  message: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const DURATION_MS = 1800;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return toasts;
}

export function showToast(message: string, durationMs = DURATION_MS): void {
  const id = nextId++;
  toasts = [...toasts, { id, message }];
  emit();

  const timer = setTimeout(() => dismissToast(id), durationMs);
  timers.set(id, timer);
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 复制到剪贴板并给出统一反馈（失败也会提示，不留静默失败） */
export async function copyToClipboard(
  text: string,
  successMessage: string,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
    return true;
  } catch {
    showToast("复制失败，请手动复制");
    return false;
  }
}
