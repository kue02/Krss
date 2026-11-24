/* eslint-disable react-hooks/refs -- 测试夹具：ref 必须原样交给 hook 才能跑真实手势路径，渲染期不解引用 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
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
});
