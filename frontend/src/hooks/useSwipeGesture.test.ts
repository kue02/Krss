import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSwipeGesture } from "./useSwipeGesture";

describe("useSwipeGesture", () => {
  let element: HTMLDivElement;
  let ref: React.RefObject<HTMLDivElement>;

  beforeEach(() => {
    element = document.createElement("div");
    document.body.appendChild(element);
    ref = { current: element };
  });

  afterEach(() => {
    document.body.removeChild(element);
    vi.restoreAllMocks();
  });

  const createTouchEvent = (
    type: "touchstart" | "touchmove" | "touchend",
    x: number,
    y: number,
  ) => {
    const touch = { clientX: x, clientY: y };
    const event = new Event(type, {
      bubbles: true,
      cancelable: true,
    }) as TouchEvent;
    Object.defineProperty(event, "touches", {
      value: type === "touchend" ? [] : [touch],
    });
    return event;
  };

  it("should detect right swipe", () => {
    const onSwipeRight = vi.fn();

    renderHook(() => useSwipeGesture(ref, { onSwipeRight }));

    element.dispatchEvent(createTouchEvent("touchstart", 100, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 110, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 120, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 180, 100));
    element.dispatchEvent(createTouchEvent("touchend", 180, 100));

    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it("should detect left swipe", () => {
    const onSwipeLeft = vi.fn();

    renderHook(() => useSwipeGesture(ref, { onSwipeLeft }));

    element.dispatchEvent(createTouchEvent("touchstart", 200, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 190, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 180, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 120, 100));
    element.dispatchEvent(createTouchEvent("touchend", 120, 100));

    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
  });

  it("should not trigger swipe if below threshold", () => {
    const onSwipeRight = vi.fn();

    renderHook(() =>
      useSwipeGesture(ref, {
        onSwipeRight,
        threshold: 50,
        velocityThreshold: Infinity,
      }),
    );

    element.dispatchEvent(createTouchEvent("touchstart", 100, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 110, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 130, 100));
    element.dispatchEvent(createTouchEvent("touchend", 130, 100));

    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("should distinguish between vertical scroll and horizontal swipe", () => {
    const onSwipeRight = vi.fn();

    renderHook(() => useSwipeGesture(ref, { onSwipeRight }));

    // Primarily vertical movement (should not trigger swipe)
    element.dispatchEvent(createTouchEvent("touchstart", 100, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 110, 120));
    element.dispatchEvent(createTouchEvent("touchmove", 120, 150));
    element.dispatchEvent(createTouchEvent("touchend", 120, 150));

    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("should only trigger enabled directions", () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();

    renderHook(() =>
      useSwipeGesture(ref, {
        onSwipeLeft,
        onSwipeRight,
        enabledDirections: ["right"], // Only right enabled
      }),
    );

    // Try right swipe - should work
    element.dispatchEvent(createTouchEvent("touchstart", 100, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 110, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 180, 100));
    element.dispatchEvent(createTouchEvent("touchend", 180, 100));

    expect(onSwipeRight).toHaveBeenCalledTimes(1);

    // Try left swipe - should not work
    element.dispatchEvent(createTouchEvent("touchstart", 200, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 190, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 120, 100));
    element.dispatchEvent(createTouchEvent("touchend", 120, 100));

    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it("should not register listeners when enabled is false", () => {
    const addSpy = vi.spyOn(element, "addEventListener");
    const onSwipeRight = vi.fn();

    renderHook(() => useSwipeGesture(ref, { onSwipeRight, enabled: false }));

    expect(addSpy).not.toHaveBeenCalled();

    element.dispatchEvent(createTouchEvent("touchstart", 100, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 110, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 180, 100));
    element.dispatchEvent(createTouchEvent("touchend", 180, 100));

    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("should call onSwipe with direction", () => {
    const onSwipe = vi.fn();

    renderHook(() => useSwipeGesture(ref, { onSwipe }));

    element.dispatchEvent(createTouchEvent("touchstart", 100, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 110, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 180, 100));
    element.dispatchEvent(createTouchEvent("touchend", 180, 100));

    expect(onSwipe).toHaveBeenCalledWith("right");
  });

  describe("逐帧跟手回调 (onDrag*)", () => {
    /** 用可控时钟驱动 Date.now，模拟真实手指移动的时间间隔 */
    function withClock() {
      let clock = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      return {
        advance(ms: number) {
          clock += ms;
        },
      };
    }

    it("逐帧上报位移与瞬时速度，松手回调拿到真实速度", () => {
      const clock = withClock();
      const onDragStart = vi.fn();
      const onDragMove = vi.fn();
      const onDragEnd = vi.fn();

      renderHook(() =>
        useSwipeGesture(ref, { onDragStart, onDragMove, onDragEnd }),
      );

      element.dispatchEvent(createTouchEvent("touchstart", 200, 100));
      clock.advance(20);
      element.dispatchEvent(createTouchEvent("touchmove", 180, 100)); // -20px, -1px/ms
      clock.advance(40);
      element.dispatchEvent(createTouchEvent("touchmove", 145, 100)); // -55px, -0.875px/ms
      clock.advance(10);
      element.dispatchEvent(createTouchEvent("touchend", 145, 100));

      expect(onDragStart).toHaveBeenCalledTimes(1);
      expect(onDragMove).toHaveBeenNthCalledWith(1, -20, 0, -1);
      expect(onDragMove).toHaveBeenNthCalledWith(2, -55, 0, -0.875);
      expect(onDragEnd).toHaveBeenCalledTimes(1);
      const [offsetX, velocityX] = onDragEnd.mock.calls[0]!;
      expect(offsetX).toBe(-55);
      expect(velocityX).toBeCloseTo(-0.875);
    });

    it("快速短距离左甩：onDragEnd 速度非零且为负（回归：不再恒为 0）", () => {
      const clock = withClock();
      const onDragEnd = vi.fn();

      renderHook(() =>
        useSwipeGesture(ref, {
          onDragStart: () => {},
          onDragMove: () => {},
          onDragEnd,
        }),
      );

      element.dispatchEvent(createTouchEvent("touchstart", 200, 100));
      clock.advance(20);
      element.dispatchEvent(createTouchEvent("touchmove", 180, 100));
      clock.advance(40);
      element.dispatchEvent(createTouchEvent("touchmove", 150, 100));
      clock.advance(10);
      element.dispatchEvent(createTouchEvent("touchend", 150, 100));

      const [, velocityX] = onDragEnd.mock.calls[0]!;
      expect(velocityX).toBeLessThan(-0.4);
    });

    it("快速短距离右甩：onDragEnd 速度非零且为正", () => {
      const clock = withClock();
      const onDragEnd = vi.fn();

      renderHook(() =>
        useSwipeGesture(ref, {
          onDragStart: () => {},
          onDragMove: () => {},
          onDragEnd,
        }),
      );

      element.dispatchEvent(createTouchEvent("touchstart", 100, 100));
      clock.advance(20);
      element.dispatchEvent(createTouchEvent("touchmove", 120, 100));
      clock.advance(40);
      element.dispatchEvent(createTouchEvent("touchmove", 150, 100));
      clock.advance(10);
      element.dispatchEvent(createTouchEvent("touchend", 150, 100));

      const [, velocityX] = onDragEnd.mock.calls[0]!;
      expect(velocityX).toBeGreaterThan(0.4);
    });

    it("松手距最后一次 move 超过 80ms 时速度按 0 处理", () => {
      const clock = withClock();
      const onDragEnd = vi.fn();

      renderHook(() =>
        useSwipeGesture(ref, {
          onDragStart: () => {},
          onDragMove: () => {},
          onDragEnd,
        }),
      );

      element.dispatchEvent(createTouchEvent("touchstart", 200, 100));
      clock.advance(20);
      element.dispatchEvent(createTouchEvent("touchmove", 180, 100));
      clock.advance(40);
      element.dispatchEvent(createTouchEvent("touchmove", 150, 100)); // -0.75px/ms
      clock.advance(100); // 手指停稳后再松手
      element.dispatchEvent(createTouchEvent("touchend", 150, 100));

      const [, velocityX] = onDragEnd.mock.calls[0]!;
      expect(velocityX).toBe(0);
    });
  });

  it("should only start swipe detection inside the configured edge zone", () => {
    const onSwipeRight = vi.fn();

    renderHook(() =>
      useSwipeGesture(ref, {
        onSwipeRight,
        startFrom: { left: 24 },
      }),
    );

    element.dispatchEvent(createTouchEvent("touchstart", 40, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 120, 100));
    element.dispatchEvent(createTouchEvent("touchend", 120, 100));

    expect(onSwipeRight).not.toHaveBeenCalled();

    element.dispatchEvent(createTouchEvent("touchstart", 20, 100));
    element.dispatchEvent(createTouchEvent("touchmove", 120, 100));
    element.dispatchEvent(createTouchEvent("touchend", 120, 100));

    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });
});
