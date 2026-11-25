import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { useMobileLongPress } from "./useMobileLongPress";

function Harness({ onLongPress }: { onLongPress: (p: { x: number; y: number }) => void }) {
  const longPress = useMobileLongPress(true, onLongPress, { allowButtonRoot: true });
  return (
    <div data-long-press-root {...longPress.touchHandlers}>
      <span>整行</span>
      <button type="button">行内按钮</button>
    </div>
  );
}

describe("useMobileLongPress", () => {
  it("行内嵌套按钮的 contextmenu 不会冒泡成整行长按", () => {
    const onLongPress = vi.fn();
    const { container } = render(<Harness onLongPress={onLongPress} />);
    const nested = container.querySelector("div button") as HTMLElement;
    fireEvent.contextMenu(nested, { clientX: 10, clientY: 20 });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("根按钮 contextmenu 仍能触发；timer 后同一手势不重复", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { container } = render(<Harness onLongPress={onLongPress} />);
    const root = container.querySelector("[data-long-press-root]") as HTMLElement;
    fireEvent.touchStart(root, { touches: [{ clientX: 10, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(520);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(root, { clientX: 10, clientY: 20 });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
