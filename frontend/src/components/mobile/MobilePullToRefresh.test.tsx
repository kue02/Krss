import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobilePullToRefresh } from "./MobilePullToRefresh";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

type TouchType = "touchstart" | "touchmove" | "touchend" | "touchcancel";

function touch(type: TouchType, x: number, y: number): TouchEvent {
  const touches =
    type === "touchend" || type === "touchcancel"
      ? []
      : ([{ clientX: x, clientY: y, identifier: 1 }] as unknown as Touch[]);
  return new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches,
  });
}

/** 把事件发到 body：window 是冒泡终点，target 是真实元素（与真机一致） */
function fire(type: TouchType, x: number, y: number): boolean {
  return fireEvent(document.body, touch(type, x, y));
}

function setScrollY(value: number) {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    get: () => value,
  });
}

function progress() {
  return screen.getByTestId("pull-refresh-progress");
}

function progressVisible() {
  return progress().classList.contains("opacity-100");
}

function makeWrapper(attribute: string, value: string): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute(attribute, value);
  const inner = document.createElement("span");
  inner.textContent = "浮层内容";
  wrapper.append(inner);
  document.body.append(wrapper);
  return wrapper;
}

describe("MobilePullToRefresh", () => {
  let onRefresh: () => Promise<void>;

  beforeEach(() => {
    setScrollY(0);
    onRefresh = vi.fn(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderComponent(isRefreshing = false) {
    render(
      <MobilePullToRefresh
        enabled
        isRefreshing={isRefreshing}
        onRefresh={onRefresh}
      />,
    );
  }

  it("横滑（dx > dy）不显示进度条，也不 preventDefault", async () => {
    renderComponent();
    expect(progressVisible()).toBe(false);

    fire("touchstart", 100, 100);
    // 第一次 move 就是横向占优：判定为横向
    const horizontal = touch("touchmove", 160, 105);
    expect(fireEvent(document.body, horizontal)).toBe(true);
    expect(horizontal.defaultPrevented).toBe(false);
    expect(progressVisible()).toBe(false);

    // 之后即使同一次手势里纵向位移变大，也应保持忽略
    const later = touch("touchmove", 165, 230);
    expect(fireEvent(document.body, later)).toBe(true);
    expect(later.defaultPrevented).toBe(false);
    expect(progressVisible()).toBe(false);

    fire("touchend", 165, 230);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(progressVisible()).toBe(false);
  });

  it("从 [data-swipe-row] 起手纵向下拉仍然触发（不再整层排除）", async () => {
    renderComponent();
    const row = makeWrapper("data-swipe-row", "");
    const inner = row.firstElementChild as HTMLElement;

    try {
      fireEvent(inner, touch("touchstart", 100, 100));
      const move = touch("touchmove", 100, 240);
      expect(fireEvent(inner, move)).toBe(false);
      expect(move.defaultPrevented).toBe(true);
      expect(progressVisible()).toBe(true);

      fireEvent(inner, touch("touchend", 100, 240));
      await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    } finally {
      row.remove();
    }
  });

  it("从 [data-swipe-row] 起手横滑不 preventDefault、不显示进度", async () => {
    renderComponent();
    const row = makeWrapper("data-swipe-row", "");
    const inner = row.firstElementChild as HTMLElement;

    try {
      fireEvent(inner, touch("touchstart", 100, 100));
      const move = touch("touchmove", 160, 105);
      expect(fireEvent(inner, move)).toBe(true);
      expect(move.defaultPrevented).toBe(false);
      expect(progressVisible()).toBe(false);

      fireEvent(inner, touch("touchend", 160, 105));
      expect(onRefresh).not.toHaveBeenCalled();
    } finally {
      row.remove();
    }
  });

  it.each([
    ["data-overlay", ""],
    ["data-slot", "sheet-content"],
    ["data-slot", "sheet"],
  ])("浮层 [%s=%s] 内起手不接管、不 preventDefault、不刷新", async (attr, value) => {
    renderComponent();
    const overlay = makeWrapper(attr, value);
    const inner = overlay.firstElementChild as HTMLElement;

    try {
      fireEvent(inner, touch("touchstart", 100, 100));
      const move = touch("touchmove", 100, 240);
      expect(fireEvent(inner, move)).toBe(true);
      expect(move.defaultPrevented).toBe(false);
      expect(progressVisible()).toBe(false);

      fireEvent(inner, touch("touchend", 100, 240));
      expect(onRefresh).not.toHaveBeenCalled();
    } finally {
      overlay.remove();
    }
  });

  it("先纵后横：未过阈值时改判横向，停止 preventDefault 并复位", async () => {
    renderComponent();

    fire("touchstart", 100, 100);
    // 先纵移 30px：进入下拉并 preventDefault
    const vertical = touch("touchmove", 100, 130);
    expect(fireEvent(document.body, vertical)).toBe(false);
    expect(vertical.defaultPrevented).toBe(true);
    expect(progressVisible()).toBe(true);

    // 再大幅横移（dx=120），纵向仍只有 30px：应改判横向、复位且不阻断
    const horizontal = touch("touchmove", 220, 130);
    expect(fireEvent(document.body, horizontal)).toBe(true);
    expect(horizontal.defaultPrevented).toBe(false);
    expect(progressVisible()).toBe(false);

    fire("touchend", 220, 130);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("纵向下拉超过阈值后松手触发 onRefresh", async () => {
    renderComponent();

    fire("touchstart", 100, 100);
    // dy = 140 -> pow(140, 0.86) ≈ 70，已超过 64 的阈值
    const move = touch("touchmove", 100, 240);
    expect(fireEvent(document.body, move)).toBe(false);
    expect(move.defaultPrevented).toBe(true);
    expect(progressVisible()).toBe(true);

    fire("touchend", 100, 240);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));

    // 刷新结束后复位，进度条隐藏
    await waitFor(() => expect(progressVisible()).toBe(false));
  });

  it("拉动未超过阈值：回弹、不刷新", async () => {
    renderComponent();

    fire("touchstart", 100, 100);
    // dy = 40 -> pow(40, 0.86) ≈ 24，未到 64
    fire("touchmove", 100, 140);
    expect(progressVisible()).toBe(true);

    fire("touchend", 100, 140);
    expect(onRefresh).not.toHaveBeenCalled();
    await waitFor(() => expect(progressVisible()).toBe(false));
  });

  it("touchcancel 只复位，即使已拉过阈值也不刷新", async () => {
    renderComponent();

    fire("touchstart", 100, 100);
    fire("touchmove", 100, 240);
    expect(progressVisible()).toBe(true);

    fire("touchcancel", 100, 240);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(progressVisible()).toBe(false);
  });

  it("scrollY > 0 时不触发下拉", async () => {
    setScrollY(120);
    renderComponent();

    fire("touchstart", 100, 100);
    const move = touch("touchmove", 100, 240);
    expect(fireEvent(document.body, move)).toBe(true);
    expect(move.defaultPrevented).toBe(false);

    fire("touchend", 100, 240);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("isRefreshing 为 true 时不再接管新手势", async () => {
    renderComponent(true);

    fire("touchstart", 100, 100);
    const move = touch("touchmove", 100, 240);
    expect(fireEvent(document.body, move)).toBe(true);
    expect(move.defaultPrevented).toBe(false);

    fire("touchend", 100, 240);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
