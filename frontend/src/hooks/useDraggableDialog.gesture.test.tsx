/* eslint-disable react-hooks/refs -- 测试夹具：ref 必须原样交给 hook 才能跑真实手势路径，渲染期不解引用 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useDraggableDialog, resetRememberedOffset } from "./useDraggableDialog";

/**
 * 1124：拖动手势本身的行为（纯函数部分见 `useDraggableDialog.test.ts`）。
 *
 * 这里钉的是审查清单里点名的几处语义：
 * - 按下即 `setPointerCapture`（23-3 那版等超过阈值才捕获，快速拖动永远收不到 pointermove）
 * - `DRAG_THRESHOLD` 分界：阈值内只算点击
 * - 交互元素（按钮/输入框）上的按下不算拖动
 * - 拖出视口后位移保留（不再被夹回窗口内）
 * - 重新挂载时按**当前**视口夹紧（审查 M1：视口缩小后重开，窗口会整块在屏幕外抓不回来）
 */

const BASE_HANDLE = { left: 509, top: 76, width: 750, height: 57 };
/**
 * 弹窗布局盒（`w-[950px] h-[800px]`）。`measureHandle` 不看 transform，而是用
 * `(视口宽 - offsetWidth) / 2` 推出「无位移时的位置」，所以夹具必须同时给出
 * 布局尺寸与 rect —— jsdom 里 `offsetWidth` 恒为 0，只 mock rect 会让它返回 null。
 */
const DIALOG = { width: 950, height: 800 };
/** 把手相对弹窗布局盒的偏移（左栏 200px + 标题栏自身 1px 边框） */
const HANDLE_REL = { left: BASE_HANDLE.left - (1568 - 950) / 2, top: BASE_HANDLE.top - (951 - 800) / 2 };
/** 弹窗布局盒尺寸：`max-h-[90vh]` 会随视口变，测试里可改 */
let layout = { width: DIALOG.width, height: DIALOG.height };

/** 从内联 transform 里读出当前位移（`translate(Xpx, Ypx)`） */
function readOffset(node: HTMLElement | null): { x: number; y: number } {
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(
    node?.style.transform ?? "",
  );
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 };
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    width,
    height,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function Harness() {
  const drag = useDraggableDialog();
  return (
    <div data-testid="dialog" ref={drag.dialogRef} style={{ transform: drag.transform }}>
      <div data-testid="handle" {...drag.handleProps} ref={drag.handleRef}>
        <button data-testid="inner-button" type="button">
          按钮
        </button>
      </div>
    </div>
  );
}

/**
 * jsdom 的 `offsetWidth/offsetHeight` 定义在 `HTMLElement.prototype` 上，
 * `vi.restoreAllMocks()` 不会还原 `Object.defineProperty` 改过的属性描述符 ——
 * 不显式还原的话会泄漏到同进程的其它测试文件。
 */
const ORIGINAL_OFFSET_DESCRIPTORS = {
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
};

/**
 * 模拟 Radix `Presence` 的真实时序：hook 先挂载（此时 effect 已经跑完、rAF 也空转过），
 * 弹窗节点要到之后的某次提交才出现。这时主 effect 的依赖没有变化、不会再跑一次，
 * 唯一的补救路径就是 `dialogRef` / `handleRef` 两个回调 ref。
 */
function LateMountHarness({ show }: { show: boolean }) {
  const drag = useDraggableDialog();
  return (
    <div>
      {show ? (
        <div
          data-testid="dialog"
          ref={drag.dialogRef}
          style={{ transform: drag.transform }}
        >
          <div data-testid="handle" {...drag.handleProps} ref={drag.handleRef} />
        </div>
      ) : null}
    </div>
  );
}

/** jsdom 里所有元素 rect 都是 0，这里按「基准把手框 + 当前位移」造一个可信的 rect */
function mockRects() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const testId = this.dataset.testid;
      if (testId !== "handle" && testId !== "dialog") return rect(0, 0, 0, 0);
      const offset = readOffset(this.closest<HTMLElement>('[data-testid="dialog"]'));
      const dialogLeft = (window.innerWidth - layout.width) / 2 + offset.x;
      const dialogTop = (window.innerHeight - layout.height) / 2 + offset.y;
      if (testId === "dialog") {
        return rect(dialogLeft, dialogTop, layout.width, layout.height);
      }
      return rect(
        dialogLeft + HANDLE_REL.left,
        dialogTop + HANDLE_REL.top,
        BASE_HANDLE.width,
        BASE_HANDLE.height,
      );
    },
  );
  // jsdom 不做布局，`offsetWidth/offsetHeight` 恒为 0；`measureHandle` 靠它们算基准框
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "dialog" ? layout.width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "dialog" ? layout.height : 0;
    },
  });
}

function dragBy(dx: number, dy: number, startOn: HTMLElement) {
  fireEvent.pointerDown(startOn, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(startOn, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
  fireEvent.pointerUp(startOn, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
}

describe("useDraggableDialog", () => {
  const capture = vi.fn();
  const release = vi.fn();

  beforeEach(() => {
    resetRememberedOffset();
    layout = { width: DIALOG.width, height: DIALOG.height };
    Object.defineProperty(window, "innerWidth", { value: 1568, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 951, configurable: true });
    // jsdom 没实现指针捕获
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      value: capture,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      value: release,
      configurable: true,
      writable: true,
    });
    capture.mockClear();
    release.mockClear();
    mockRects();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, descriptor] of [
      ["offsetWidth", ORIGINAL_OFFSET_DESCRIPTORS.width],
      ["offsetHeight", ORIGINAL_OFFSET_DESCRIPTORS.height],
    ] as const) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    }
  });

  it("按下即捕获指针（不等超过阈值）", () => {
    const { getByTestId } = render(<Harness />);
    fireEvent.pointerDown(getByTestId("handle"), {
      button: 0,
      pointerId: 7,
      clientX: 100,
      clientY: 100,
    });
    expect(capture).toHaveBeenCalledWith(7);
  });

  it("阈值内的移动不算拖动", () => {
    const { getByTestId } = render(<Harness />);
    const handle = getByTestId("handle");
    const dialog = getByTestId("dialog");
    const before = dialog.style.transform;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 102, clientY: 101 });
    expect(dialog.style.transform).toBe(before);
  });

  it("超过阈值后按位移写 transform", () => {
    const { getByTestId } = render(<Harness />);
    const handle = getByTestId("handle");
    const dialog = getByTestId("dialog");
    dragBy(120, 67, handle);
    expect(readOffset(dialog)).toEqual({ x: 120, y: 67 });
  });

  it("交互元素上的按下不触发拖动", () => {
    const { getByTestId } = render(<Harness />);
    const dialog = getByTestId("dialog");
    const before = dialog.style.transform;
    dragBy(120, 67, getByTestId("inner-button"));
    expect(dialog.style.transform).toBe(before);
  });

  it("允许拖出视口：大位移原样保留（只按把手夹）", () => {
    const { getByTestId } = render(<Harness />);
    const dialog = getByTestId("dialog");
    dragBy(900, 600, getByTestId("handle"));
    expect(readOffset(dialog)).toEqual({ x: 900, y: 600 });
  });

  it("拖出视口后再拖到更远处，仍夹在「把手留 96×32」的边界内", () => {
    const { getByTestId } = render(<Harness />);
    const dialog = getByTestId("dialog");
    dragBy(100000, 100000, getByTestId("handle"));
    expect(readOffset(dialog)).toEqual({
      x: window.innerWidth - 96 - BASE_HANDLE.left,
      y: window.innerHeight - 32 - BASE_HANDLE.top,
    });
  });

  it("pointercancel 结束拖动并记住位置", () => {
    const { getByTestId, unmount } = render(<Harness />);
    const handle = getByTestId("handle");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 200, clientY: 140 });
    fireEvent.pointerCancel(handle, { pointerId: 1, clientX: 200, clientY: 140 });
    const saved = readOffset(getByTestId("dialog"));
    expect(saved).toEqual({ x: 100, y: 40 });

    unmount();
    // 重新打开（同一视口）：位置沿用上次
    const reopened = render(<Harness />);
    expect(readOffset(reopened.getByTestId("dialog"))).toEqual(saved);
  });

  it("重新挂载时按当前视口夹紧（视口缩小后不会整块跑到屏幕外）", async () => {
    const first = render(<Harness />);
    dragBy(900, 600, first.getByTestId("handle"));
    expect(readOffset(first.getByTestId("dialog"))).toEqual({ x: 900, y: 600 });
    first.unmount();

    // 视口缩小：`max-h-[90vh]` 同时把弹窗压到 630 高
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
    layout = { width: 950, height: 630 };

    const second = render(<Harness />);
    await waitFor(() => {
      const offset = readOffset(second.getByTestId("dialog"));
      // x 被夹到「把手右端距视口右缘 96px」：1000 - 96 - (25 + 200)
      expect(offset.x).toBe(679);
      // y 本来就在视口内（600 + 35.5 + 57 < 700），不该被乱动
      expect(offset.y).toBe(600);
    });
  });

  /**
   * 审查 M1：弹窗节点比 hook 晚挂载（Radix `Presence` 的真实时序）。
   * 主 effect 在 `active` 变 true 的那次提交里跑，那时 `nodeRef.current` 是 null；
   * 没有回调 ref 这条路径，就只能等 effect 里那个 260ms 的兜底定时器，
   * 用户看到的是「重开后窗口先在屏幕外停一下再跳回来」。
   */
  it("节点晚于 hook 挂载时，靠回调 ref 立刻夹紧（不等 260ms 兜底）", () => {
    const first = render(<Harness />);
    dragBy(900, 600, first.getByTestId("handle"));
    expect(readOffset(first.getByTestId("dialog"))).toEqual({ x: 900, y: 600 });
    first.unmount();

    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
    layout = { width: 950, height: 630 };

    // 从这里开始接管定时器：`setTimeout(…, 260)` 的兜底不会有机会跑
    vi.useFakeTimers();
    try {
      const { rerender, getByTestId } = render(<LateMountHarness show={false} />);
      // 先让 effect 自己排的两帧 rAF 空转完（那时还没有节点，夹不了）
      act(() => {
        vi.advanceTimersByTime(100);
      });
      rerender(<LateMountHarness show />);
      act(() => {
        // 只推进 40ms：effect 里那个 260ms 的兜底定时器还没到点，只剩回调 ref 这条路
        vi.advanceTimersByTime(40);
      });
      expect(readOffset(getByTestId("dialog"))).toEqual({ x: 679, y: 600 });
    } finally {
      vi.useRealTimers();
    }
  });
});
