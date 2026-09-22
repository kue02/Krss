import { describe, expect, it } from "vitest";
import { clampDragOffset, dragTransform } from "./useDraggableDialog";

/**
 * 23-3：设置窗口拖动的纯函数部分。
 * 指针手势本身（pointerdown/move/up + setPointerCapture）照 HeroUI drawer 那套，
 * 这里只钉「位移怎么写」与「视口夹紧」。
 */
describe("dragTransform", () => {
  it("纯偏移，不含居中段（DialogContent 的居中在 CSS translate 属性上，分开合成）", () => {
    expect(dragTransform({ x: 0, y: 0 })).toBe("translate(0px, 0px)");
    expect(dragTransform({ x: 120, y: 67 })).toBe("translate(120px, 67px)");
    expect(dragTransform({ x: -30, y: -10 })).toBe("translate(-30px, -10px)");
  });
});

describe("clampDragOffset", () => {
  // 950×800 的设置窗在 1568×951 视口里居中：left=309, top≈76
  const box = { left: 309, top: 76, width: 950, height: 800 };
  const viewport = { width: 1568, height: 951 };

  it("视口内自由拖：原样通过", () => {
    expect(clampDragOffset({ x: 120, y: 67 }, box, viewport)).toEqual({
      x: 120,
      y: 67,
    });
  });

  it("往左/上拖过头：夹到 margin（标题栏始终够得着）", () => {
    expect(clampDragOffset({ x: -1000, y: -1000 }, box, viewport)).toEqual({
      x: 8 - 309,
      y: 8 - 76,
    });
  });

  it("往右/下拖过头：夹到视口边缘", () => {
    expect(clampDragOffset({ x: 1000, y: 1000 }, box, viewport)).toEqual({
      x: 1568 - 8 - 950 - 309,
      y: 951 - 8 - 800 - 76,
    });
  });

  it("窗口比视口还大时不乱跳（取较小的那一端）", () => {
    const big = { left: -100, top: -100, width: 2000, height: 1200 };
    const next = clampDragOffset({ x: 50, y: 50 }, big, viewport);
    expect(Number.isFinite(next.x)).toBe(true);
    expect(Number.isFinite(next.y)).toBe(true);
  });
});
