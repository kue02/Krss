/** 键盘快捷键的公共判定 —— 多处监听共用一套规则，避免各自为政 */

/** 焦点在输入框 / 可编辑区域：一律不抢键 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * 是否是「裸键」——没有 Ctrl/Cmd/Alt。
 * 快捷键一律只认裸键，带修饰键的组合放行给浏览器（刷新、复制、开发者工具…）。
 */
export function isPlainKey(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey;
}
