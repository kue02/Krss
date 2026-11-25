import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { useMobileLongPress } from "./useMobileLongPress";

function NestedHarness({ onLongPress }: { onLongPress: (p: { x: number; y: number }) => void }) {
  const longPress = useMobileLongPress(true, onLongPress, { allowButtonRoot: true });
  return (
    <div data-long-press-root {...longPress.touchHandlers}>
      <span>整行</span>
      <button type="button">行内按钮</button>
      <a href="/demo">行内链接</a>
    </div>
  );
}

function ButtonHarness({ onLongPress }: { onLongPress: (p: { x: number; y: number }) => void }) {
  const longPress = useMobileLongPress(true, onLongPress, { allowButtonRoot: true });
  return (
    <button type="button" data-long-press-root {...longPress.touchHandlers}>
      整行按钮
    </button>
  );
}

describe("useMobileLongPress", () => {
  it("行内嵌套按钮/链接的 contextmenu 不会冒泡成整行长按", () => {
    const onLongPress = vi.fn();
    const { container } = render(<NestedHarness onLongPress={onLongPress} />);
    fireEvent.contextMenu(container.querySelector("div button") as HTMLElement, {
      clientX: 10,
      clientY: 20,
    });
    fireEvent.contextMenu(container.querySelector("div a") as HTMLElement, {
      clientX: 10,
      clientY: 20,
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("真实根 button 的 contextmenu 仍能触发；timer 后同一手势不重复", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { container } = render(<ButtonHarness onLongPress={onLongPress} />);
    const root = container.querySelector("button[data-long-press-root]") as HTMLElement;
    fireEvent.touchStart(root, { touches: [{ clientX: 10, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(520);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(root, { clientX: 10, clientY: 20 });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("松手后按住的旧 firedRef 不阻断外接设备的 contextmenu", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { container } = render(<ButtonHarness onLongPress={onLongPress} />);
    const root = container.querySelector("button[data-long-press-root]") as HTMLElement;
    fireEvent.touchStart(root, { touches: [{ clientX: 10, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(520);
    });
    fireEvent.touchEnd(root);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.contextMenu(root, { clientX: 10, clientY: 20 });
    expect(onLongPress).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
