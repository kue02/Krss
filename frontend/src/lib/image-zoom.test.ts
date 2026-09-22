import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  clampOffset,
  clampScale,
  nextScale,
  offsetForZoomAt,
} from "@/lib/image-zoom";

describe("image-zoom", () => {
  it("缩放值夹在 1~4 之间", () => {
    expect(clampScale(0.2)).toBe(MIN_IMAGE_SCALE);
    expect(clampScale(9)).toBe(MAX_IMAGE_SCALE);
    expect(clampScale(2.5)).toBe(2.5);
    expect(clampScale(Number.NaN)).toBe(MIN_IMAGE_SCALE);
  });

  it("未放大时不允许平移", () => {
    expect(clampOffset({ x: 50, y: -80 }, 1, { width: 800, height: 600 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("放大后平移被限制在溢出的范围内", () => {
    const clamped = clampOffset({ x: 999, y: -999 }, 2, {
      width: 800,
      height: 600,
    });
    expect(clamped).toEqual({ x: 400, y: -300 });
  });

  it("以某点为锚放大时，该点保持不动", () => {
    // 在中心右侧 100px 处放大到 2 倍 → 平移 -100，使原点仍在原处
    expect(offsetForZoomAt({ x: 100, y: 0 }, 1, 2)).toEqual({ x: -100, y: 0 });
    // 从 2 倍回到 1 倍 → 反向
    expect(offsetForZoomAt({ x: 100, y: 0 }, 2, 1)).toEqual({ x: 50, y: 0 });
  });

  it("滚轮步进：上滚（deltaY 为负）放大、下滚缩小，且不越界", () => {
    expect(nextScale(2, -400)).toBeGreaterThan(2);
    expect(nextScale(2, 400)).toBeLessThan(2);
    expect(nextScale(1, -4000)).toBe(MAX_IMAGE_SCALE);
    expect(nextScale(4, 4000)).toBe(MIN_IMAGE_SCALE);
  });
});
