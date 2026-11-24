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

export function useDraggableDialog(active = true) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  /**
   * 夹紧的入口，由下面的 effect 每次挂载时填好。
   *
   * 单独留一个 ref 是因为**把手自己的 ref 回调是最早能确定「可以量了」的时刻**：
   * 弹窗与把手在同一提交里挂上，但 effect 的执行顺序不保证量得到把手
   * （实测重开时 effect 里 `handleRef.current` 还是 null，`measureHandle()` 返回 null，
   * 夹紧就整个跳过、之后也不会再跑一次）。把手一挂上就主动叫一次，稳妥。
   */
  const scheduleReclampRef = useRef<() => void>(() => {});
  /**
   * 弹窗是**后挂载**的（`open` 才渲染 `DialogContent`），对象 ref 变化本身不会触发 effect，
   * 所以两个 ref 都用回调式：节点一挂上就叫一次夹紧（`scheduleReclampRef` 由下面的
   * effect 填好；首次挂载时 effect 在同一提交里随后就会跑，那次也会夹）。
   *
   * 注意**不要在回调 ref 里 setState**：那是在提交阶段插一次更新，而 Radix 组件向下传递的
   * 组合 ref 在每次提交时本就会 detach/attach 一遍（实测父组件重渲染两次，回调 ref 被
   * 调用 9 次），两边叠加成无限循环（实测 `Maximum depth exceeded`，整页白屏）。
   *
   * 这里不再做「节点是否变化」的判断：detach 时拿到的是 `null`、attach 时是元素，中间
   * 必经 `null`，所以任何「变了才排队」的写法都恒为真，是自欺欺人的优化（复审实测：
   * 在真实 Radix 时序下加不加这层判断，每次提交排出的 rAF 次数都是 1）。真正的止损在
   * `reclamp` 里 —— 位移不变就直接 return，不 setState。
   */
  const dialogRef = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
    if (node) scheduleReclampRef.current();
  }, []);
  const handleCallbackRef = useCallback((node: HTMLDivElement | null) => {
    handleRef.current = node;
    if (node) scheduleReclampRef.current();
  }, []);

  /**
   * 用户 11-24 拍板：**不需要记住位置** —— 每次打开都从正中开始（会话内也不再沿用上次）。
   * 所以位置只活在「这一次打开」里：`desiredRef` 是用户这次摆到的位置（视口变化时按它重新夹紧），
   * 关掉就丢，下次 `active` 变 true 时清回 (0, 0)。
   */
  const desiredRef = useRef<DragOffset>({ x: 0, y: 0 });
  const [offset, setOffset] = useState<DragOffset>({ x: 0, y: 0 });
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

  /**
   * 量「把手没有位移时」的视口矩形。
   *
   * 不能直接 `handleRect - offsetRef.current`：`DialogContent` 带 `duration-200` 的
   * `transform` 过渡，刚写完 transform 的那一帧 rect 还在动画中间，减出来的基准框是错的，
   * 夹一次只挪一点、要多夹几次才收敛（实测缩小视口后 2s 还停在视口外）。
   * 也不能「临时把 transform 归零再量」—— 归零后把 `transition` 还原的那次样式重算，
   * 会按新值起一段 200ms 过渡，窗口反而开始慢慢滑（实测 computed transform 停在中间值）。
   *
   * 开窗动画（`zoom-in-95`）更麻烦：它写的也是 `transform`，会盖掉拖动写的内联值，
   * 此时 `getComputedStyle(node).transform` 是 `matrix3d(0.95, …, -475, -384, …)`，
   * 拿它当位移会算出荒唐基准（实测重开时 handle.left 量成 -1202，夹出 1107px 的位移）。
   *
   * 所以完全不看 transform：弹窗是 `left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`
   * 居中定位的，**无位移时的位置可以直接由布局盒算出**：
   * `left = (vw - offsetWidth) / 2`，`top = (vh - offsetHeight) / 2`；
   * 再把把手相对弹窗的偏移按当前缩放比（`rect.width / offsetWidth`）折回布局坐标，
   * 动画中的中间帧也能算准，且完全不碰元素样式。
   */
  const measureHandle = useCallback((): DialogBox | null => {
    const node = nodeRef.current;
    const target = handleRef.current;
    if (!node || !target) return null;
    const nodeRect = node.getBoundingClientRect();
    const handleRect = target.getBoundingClientRect();
    const layoutWidth = node.offsetWidth;
    const layoutHeight = node.offsetHeight;
    if (!layoutWidth || !layoutHeight || !handleRect.width || !handleRect.height) return null;
    const scaleX = nodeRect.width ? nodeRect.width / layoutWidth : 1;
    const scaleY = nodeRect.height ? nodeRect.height / layoutHeight : 1;
    if (!scaleX || !scaleY) return null;
    return {
      left:
        (window.innerWidth - layoutWidth) / 2 +
        (handleRect.left - nodeRect.left) / scaleX,
      top:
        (window.innerHeight - layoutHeight) / 2 +
        (handleRect.top - nodeRect.top) / scaleY,
      width: handleRect.width / scaleX,
      height: handleRect.height / scaleY,
    };
  }, []);

  const apply = useCallback((next: DragOffset) => {
    offsetRef.current = next;
    const node = nodeRef.current;
    if (node) node.style.transform = dragTransform(next);
  }, []);

  /**
   * 每次打开（`active` 由 false 变 true）把位置清回正中 —— 用户不需要记住位置。
   * 与 `active` 之外的其它 state 无关，所以只在 `active` 变化时跑一次。
   */
  useEffect(() => {
    if (!active) return;
    desiredRef.current = { x: 0, y: 0 };
    offsetRef.current = { x: 0, y: 0 };
    const node = nodeRef.current;
    if (node) node.style.transform = dragTransform({ x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 开窗重置位置，与 setActiveTab 同一类
    setOffset({ x: 0, y: 0 });
  }, [active]);

  /**
   * 尺寸变化（窗口从最大化还原、开 DevTools、换设备模拟）后，原来合法的位移可能把把手
   * 推到视口外，窗口就再也抓不回来 —— 按当前视口重新夹一次。三件事都走同一个 `reclamp`：
   *
   * 1. **挂载时先夹一次**：记下的位置可能来自更大的视口。不夹的话表现是「重开后窗口
   *    完全在屏幕外，抓不到把手也点不到 X，只能刷新页面」（审查 M1 实测：1600×986 拖到
   *    右下 → 关 → 视口缩到 1100×760 → 重开，把手与 X 都不可见）。
   * 2. **`resize` 事件不够**：事件里 `innerWidth/innerHeight` 已经是新值，但 `max-h-[90vh]`
   *    要等 CSS 重算，实测滞后约 1.5s（887px → 630px），事件里读到的还是旧 rect，
   *    夹完等于没夹，而之后不会再有一次 resize（审查 M2）。所以改用 `ResizeObserver`
   *    盯弹窗自身的盒子 —— 它变了就说明 `max-h` 重算完了。
   * 3. 夹紧**不写回** `desiredRef`：那是用户自己摆的位置，视口暂时变小不该把它改掉
   *    （审查 m4 实测被累积改写成 `translate(-478px, 163px)`）；下次视口变大还会自动回到原处。
   */
  useEffect(() => {
    let frame = 0;

    const reclamp = () => {
      if (!active || state.current.dragging) return;
      // 节点可能还没挂上（Radix `Presence` 会把挂载推迟到下一次提交），
      // 这里不提前 return 出 effect，只让这一帧空转 —— 见下面 `scheduleReclampRef`。
      if (!nodeRef.current) return;
      const handle = measureHandle();
      if (!handle) return;
      const current = offsetRef.current;
      /*
       * 夹的是**用户这次摆到的位置**（`desiredRef`），不是当前生效的位移 ——
       * 这样视口缩小时窗口被拉回可视范围，视口再变大时又自动回到用户摆的地方；
       * 若夹的是当前位移，被拉回一次就永久丢掉了原位置（只能重新拖）。
       */
      const next = clampDragOffset(
        desiredRef.current,
        handle,
        { width: window.innerWidth, height: window.innerHeight },
      );
      if (next.x === current.x && next.y === current.y) return;
      setOffset(next);
      apply(next);
    };

    // jsdom（单测）没有 ResizeObserver，退化成只靠 resize 事件
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => scheduleReclamp());
    /*
     * 观察对象要等节点挂上才有：这个 effect 跑的时候 `Presence` 还没把弹窗挂进 DOM，
     * 那时 `nodeRef.current` 是 null。若在这里就 observe(null)，之后也不会再 observe，
     * `max-h-[90vh]` 的重算就没人通知（实测缩小视口后 y 方向一直不夹）。
     * 所以每次夹紧前顺手确认一遍观察对象。
     */
    let observed: Element | null = null;
    const ensureObserved = () => {
      const node = nodeRef.current;
      if (!observer || !node || node === observed) return;
      if (observed) observer.unobserve(observed);
      observer.observe(node);
      observed = node;
    };

    const scheduleReclamp = () => {
      ensureObserved();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        reclamp();
        // 留一帧余量：`max-h` 的重算偶尔比事件晚一帧
        frame = requestAnimationFrame(reclamp);
      });
    };

    /*
     * 这个 effect 只随 `active` 变化重跑，而弹窗节点出现得更晚：Radix `Presence` 是在
     * 自己的 layout effect 里 setState 才把内容挂上的，所以「`active` 变 true 的那次提交」
     * 里 `nodeRef.current` 还是 null，之后再没有 effect 会跑 —— 实测重开时夹紧整个跳过。
     * 因此把 `scheduleReclamp` 交给 ref，由 `dialogRef`/`handleRef` 两个回调 ref 在节点
     * 挂上的那一刻直接叫一次；这里即便没节点也照常注册监听。
     */
    scheduleReclampRef.current = scheduleReclamp;

    scheduleReclamp();
    window.addEventListener("resize", scheduleReclamp);
    /*
     * 开窗动画（`zoom-in-95`）是 transform，不触发 ResizeObserver，
     * 动画期间量到的 rect 是缩放中的（95%），夹出来的边界差几像素。
     * 动画 200ms，结束后再夹一次就准了。
     */
    const settle = window.setTimeout(scheduleReclamp, 260);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      window.removeEventListener("resize", scheduleReclamp);
      observer?.disconnect();
      scheduleReclampRef.current = () => {};
    };
  }, [active, apply, measureHandle]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest(INTERACTIVE_SELECTOR)) return;
      const node = nodeRef.current;
      if (!node) return;

      // 记录把手「无位移」时的位置（量法见 measureHandle：开窗动画期间 rect 不可靠；
      // 用户能按下标题栏说明动画早已结束，这里放行未 settled 的情况用位移反算兜底）
      const current = offsetRef.current;
      const handle = measureHandle();
      if (!handle) return;
      state.current.handle = handle;
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
    [measureHandle],
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
      desiredRef.current = final;
      const node = nodeRef.current;
      if (node) node.style.transition = "";
      setOffset(final);
      apply(final);
    },
    [apply],
  );

  return {
    /** 挂到要移动的那个元素（Radix `DialogContent`）上 —— 节点出现时触发一次挂载夹紧 */
    dialogRef,
    /** 同一个节点的对象 ref（给需要读节点的其他 hook 用，例如 Tab 出窗） */
    dialogNodeRef: nodeRef,
    /**
     * 挂到拖动把手（窗口标题栏）上 —— 视口变化时按它重新夹紧。
     * 用回调 ref 而不是对象 ref：把手挂上那一刻是最早能确定「量得到了」的时刻。
     */
    handleRef: handleCallbackRef,
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
