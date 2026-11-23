import { describe, expect, it } from "vitest";
import {
  clampEntryFontSize,
  clampEntryLineHeight,
  ENTRY_FONT_SIZE_MAX,
  ENTRY_FONT_SIZE_MIN,
  ENTRY_LINE_HEIGHT_MAX,
  ENTRY_LINE_HEIGHT_MIN,
} from "./useUISettings";

/**
 * 正文字号 / 行高是跨设备同步的数值：桌面数字步进器与手机 ± 步进都得守同一区间。
 * 夹取逻辑抽成纯函数（clampEntryFontSize / clampEntryLineHeight），这里直接测边界。
 */
describe("字号 / 行高夹取（跨设备同步的合法区间）", () => {
  it("区间常量与设定一致（字号 12–24 / 行高 1.2–2.4）", () => {
    expect(ENTRY_FONT_SIZE_MIN).toBe(12);
    expect(ENTRY_FONT_SIZE_MAX).toBe(24);
    expect(ENTRY_LINE_HEIGHT_MIN).toBe(1.2);
    expect(ENTRY_LINE_HEIGHT_MAX).toBe(2.4);
  });

  it("字号夹进 12–24 并取整数", () => {
    expect(clampEntryFontSize(16)).toBe(16);
    expect(clampEntryFontSize(5)).toBe(12);
    expect(clampEntryFontSize(99)).toBe(24);
    expect(clampEntryFontSize(12)).toBe(12);
    expect(clampEntryFontSize(24)).toBe(24);
    expect(clampEntryFontSize(18.4)).toBe(18);
    expect(clampEntryFontSize(Number.NaN)).toBe(16); // 非数 → 回落默认
  });

  it("行高夹进 1.2–2.4 并保留一位小数", () => {
    expect(clampEntryLineHeight(1.8)).toBe(1.8);
    expect(clampEntryLineHeight(0.5)).toBe(1.2);
    expect(clampEntryLineHeight(9)).toBe(2.4);
    expect(clampEntryLineHeight(1.24)).toBe(1.2);
    expect(clampEntryLineHeight(1.85)).toBe(1.9);
    expect(clampEntryLineHeight(Number.POSITIVE_INFINITY)).toBe(1.8); // 非有限 → 回落默认
  });
});
