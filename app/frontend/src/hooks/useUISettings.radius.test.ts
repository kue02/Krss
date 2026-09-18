import { describe, it, expect, beforeEach } from "vitest";
import {
  applyComponentRadiusToDocument,
  applyFieldRadiusToDocument,
  applyIconRadiusToDocument,
  applyUISettingsPackageFromServer,
  getUISettings,
  radiusPresetToCss,
  type RadiusPreset,
} from "./useUISettings";

/**
 * 18 批（圆角统一）：三个旋钮落 <html> 的规矩必须成立 ——
 * ① 档位照 HeroUI 官方刻度（直角 0 / XS 2 / SM 4 / 默认 8 / LG 10 / XL 12 / 全圆），基准 `--radius` = .5rem；
 * ② `default` = **把变量摘掉**（组件圆角摘 `--radius`、表单圆角摘 `--field-radius`）⇒ 回出厂值；
 * ③ 写的是组件库自己的变量（`--radius` / `--field-radius`），不是按 slot 覆盖；
 * ④ 老键 `buttonRadius` → 新键 `componentRadius` 要能搬过来（不丢用户设置）。
 */
describe("18 批 圆角档位", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-component-radius");
    document.documentElement.removeAttribute("data-field-radius");
    document.documentElement.removeAttribute("data-icon-radius");
    document.documentElement.style.removeProperty("--radius");
    document.documentElement.style.removeProperty("--field-radius");
    document.documentElement.style.removeProperty("--ui-icon-radius");
  });

  it("档位映射照 HeroUI 刻度", () => {
    const expected: Array<[RadiusPreset, string | null]> = [
      ["default", null],
      ["none", "0px"],
      ["xs", "2px"],
      ["sm", "4px"],
      ["lg", "10px"],
      ["xl", "12px"],
      ["full", "9999px"],
    ];
    for (const [preset, css] of expected) {
      expect(radiusPresetToCss(preset)).toBe(css);
    }
  });

  it("组件圆角：写 HeroUI 自己的 --radius；回到 default 要摘干净", () => {
    applyComponentRadiusToDocument("xl");
    const root = document.documentElement;
    expect(root.getAttribute("data-component-radius")).toBe("xl");
    expect(root.style.getPropertyValue("--radius")).toBe("12px");

    applyComponentRadiusToDocument("default");
    expect(root.hasAttribute("data-component-radius")).toBe(false);
    expect(root.style.getPropertyValue("--radius")).toBe("");
  });

  it("表单圆角：写 --field-radius；default = 摘掉（跟随组件的 ×1.5）", () => {
    applyFieldRadiusToDocument("sm");
    const root = document.documentElement;
    expect(root.getAttribute("data-field-radius")).toBe("sm");
    expect(root.style.getPropertyValue("--field-radius")).toBe("4px");

    applyFieldRadiusToDocument("default");
    expect(root.hasAttribute("data-field-radius")).toBe(false);
    expect(root.style.getPropertyValue("--field-radius")).toBe("");
  });

  it("三个旋钮互不干扰（改表单/图标不动组件）", () => {
    applyComponentRadiusToDocument("sm");
    applyFieldRadiusToDocument("full");
    applyIconRadiusToDocument("xs");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--radius")).toBe("4px");
    expect(root.style.getPropertyValue("--field-radius")).toBe("9999px");
    expect(root.style.getPropertyValue("--ui-icon-radius")).toBe("2px");

    applyIconRadiusToDocument("default");
    expect(root.style.getPropertyValue("--radius")).toBe("4px");
    expect(root.style.getPropertyValue("--field-radius")).toBe("9999px");
    expect(root.hasAttribute("data-icon-radius")).toBe(false);
  });
});

describe("18 批 老键迁移", () => {
  it("老键 buttonRadius 的值搬到 componentRadius（12-18 设过的档位不丢）", () => {
    // 服务端 / 本地老包走的是同一条收窄路径（sanitizeBag）
    applyUISettingsPackageFromServer({
      shared: { buttonRadius: "xl", iconRadius: "full" },
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().componentRadius).toBe("xl");
    // 新键已经在包里了，再写回来的包里没有 componentRadius 时不该被清掉
    applyUISettingsPackageFromServer({
      shared: { componentRadius: "sm" },
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().componentRadius).toBe("sm");
  });

  it("换刻度后不认得的档位（md 6px）丢掉 ⇒ 回落默认档，而不是卡在「没选中」", () => {
    applyUISettingsPackageFromServer({
      shared: { componentRadius: "md", fieldRadius: "md", iconRadius: "md" },
      device: { desktop: {}, mobile: {} },
    });
    const s = getUISettings();
    expect(s.componentRadius).toBe("default");
    expect(s.fieldRadius).toBe("default");
    expect(s.iconRadius).toBe("default");
  });
});
