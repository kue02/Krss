import { describe, expect, it } from "vitest";
import { computeReadingProgress } from "./reading-progress";

/**
 * 23-4：正文阅读进度的纯计算。边界行为钉死在这里，
 * 组件只负责「从真实滚动节点取值 + 写进 HeroUI ProgressBar」。
 */
describe("computeReadingProgress", () => {
  it("顶部 = 0%", () => {
    expect(
      computeReadingProgress({ scrollTop: 0, scrollHeight: 5600, clientHeight: 935 }),
    ).toEqual({ percent: 0, scrollable: 4665 });
  });

  it("一半 = 50%", () => {
    const { percent } = computeReadingProgress({
      scrollTop: 2332.5,
      scrollHeight: 5600,
      clientHeight: 935,
    });
    expect(percent).toBeCloseTo(50, 5);
  });

  it("底部夹紧到 100%（浏览器会把超大 scrollTop 夹到 max）", () => {
    const max = 5600 - 935;
    const { percent, scrollable } = computeReadingProgress({
      scrollTop: max,
      scrollHeight: 5600,
      clientHeight: 935,
    });
    expect(scrollable).toBe(max);
    expect(percent).toBeCloseTo(100, 5);
  });

  it("短正文（滚不动）= 0%，不除零", () => {
    expect(
      computeReadingProgress({ scrollTop: 0, scrollHeight: 400, clientHeight: 935 }),
    ).toEqual({ percent: 0, scrollable: 0 });
  });

  it("还没渲染完（scrollHeight 为 0）= 0%", () => {
    expect(
      computeReadingProgress({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
    ).toEqual({ percent: 0, scrollable: 0 });
  });

  it("DPR 亚像素误差（差 0.5px）仍按「滚不动」处理", () => {
    const { percent } = computeReadingProgress({
      scrollTop: 0,
      scrollHeight: 935.5,
      clientHeight: 935,
    });
    expect(percent).toBe(0);
  });
});
