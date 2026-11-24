import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobilePullToRefresh } from "./MobilePullToRefresh";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

type TouchType = "touchstart" | "touchmove" | "touchend";

function touch(type: TouchType, x: number, y: number): TouchEvent {
  const touches =
    type === "touchend"
      ? []
      : ([{ clientX: x, clientY: y, identifier: 1 }] as unknown as Touch[]);
  return new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches,
  });
}

/** 把事件发到 body：window 是捕获/冒泡终点，target 是真实元素（与真机一致） */
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

describe("MobilePullToRefresh", () => {
  let onRefresh: () => Promise<void>;

  beforeEach(() => {
    setScrollY(0);
    onRefresh = vi.fn(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderComponent() {
    render(
      <MobilePullToRefresh
        enabled
        isRefreshing={false}
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

  it("从 [data-swipe-row] 起手不触发下拉", async () => {
    renderComponent();

    const row = document.createElement("div");
    row.setAttribute("data-swipe-row", "");
    const inner = document.createElement("span");
    inner.textContent = "条目";
    row.append(inner);
    document.body.append(row);

    try {
      fireEvent(inner, touch("touchstart", 100, 100));
      const move = touch("touchmove", 100, 240);
      expect(fireEvent(inner, move)).toBe(true);
      expect(move.defaultPrevented).toBe(false);
      expect(progressVisible()).toBe(false);

      fireEvent(inner, touch("touchend", 100, 240));
      expect(onRefresh).not.toHaveBeenCalled();
    } finally {
      row.remove();
    }
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

  it("scrollY > 0 时不触发下拉", async () => {
    setScrollY(120);
    renderComponent();

    fire("touchstart", 100, 100);
    const move = touch("touchmove", 100, 240);
    expect(fireEvent(document.body, move)).toBe(true);
    expect(move.defaultPrevented).toBe(false);
    expect(progressVisible()).toBe(false);

    fire("touchend", 100, 240);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
