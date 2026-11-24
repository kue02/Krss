import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const BLOCK_BACKGROUND_SCROLL_OPTIONS = {
  capture: true,
  passive: false,
} as const;

/**
 * 动效参数与 HeroUI v3 Drawer 的左抽屉完全对齐（`@heroui/styles` 的 drawer.css：
 * `.drawer__dialog { transition: translate 250ms cubic-bezier(0.32,0.72,0,1) }`，
 * 退出 200ms），保证侧栏和站内其它 Drawer 的滑出手感一致。
 *
 * 为什么不用 HeroUI v3 的 Drawer 外壳（两处都是源码层面的硬约束，不是取舍偏好）：
 * 1. `react-aria-components/dist/private/Modal.js` 的 ModalOverlay 在关闭态直接
 *    `if (!state.isOpen && !isExiting) return null;` —— Drawer 的子节点只在打开期间存在，
 *    没法「常驻/预热挂载」；而打开瞬间挂载整个 Sidebar（实测约 155 节点）正是长任务来源。
 * 2. `@heroui/react/dist/components/drawer/drawer.js` 的 useDrawerDrag 只从
 *    Header/Footer/Handle 起手，`target.closest("input, textarea, button, [role='button'],
 *    select, a, [data-slot='drawer-body']")` 直接 return —— 覆盖不了侧栏原来的整面侧滑关闭。
 * 因此这里保留自写容器，但把「常驻挂载 + 纯 CSS transform 过渡 + 指针手势」补齐，
 * 动效参数与阈值全部对齐 Drawer，观感/手感与站内其它抽屉一致。
 */
const SLIDE_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const ENTER_DURATION_MS = 250;
const EXIT_DURATION_MS = 200;
const SNAP_BACK_DURATION_MS = 300;

/** 侧滑关闭的起手阈值，与 HeroUI Drawer 的 useDrawerDrag 一致（8px） */
const DRAG_START_THRESHOLD_PX = 8;
/** 松手判定：位移 > 面板宽度的 30%（同 HeroUI Drawer 的 DISMISS_FRACTION），
 *  太窄的面板（或量不到宽度时）退化为固定 56px，避免一点点抖动就关掉侧栏 */
const DISMISS_FRACTION = 0.3;
const DISMISS_MIN_DISTANCE_PX = 56;
/** 快速甩动判定（px/ms），同 HeroUI Drawer 的 VELOCITY_THRESHOLD */
const DISMISS_VELOCITY_PX_PER_MS = 0.5;

interface PointerDrag {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastAt: number;
  velocity: number;
  /** 已越过横向阈值、开始驱动面板；为 false 时松手只当点击 */
  dragging: boolean;
}

function preparePanel(panel: HTMLDivElement | null) {
  if (!panel) return null;
  // 拖拽期间禁用过渡，让面板严格跟手
  panel.style.transition = "none";
  return panel;
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export function Sheet({ open, onOpenChange, children }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PointerDrag | null>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    const preventBackgroundScroll = (event: TouchEvent | WheelEvent) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener(
      "touchmove",
      preventBackgroundScroll,
      BLOCK_BACKGROUND_SCROLL_OPTIONS,
    );
    document.addEventListener(
      "wheel",
      preventBackgroundScroll,
      BLOCK_BACKGROUND_SCROLL_OPTIONS,
    );

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener(
        "touchmove",
        preventBackgroundScroll,
        BLOCK_BACKGROUND_SCROLL_OPTIONS,
      );
      document.removeEventListener(
        "wheel",
        preventBackgroundScroll,
        BLOCK_BACKGROUND_SCROLL_OPTIONS,
      );
    };
  }, [open, onOpenChange]);

  // 打开后把焦点交给面板（不做背景焦点陷阱，保持与旧版一致），
  // 也不在关闭时回焦：移动端侧栏里点「设置」会先关侧栏再开弹窗，
  // 回焦会从刚打开的弹窗手里抢走焦点（2026-09-20 同类问题）。
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    panel.focus({ preventScroll: true });
  }, [open]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!open || !event.isPrimary || event.button !== 0) return;
    const target = event.target;
    // 允许内部横向滚动区（如标签行）声明「别把横滑当成关侧栏」
    if (target instanceof Element && target.closest("[data-sheet-no-drag]")) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastAt: performance.now(),
      velocity: 0,
      dragging: false,
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (!drag.dragging) {
      // 竖向意图优先：交还原生滚动（面板本身是 touch-pan-y）
      if (
        Math.abs(dy) > DRAG_START_THRESHOLD_PX &&
        Math.abs(dy) >= Math.abs(dx)
      ) {
        dragRef.current = null;
        return;
      }
      // 只认向左的起手（向右没有可去的地方），且横向意图必须压过竖向
      if (dx > -DRAG_START_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) {
        return;
      }
      drag.dragging = true;
      const panel = preparePanel(panelRef.current);
      if (panel) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // 合成环境（测试）里指针捕获不可用，不影响后续 pointermove
        }
      }
    }

    const now = performance.now();
    const elapsed = now - drag.lastAt;
    if (elapsed > 0) {
      // 只取最后一段速度：快速甩动时比全程平均更灵敏
      drag.velocity = (event.clientX - drag.lastX) / elapsed;
      drag.lastX = event.clientX;
      drag.lastAt = now;
    }

    const panel = panelRef.current;
    if (panel) {
      // 只允许向左拖（右滑没有意义，也不该把面板推进屏幕）
      panel.style.transform = `translateX(${Math.min(0, dx)}px)`;
    }
  };

  const finishDrag = (
    event: React.PointerEvent<HTMLDivElement>,
    canceled: boolean,
  ) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (!drag.dragging) return;

    const panel = panelRef.current;
    const width = panel?.offsetWidth ?? 0;
    const distance = Math.max(0, drag.startX - event.clientX);
    const elapsed = performance.now() - drag.lastAt;
    const velocity =
      elapsed > 0
        ? (event.clientX - drag.lastX) / elapsed
        : drag.velocity;
    const dismiss =
      !canceled &&
      (distance >= Math.max(DISMISS_MIN_DISTANCE_PX, width * DISMISS_FRACTION) ||
        velocity <= -DISMISS_VELOCITY_PX_PER_MS);

    if (panel) {
      if (dismiss) {
        // 先落到关闭位，再通知父级：CSS 过渡从手指停下的位置继续滑出，
        // 父级重渲染写入的是同一组值，不会二次跳动。
        panel.style.transition = `transform ${EXIT_DURATION_MS}ms ${SLIDE_EASE}`;
        panel.style.transform = "translateX(-100%)";
      } else {
        panel.style.transition = `transform ${SNAP_BACK_DURATION_MS}ms ${SLIDE_EASE}`;
        panel.style.transform = "translateX(0px)";
      }
    }

    if (dismiss) {
      onOpenChange(false);
    }
  };

  return (
    <div data-slot="sheet" data-state={open ? "open" : "closed"} className="contents">
      {/*
        遮罩：常驻挂载，只切 opacity / visibility。
        visibility 带 200ms 延迟，让关闭动画期间遮罩仍挡住点击（避免滑出途中误触到列表）；
        稳态下 hidden 不参与命中测试，也不吃触摸。
      */}
      <div
        data-slot="sheet-overlay"
        data-state={open ? "open" : "closed"}
        aria-hidden="true"
        onClick={() => onOpenChange(false)}
        className={cn(
          "fixed z-50 bg-black/50 touch-none overscroll-none",
          // Extend to cover safe area (notch/home indicator)
          "top-[calc(-1*env(safe-area-inset-top,0px))]",
          "bottom-[calc(-1*env(safe-area-inset-bottom,0px))]",
          "left-[calc(-1*env(safe-area-inset-left,0px))]",
          "right-[calc(-1*env(safe-area-inset-right,0px))]",
        )}
        style={{
          opacity: open ? 1 : 0,
          visibility: open ? "visible" : "hidden",
          transition: open
            ? `opacity ${ENTER_DURATION_MS}ms ${SLIDE_EASE}, visibility 0s linear 0s`
            : `opacity ${EXIT_DURATION_MS}ms ${SLIDE_EASE}, visibility 0s linear ${EXIT_DURATION_MS}ms`,
        }}
      />

      {/*
        面板：常驻挂载（首次移动端渲染即挂），开关只改 transform / class，
        动画全部交给 CSS 合成层，打开时没有 JS 逐帧驱动、也没有 155 节点的挂载长任务。
        关闭态停在屏幕外（translateX(-100%)），inert + aria-hidden 让内容不参与交互与朗读。
      */}
      <div
        ref={panelRef}
        data-slot="sheet-content"
        data-state={open ? "open" : "closed"}
        aria-hidden={open ? undefined : true}
        inert={!open}
        tabIndex={-1}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishDrag(event, false)}
        onPointerCancel={(event) => finishDrag(event, true)}
        className={cn(
          // 移动端抽屉：比旧版 280px 更宽一点（小屏封顶 86vw，避免贴边），
          // 右侧 24px 圆角 + 更深的带偏移投影，让抽屉像"浮起的一层"，而不是硬切一条边。
          "fixed inset-y-0 left-0 z-50 bg-sidebar overflow-hidden",
          "w-[min(320px,86vw)] rounded-r-[24px]",
          "shadow-[0_24px_64px_-16px_rgba(0,0,0,0.38)]",
          "safe-area-top",
          "touch-pan-y overscroll-y-contain",
          // will-change 只给这块会动的面板，且常驻：合成层在打开前就建好，
          // 打开时不再付建层的钱（投影也随之只栅格化一次）。
          "will-change-transform",
        )}
        style={{
          // 用 inline transform 而不是 Tailwind 的 translate-*：拖拽要逐帧改 transform，
          // 和 translate 工具类混用会被各自的 transform 组装规则互相覆盖。
          transform: open ? "translateX(0px)" : "translateX(-100%)",
          transition: `transform ${
            open ? ENTER_DURATION_MS : EXIT_DURATION_MS
          }ms ${SLIDE_EASE}`,
        }}
      >
        {children}
      </div>
    </div>
  );
}