import { describe, it, expect, beforeEach } from "vitest";
import {
  applyButtonRadiusToDocument,
  applyIconRadiusToDocument,
  radiusPresetToCss,
  type RadiusPreset,
} from "./useUISettings";

/**
 * 12-18：圆角落到 <html> 的三件事必须成立 ——
 * ① 档位照 HeroUI 官方刻度（xs/sm/md/lg/xl = 2/4/6/8/12px）；
 * ② `default` = 摘掉属性与变量（默认状态不碰 HeroUI 自己的圆角，行为零变化）；
 * ③ 按钮与图标互不影响（用户明确要求分开设置）。
 */
describe("12-18 圆角档位", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-button-radius");
    document.documentElement.removeAttribute("data-icon-radius");
    document.documentElement.style.removeProperty("--ui-button-radius");
    document.documentElement.style.removeProperty("--ui-icon-radius");
  });

  it("档位映射照 HeroUI 刻度", () => {
    const expected: Array<[RadiusPreset, string | null]> = [
      ["default", null],
      ["none", "0px"],
      ["xs", "2px"],
      ["sm", "4px"],
      ["md", "6px"],
      ["lg", "8px"],
      ["xl", "12px"],
      ["full", "9999px"],
    ];
    for (const [preset, css] of expected) {
      expect(radiusPresetToCss(preset)).toBe(css);
    }
  });

  it("按钮圆角：写属性 + 变量；回到 default 要摘干净", () => {
    applyButtonRadiusToDocument("xl");
    const root = document.documentElement;
    expect(root.getAttribute("data-button-radius")).toBe("xl");
    expect(root.style.getPropertyValue("--ui-button-radius")).toBe("12px");

    applyButtonRadiusToDocument("default");
    expect(root.hasAttribute("data-button-radius")).toBe(false);
    expect(root.style.getPropertyValue("--ui-button-radius")).toBe("");
  });

  it("按钮与图标互相独立（改图标不动按钮）", () => {
    applyButtonRadiusToDocument("sm");
    applyIconRadiusToDocument("full");
    const root = document.documentElement;
    expect(root.getAttribute("data-button-radius")).toBe("sm");
    expect(root.getAttribute("data-icon-radius")).toBe("full");
    expect(root.style.getPropertyValue("--ui-button-radius")).toBe("4px");
    expect(root.style.getPropertyValue("--ui-icon-radius")).toBe("9999px");

    applyIconRadiusToDocument("default");
    expect(root.getAttribute("data-button-radius")).toBe("sm");
    expect(root.hasAttribute("data-icon-radius")).toBe(false);
  });
});
