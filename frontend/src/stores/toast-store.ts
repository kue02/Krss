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
  // 49-3（用户 2026-10-12）：同一条文案**只留一个**。
  //
  // 背景：自动翻译这类「随状态反复发」的提示会在短时间内被多次触发（实测：打开一条
  // 条目时同一条目被翻译两次，列表快速切换时每条各弹一次），原实现每次都往数组里
  // 追加 ⇒ 屏幕上叠起十几条一模一样的胶囊（用户原话「正在自动翻译弹框太多了」）。
  // 这里改成：已经有一条同文案 → 只把它的倒计时重置，不再新增。
  const existing = toasts.find((toast) => toast.message === message);
  if (existing) {
    const timer = timers.get(existing.id);
    if (timer) clearTimeout(timer);
    timers.set(
      existing.id,
      setTimeout(() => dismissToast(existing.id), durationMs),
    );
    // 位置也重新排到最底（让它看起来是「刚刚又响了一次」，而不是被压在中间）
    toasts = [...toasts.filter((toast) => toast.id !== existing.id), existing];
    emit();
    return;
  }

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

/**
 * 25-1：**非安全上下文**（http + 非 localhost —— 自建 NAS 的常态入口）里浏览器压根不提供
 * `navigator.clipboard`（实测 `http://<NAS>:8080` → `isSecureContext=false`、
 * `typeof navigator.clipboard === "undefined"`），于是复制一律抛 TypeError、功能全废。
 * 退回 `execCommand("copy")` 这条老路：它不看安全上下文，Chromium/Safari/Firefox 仍支持；
 * 写法与 `hooks/useCodeHighlight.ts` 里代码块复制那段保持同一口径（同一类问题一处收口）。
 */
function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // 位置挪到视口外 + 透明，**不能**用 display:none / visibility:hidden —— 那样选不中，execCommand 会返回 false
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  // 借走再还回用户原来的选区，避免顺手清掉别处的高亮
  const selection = document.getSelection();
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied: boolean;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  document.body.removeChild(textarea);
  if (selection && previousRange) {
    selection.removeAllRanges();
    selection.addRange(previousRange);
  }
  return copied;
}

/**
 * 复制到剪贴板并给出统一反馈（失败也会提示，不留静默失败）。
 *
 * 文案由调用点传进来（`t(...)`）：store 层不引 i18n 实例 —— 引了会把 i18n 的初始化
 * 拖进每一个 import 本模块的地方（组件单测里 mock 掉的 `react-i18next` 会当场炸），
 * 也与应用「文案在 UI 层」的分层相反。
 */
export async function copyToClipboard(
  text: string,
  successMessage: string,
  failureMessage = "复制失败，请手动复制",
): Promise<boolean> {
  try {
    // clipboard 断言成可空：非安全上下文里它真的是 undefined，TS 的 DOM 类型没体现这一点
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
    } else if (!copyViaExecCommand(text)) {
      throw new Error("clipboard unavailable");
    }
    showToast(successMessage);
    return true;
  } catch {
    showToast(failureMessage);
    return false;
  }
}
