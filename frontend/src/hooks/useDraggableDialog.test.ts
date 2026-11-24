import { describe, expect, it } from "vitest";
import { clampDragOffset, dragTransform } from "./useDraggableDialog";

/**
 * 23-3：设置窗口拖动的纯函数部分。
 * 指针手势本身（pointerdown/move/up + setPointerCapture）照 HeroUI drawer 那套，
 * 这里只钉「位移怎么写」与「视口夹紧」。
 *
 * 1124（用户：「设置页面可以被拖动到窗口外」）：夹紧的基准从**整窗**改成**拖动把手** ——
 * 允许窗口整块移出视口，只要求标题栏（把手）还留一块在视口内，否则就再也抓不回来。
 */
describe("dragTransform", () => {
  it("纯偏移，不含居中段（DialogContent 的居中在 CSS translate 属性上，分开合成）", () => {
    expect(dragTransform({ x: 0, y: 0 })).toBe("translate(0px, 0px)");
    expect(dragTransform({ x: 120, y: 67 })).toBe("translate(120px, 67px)");
    expect(dragTransform({ x: -30, y: -10 })).toBe("translate(-30px, -10px)");
  });
});

describe("clampDragOffset", () => {
  // 950×800 的设置窗在 1568×951 视口里居中：窗口 left=309, top=76。
  // 拖动把手是右栏标题栏（左栏 200px 宽），所以 left=509、top=76、宽 750、高约 57。
  const handle = { left: 509, top: 76, width: 750, height: 57 };
  const viewport = { width: 1568, height: 951 };
  // 默认保留 96×32 的把手在视口内
  const keepX = 96;
  const keepY = 32;

  it("视口内自由拖：原样通过", () => {
    expect(clampDragOffset({ x: 120, y: 67 }, handle, viewport)).toEqual({
      x: 120,
      y: 67,
    });
  });

  it("允许窗口大半移出视口（用户要的「拖到窗口外」）", () => {
    // 窗口 left 从 309 挪到 309+900=1209，右边缘 2159 已经远在 1568 之外
    const next = clampDragOffset({ x: 900, y: 600 }, handle, viewport);
    expect(next).toEqual({ x: 900, y: 600 });
    expect(309 + next.x).toBeGreaterThan(viewport.width - 950);
    expect(76 + next.y).toBeGreaterThan(viewport.height - 800);
  });

  it("往右/下拖过头：夹到「把手还留 96×32 在视口内」", () => {
    expect(clampDragOffset({ x: 10000, y: 10000 }, handle, viewport)).toEqual({
      x: viewport.width - keepX - handle.left,
      y: viewport.height - keepY - handle.top,
    });
  });

  it("往左/上拖过头：夹到把手右下角仍贴住视口左上角", () => {
    expect(clampDragOffset({ x: -10000, y: -10000 }, handle, viewport)).toEqual({
      x: keepX - (handle.left + handle.width),
      y: keepY - (handle.top + handle.height),
    });
  });

  it("把手比视口还宽时不乱跳（min/max 交换，取较近的一端）", () => {
    const wide = { left: 0, top: 0, width: 3000, height: 40 };
    const next = clampDragOffset({ x: 50, y: 50 }, wide, viewport);
    expect(Number.isFinite(next.x)).toBe(true);
    expect(Number.isFinite(next.y)).toBe(true);
    expect(next.y).toBe(50);
  });

  it("保留量可覆盖（窄视口下按需放宽）", () => {
    const narrow = { width: 400, height: 300 };
    expect(
      clampDragOffset({ x: 9999, y: 0 }, handle, narrow, { x: 24, y: 8 }),
    ).toEqual({ x: 400 - 24 - handle.left, y: 0 });
  });
});
