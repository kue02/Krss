import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * 23-3：把弹窗做成「可拖动的窗口」。
 *
 * 为什么自己写这一小段：**HeroUI v3 的 Modal 没有原生拖动支持** ——
 * 官方 `Modal.Backdrop` 只有 `variant`（opaque / blur / transparent）、`isDismissable`、
 * `isKeyboardDismissDisabled`、`isOpen`/`onOpenChange`、`className`、`UNSTABLE_portalContainer`
 * 这些 prop（https://heroui.com/docs/components/modal 的 API 表），没有位置/拖拽相关项；
 * 组件库内部只有 `Drawer` 带拖动，且那是**单向的拖拽关闭**（`useDrawerDrag`：pointer 事件 +
 * `translate`，阈值 8px / 30% 尺寸 / 速度 0.5px·ms⁻¹ 判定丢弃）。
 *
 * 所以这里照**它同族的那套手势做法**搬：pointerdown/move/up + `setPointerCapture` +
 * 直接写 `transform`（拖动期间不走 React state，避免整个设置面板每帧重渲染）。
 * 差别只有一处 —— 抽屉只允许朝关闭方向拖、拖过头就关；窗口是**双向自由拖动 + 夹在视口内**。
 */

export interface DragOffset {
  x: number;
  y: number;
}

export interface DialogBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 拖到离视口边缘这么近就不许再拖（保证标题栏始终够得着） */
const EDGE_MARGIN = 8;
/** 超过这个位移才算「在拖」，避免手抖把点击变成拖动 */
const DRAG_THRESHOLD = 3;
/** 拖动中不要被这些元素抢走指针（与 HeroUI drawer 的守卫同一份清单） */
const INTERACTIVE_SELECTOR =
  "input, textarea, button, [role='button'], select, a, [data-dialog-drag-ignore]";

/**
 * 位置记在模块级：设置关掉再打开仍在原处（用户诉求是「边看边改」，每次回到正中很烦）。
 * 只在本次会话内有效，刷新页面回到正中。
 */
let rememberedOffset: DragOffset = { x: 0, y: 0 };

/**
 * 把位移夹在视口内（纯函数，单测用）。
 * `box` 是元素**没有位移时**的视口矩形；允许的区间取「左/上不小于 margin」与
 * 「右/下不大于 视口 - margin」的交集；两个端点反了（元素比视口还大）时取较小值，不至于左右乱跳。
 */
export function clampDragOffset(
  offset: DragOffset,
  box: DialogBox,
  viewport: { width: number; height: number },
  margin = EDGE_MARGIN,
): DragOffset {
  const bounds = (start: number, size: number, total: number) => {
    const min = margin - start;
    const max = total - margin - size - start;
    return min <= max ? { min, max } : { min: max, max: min };
  };

  const x = bounds(box.left, box.width, viewport.width);
  const y = bounds(box.top, box.height, viewport.height);

  return {
    x: Math.min(x.max, Math.max(x.min, offset.x)),
    y: Math.min(y.max, Math.max(y.min, offset.y)),
  };
}

/**
 * 位移是**纯偏移**，不含居中那一段：
 * `DialogContent` 的居中用的是 Tailwind v4 的 `translate` 工具类（`-translate-x-1/2 -translate-y-1/2`，
 * 落在 CSS 的 `translate` 属性上），而这里写的是 `transform` 属性 —— 两者是**分开合成**的，
 * 再叠一次 `-50%` 会把窗口整体推到左上角外面（实测 rect 从 309 变 -166，差的正好是 -50%）。
 */
export function dragTransform(offset: DragOffset): string {
  return `translate(${offset.x}px, ${offset.y}px)`;
}

export function useDraggableDialog() {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState<DragOffset>(() => ({ ...rememberedOffset }));
  const state = useRef({
    dragging: false,
    activated: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    startOffset: { x: 0, y: 0 } as DragOffset,
    box: { left: 0, top: 0, width: 0, height: 0 } as DialogBox,
  });

  const apply = useCallback((next: DragOffset) => {
    const node = nodeRef.current;
    if (node) node.style.transform = dragTransform(next);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest(INTERACTIVE_SELECTOR)) return;
      const node = nodeRef.current;
      if (!node) return;

      // 记录「无位移」时的位置：当前 rect 减去已生效的位移
      const rect = node.getBoundingClientRect();
      state.current.box = {
        left: rect.left - offset.x,
        top: rect.top - offset.y,
        width: rect.width,
        height: rect.height,
      };
      state.current.dragging = true;
      state.current.activated = false;
      state.current.pointerId = event.pointerId;
      state.current.startX = event.clientX;
      state.current.startY = event.clientY;
      state.current.startOffset = { ...offset };
    },
    [offset],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = state.current;
      if (!current.dragging || !nodeRef.current) return;
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;

      if (!current.activated) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        current.activated = true;
        nodeRef.current.style.transition = "none";
        // 指针捕获：拖出标题栏甚至拖出窗口，事件仍回到这里
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      apply(
        clampDragOffset(
          { x: current.startOffset.x + dx, y: current.startOffset.y + dy },
          current.box,
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    },
    [apply],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = state.current;
      if (!current.dragging) return;
      current.dragging = false;
      try {
        event.currentTarget.releasePointerCapture(current.pointerId);
      } catch {
        // 指针已经释放过了
      }
      if (!current.activated) return;
      current.activated = false;

      const node = nodeRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      // rect 是拖动后的真实位置；减掉基准位置即最终位移（已经夹过视口，这里不重复夹）
      const final: DragOffset = {
        x: rect.left - current.box.left,
        y: rect.top - current.box.top,
      };
      rememberedOffset = final;
      node.style.transition = "";
      setOffset(final);
      apply(final);
    },
    [apply],
  );

  return {
    /** 挂到要移动的那个元素（Radix `DialogContent`）上 */
    dialogRef: nodeRef,
    /** 挂到拖动把手（窗口标题栏）上 */
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
    offset,
    /** 直接写进 `style.transform`（拖动期间由 pointermove 逐帧改） */
    transform: dragTransform(offset),
  };
}
