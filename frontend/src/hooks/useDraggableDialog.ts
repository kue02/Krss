import { useCallback, useEffect, useRef, useState } from "react";
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
 * 差别只有一处 —— 抽屉只允许朝关闭方向拖、拖过头就关；窗口是**双向自由拖动**。
 *
 * 1124（用户：「设置页面可以被拖动到窗口外，这样一些设置可以直接看到效果」）：
 * 23-3 那版把整窗夹在视口内，最多挪出几十像素，背后基本露不出来。现在改成
 * **允许整窗移出视口**，只要求「拖动把手」还留一块在视口内（不然窗口就再也抓不回来）。
 * 夹紧按把手算、不按窗口算，是因为把手只在标题栏那一侧：往右拖时露出来的是左栏，
 * 按窗口算的话左栏虽然可见、却抓不到把手。
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

/** 拖出视口后，拖动把手至少留这么宽 / 高在视口内（够抓住，不挡内容） */
const HANDLE_KEEP_X = 96;
const HANDLE_KEEP_Y = 32;
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
 * 把位移夹到「把手还够得着」的范围（纯函数，单测用）。
 *
 * `handle` 是**拖动把手没有位移时**的视口矩形，`viewport` 是视口尺寸。
 * 允许窗口整块移出视口（用户要的就是露背后），但要求：
 *   把手右端 ≥ keepX、把手左端 ≤ 视口宽 - keepX、把手下端 ≥ keepY、把手上端 ≤ 视口高 - keepY。
 * 两个端点反了（把手比视口还大）时交换，不至于左右乱跳。
 */
export function clampDragOffset(
  offset: DragOffset,
  handle: DialogBox,
  viewport: { width: number; height: number },
  keep: { x: number; y: number } = { x: HANDLE_KEEP_X, y: HANDLE_KEEP_Y },
): DragOffset {
  const clamp = (value: number, min: number, max: number) => {
    if (min > max) [min, max] = [max, min];
    return Math.min(max, Math.max(min, value));
  };

  return {
    x: clamp(
      offset.x,
      keep.x - (handle.left + handle.width),
      viewport.width - keep.x - handle.left,
    ),
    y: clamp(
      offset.y,
      keep.y - (handle.top + handle.height),
      viewport.height - keep.y - handle.top,
    ),
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
  const handleRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState<DragOffset>(() => ({ ...rememberedOffset }));
  /** 手势里读的是 ref（pointermove 里不能等 React 渲染） */
  const offsetRef = useRef<DragOffset>(offset);
  const state = useRef({
    dragging: false,
    activated: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    startOffset: { x: 0, y: 0 } as DragOffset,
    handle: { left: 0, top: 0, width: 0, height: 0 } as DialogBox,
    last: { x: 0, y: 0 } as DragOffset,
  });

  const apply = useCallback((next: DragOffset) => {
    offsetRef.current = next;
    const node = nodeRef.current;
    if (node) node.style.transform = dragTransform(next);
  }, []);

  /**
   * 视口变小（窗口从最大化还原、开 DevTools）后，原来合法的位移可能把把手推到视口外，
   * 于是窗口再也抓不回来 —— 尺寸变化时按当前视口再夹一次。
   */
  useEffect(() => {
    const onResize = () => {
      const handle = handleRef.current;
      if (!handle || state.current.dragging) return;
      const rect = handle.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const current = offsetRef.current;
      const next = clampDragOffset(
        current,
        {
          left: rect.left - current.x,
          top: rect.top - current.y,
          width: rect.width,
          height: rect.height,
        },
        { width: window.innerWidth, height: window.innerHeight },
      );
      if (next.x === current.x && next.y === current.y) return;
      rememberedOffset = next;
      setOffset(next);
      apply(next);
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [apply]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest(INTERACTIVE_SELECTOR)) return;
      const node = nodeRef.current;
      if (!node) return;

      // 记录把手「无位移」时的位置：当前 rect 减去已生效的位移
      const current = offsetRef.current;
      const rect = event.currentTarget.getBoundingClientRect();
      state.current.handle = {
        left: rect.left - current.x,
        top: rect.top - current.y,
        width: rect.width,
        height: rect.height,
      };
      state.current.dragging = true;
      state.current.activated = false;
      state.current.pointerId = event.pointerId;
      state.current.startX = event.clientX;
      state.current.startY = event.clientY;
      state.current.startOffset = { ...current };
      state.current.last = { ...current };

      /*
       * 1124：**按下就捕获**，不要等超过阈值再捕获。
       * 阈值那版（23-3）只在 pointermove 里 `setPointerCapture`，可快速拖动时指针
       * 第一帧就已经离开标题栏 —— 那一下 pointermove 派发给的是别的元素，
       * 根本到不了这里，于是永远不激活、永远不捕获，窗口一动不动。
       * 实测：从标题栏往下 40px 拖，只收到 pointerdown，一条 pointermove 都没有。
       */
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 老浏览器 / 指针已释放：退化成普通的元素内拖动
      }
    },
    [],
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

      const next = clampDragOffset(
        { x: current.startOffset.x + dx, y: current.startOffset.y + dy },
        current.handle,
        { width: window.innerWidth, height: window.innerHeight },
      );
      current.last = next;
      apply(next);
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

      // 最后一帧已经夹过视口，直接用，不再按 rect 反算（窗口可能大半在视口外，rect 也不可靠）
      const final = current.last;
      rememberedOffset = final;
      const node = nodeRef.current;
      if (node) node.style.transition = "";
      setOffset(final);
      apply(final);
    },
    [apply],
  );

  return {
    /** 挂到要移动的那个元素（Radix `DialogContent`）上 */
    dialogRef: nodeRef,
    /** 挂到拖动把手（窗口标题栏）上 —— 视口变化时按它重新夹紧 */
    handleRef,
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
