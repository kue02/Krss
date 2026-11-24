import { useEffect } from "react";
import type { RefObject } from "react";
import { moveTabOutOfContainer } from "@/lib/tabbable";

/**
 * 1124：非模态浮窗（设置）里，Tab / Shift+Tab 到窗口边界时把焦点送到窗外。
 *
 * 背景见 `@/lib/tabbable`：Radix 的 `FocusScope` 写死了 `loop: true`，
 * 非模态只关掉 `trapped`，Tab 仍会在窗内循环。这里在 **window 捕获阶段**截住边界那一次
 * Tab —— 捕获阶段早于 React 挂在根容器上的合成事件，`stopPropagation()` 之后
 * Radix 的 `handleKeyDown` 收不到，浏览器默认的「焦点往后走」也得以保留；
 * 但默认行为会落到 Radix 插在 body 首尾的焦点守卫 span 上，所以再自己把焦点
 * 明确送到窗外第一个（或最后一个）可 Tab 元素。
 */
export function useTabEscapeFromDialog(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const container = containerRef.current;
      if (!container) return;
      if (!container.contains(document.activeElement)) return;

      const handled = moveTabOutOfContainer(container, event.shiftKey);
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [containerRef, enabled]);
}
