import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  clampOffset,
  clampScale,
  isDoubleTap,
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

  it("按图片实际布局尺寸计算平移边界（letterbox 时不产生空白）", () => {
    // 图片 400x300 放在 800x600 容器里；2x 后 800x600，恰好铺满，不能平移
    expect(
      clampOffset({ x: 999, y: -999 }, 2, { width: 800, height: 600 }, {
        width: 400,
        height: 300,
      }),
    ).toEqual({ x: 0, y: 0 });

    // 2.5x 后 1000x750，横向溢出 200、纵向溢出 150
    expect(
      clampOffset({ x: 999, y: 999 }, 2.5, { width: 800, height: 600 }, {
        width: 400,
        height: 300,
      }),
    ).toEqual({ x: 100, y: 75 });
  });

  it("以某点为锚放大时，该点保持不动", () => {
    // 在中心右侧 100px 处放大到 2 倍 → 平移 -100，使原点仍在原处
    expect(offsetForZoomAt({ x: 100, y: 0 }, 1, 2)).toEqual({ x: -100, y: 0 });
    // 从 2 倍回到 1 倍 → 反向
    expect(offsetForZoomAt({ x: 100, y: 0 }, 2, 1)).toEqual({ x: 50, y: 0 });
  });

  it("2x→3x 时叠加已有平移，锚点仍然不动", () => {
    // 2x 且已向左平移 100 时，屏幕上 x=100 处对应图片内容点 x=100
    const next = offsetForZoomAt({ x: 100, y: 0 }, 2, 3, { x: -100, y: 0 });
    expect(next).toEqual({ x: -200, y: 0 });

    // 缩放后同一内容点仍在屏幕 x=100：3 * 100 + (-200) = 100
    expect(3 * 100 + next.x).toBe(100);
  });

  it("滚轮步进：上滚（deltaY 为负）放大、下滚缩小，且不越界", () => {
    expect(nextScale(2, -400)).toBeGreaterThan(2);
    expect(nextScale(2, 400)).toBeLessThan(2);
    expect(nextScale(1, -4000)).toBe(MAX_IMAGE_SCALE);
    expect(nextScale(4, 4000)).toBe(MIN_IMAGE_SCALE);
  });

  it("双击判定：时间窗口内且位移不超过阈值才算双击", () => {
    const last = { t: 1000, x: 100, y: 100 };
    // 150ms 后、同一点 → 双击
    expect(isDoubleTap(last, 1150, 100, 100, 320, 30)).toBe(true);
    // 位移 20px（≤30）仍算双击
    expect(isDoubleTap(last, 1150, 120, 100, 320, 30)).toBe(true);
    // 超过 320ms → 不是
    expect(isDoubleTap(last, 1400, 100, 100, 320, 30)).toBe(false);
    // 位移超过 30px → 不是
    expect(isDoubleTap(last, 1150, 140, 100, 320, 30)).toBe(false);
    // 没有上一次点按 → 不是
    expect(isDoubleTap(null, 1150, 100, 100, 320, 30)).toBe(false);
  });
});
