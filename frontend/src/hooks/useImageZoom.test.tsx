import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useImageZoom } from "./useImageZoom";

describe("useImageZoom", () => {
  it("toggleZoomAt 在 1x 时放大到 2x，再调用一次复位到 1x", () => {
    const { result } = renderHook(() => useImageZoom());

    expect(result.current.scale).toBe(1);
    expect(result.current.isZoomed).toBe(false);

    act(() => result.current.toggleZoomAt(100, 100));
    expect(result.current.scale).toBe(2);
    expect(result.current.isZoomed).toBe(true);

    act(() => result.current.toggleZoomAt(100, 100));
    expect(result.current.scale).toBe(1);
    expect(result.current.isZoomed).toBe(false);
  });

  it("resetKey 变化时复位缩放", () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useImageZoom(key),
      { initialProps: { key: "0:a" } },
    );

    act(() => result.current.toggleZoomAt(0, 0));
    expect(result.current.scale).toBe(2);

    rerender({ key: "1:b" });
    expect(result.current.scale).toBe(1);
  });
});
