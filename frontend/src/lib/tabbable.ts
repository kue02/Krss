/**
 * 1124：非模态浮窗里让 Tab 能走出窗口。
 *
 * 为什么需要这一小段：Radix 的 `DialogContentImpl` 给 `FocusScope` 传的是
 * `loop: true`（`node_modules/@radix-ui/react-dialog/dist/index.mjs`），
 * `modal={false}` 只把 `trapped` 关掉、**`loop` 仍然是 true** ——
 * `@radix-ui/react-focus-scope/dist/index.mjs` 的 `handleKeyDown` 里
 * `if (!event.shiftKey && focusedElement === last) { event.preventDefault(); if (loop) focus(first) }`，
 * 于是 Tab 到最后一个元素就回到第一个，焦点永远出不了窗口
 * （审查实测：连按 120 次 Tab 仍在「外观 → … → AI」之间打转）。
 * `loop` 是组件库写死的，props 改不了，所以在窗内自己接管边界。
 *
 * 做法：**window 捕获阶段**监听 keydown —— 它比 React 挂在根容器上的合成事件更早，
 * 到这里 `stopPropagation()` 后事件根本不会流到 Radix 的处理器，浏览器默认的 Tab
 * 也不再被它 `preventDefault` 掉。然后我们自己把焦点送到窗外的下一个可 Tab 元素，
 * 不依赖浮层在 DOM 里的先后顺序（`App.tsx` 里设置窗挂在最后，但别的浮层不一定）。
 */

const TABBABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * 沿祖先链判断是否真的可见 —— 只查元素自身不够：`<div style="display:none"><button>` 里
 * 按钮自身的 computed `display` 仍是 `inline-block`（审查 m1 实测），会被当成候选。
 * 真浏览器里对隐藏元素 `focus()` 是 no-op，于是 `moveTabOutOfContainer` 返回 false、
 * Tab 静默失效又退回窗内循环 —— 与 jsdom 里「跳到隐藏元素」是同一个 bug 的两副面孔。
 * 判定口径照 Radix `FocusScope` 的 `isHidden`（`node_modules/@radix-ui/react-focus-scope`）。
 */
function isVisible(element: HTMLElement): boolean {
  let node: HTMLElement | null = element;
  while (node) {
    if (
      node.hidden ||
      node.getAttribute("aria-hidden") === "true" ||
      node.inert === true
    ) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    node = node.parentElement;
  }
  return true;
}

/** 容器内按 DOM 顺序可 Tab 到的元素 */
export function getTabbable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
  ).filter(isVisible);
}

/** 容器外按 DOM 顺序可 Tab 到的元素（Radix 的焦点守卫 span 不算） */
export function getTabbableOutside(container: HTMLElement): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
  ).filter(
    (element) =>
      !container.contains(element) &&
      !element.hasAttribute("data-radix-focus-guard") &&
      isVisible(element),
  );
}

/**
 * Tab / Shift+Tab 到达容器边界时，把焦点交给容器外的下一个元素。
 * 返回 true 表示已经处理（调用方无需再做别的）。
 */
export function moveTabOutOfContainer(
  container: HTMLElement,
  backwards: boolean,
): boolean {
  const inside = getTabbable(container);
  if (inside.length === 0) return false;

  /*
   * **只处理边界那一次**：焦点不在窗内首/尾元素上时交还给浏览器与 Radix 的默认行为。
   * 少了这一步，窗内任何一次 Tab 都会被判定成「已处理」而把焦点扔出窗 —— 打开设置后
   * 按第一次 Tab 就跳到背后页面，窗内的左栏导航与右栏控件全部够不到（审查 B1 实测：
   * 焦点在窗内第一个元素上按 Tab，`activeElement` 直接变成窗外第一个可聚焦元素）。
   * 边界语义与 Radix `FocusScope.handleKeyDown` 一致。
   */
  const active = document.activeElement;
  if (!active || active === container) return false;
  const edge = backwards ? inside[0] : inside[inside.length - 1];
  if (active !== edge) return false;

  const outside = getTabbableOutside(container);
  if (outside.length === 0) return false;

  const target = backwards ? outside[outside.length - 1] : outside[0];
  if (!target) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}
