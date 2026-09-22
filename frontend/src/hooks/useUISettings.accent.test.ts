import { afterEach, describe, expect, it } from "vitest";
import {
  accentForegroundFor,
  applyAccentColorToDocument,
} from "./useUISettings";

/**
 * 用户第十一批 11-13：主题色（HeroUI ColorPicker）。
 * 落地是往 <html> 写内联的 --accent / --accent-foreground（内联压过 [data-theme] 里各主题自带的值），
 * 这里钉住「写入 / 清除 / 前景色按亮度挑」三件事。
 */
const root = document.documentElement;

afterEach(() => {
  root.style.removeProperty("--accent");
  root.style.removeProperty("--accent-foreground");
});

describe("主题色落地", () => {
  it("选了颜色就写内联 --accent，并按亮度挑前景色", () => {
    applyAccentColorToDocument("#3b82f6");
    expect(root.style.getPropertyValue("--accent")).toBe("#3b82f6");
    expect(root.style.getPropertyValue("--accent-foreground")).toBe("rgb(255 255 255)");

    // 浅色（淡黄）上不能用白字，否则糊在底上
    applyAccentColorToDocument("#fde68a");
    expect(root.style.getPropertyValue("--accent-foreground")).toBe("rgb(17 17 17)");
  });

  it("传 null 清掉内联值，回到主题自带的强调色", () => {
    applyAccentColorToDocument("#10b981");
    expect(root.style.getPropertyValue("--accent")).not.toBe("");
    applyAccentColorToDocument(null);
    expect(root.style.getPropertyValue("--accent")).toBe("");
    expect(root.style.getPropertyValue("--accent-foreground")).toBe("");
  });

  it("三位短 hex 与非法值都有兜底", () => {
    expect(accentForegroundFor("#fff")).toBe("rgb(17 17 17)");
    expect(accentForegroundFor("#000")).toBe("rgb(255 255 255)");
    expect(accentForegroundFor("not-a-color")).toBe("rgb(255 255 255)");
  });
});
