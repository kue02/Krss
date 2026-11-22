import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_COLORS } from "@/styles/theme-colors";

/**
 * 状态栏底色：applyTheme 必须把「当前配色实际铺满页面的底色」写进两条 theme-color meta。
 *
 * jsdom 没有真实布局，也没有 CanvasRenderingContext2D，`readThemeColor()` 会读不到
 * computed 值 —— 这时必须退回 THEME_COLORS（实测值），绝不能写进空串或 rgba(0,0,0,0)。
 * 真实浏览器里由 getComputedStyle + canvas 栅格化拿到 sRGB，本文件用打桩覆盖那条路径。
 */
function mountMetas(): void {
  document.head.innerHTML = [
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#000000" />',
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000" />',
  ].join("");
}

function metaContents(): (string | null)[] {
  return Array.from(
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  ).map((meta) => meta.getAttribute("content"));
}

async function freshModule(): Promise<typeof import("./useTheme")> {
  vi.resetModules();
  return await import("./useTheme");
}

function setStoredTheme(
  mode: string,
  lightTheme: string,
  darkTheme: string,
): void {
  localStorage.setItem("krss-theme", mode);
  localStorage.setItem("krss-light-theme", lightTheme);
  localStorage.setItem("krss-dark-theme", darkTheme);
}

beforeEach(() => {
  localStorage.clear();
  mountMetas();
});

afterEach(() => {
  // 让 applyThemeColor 里挂起的 requestAnimationFrame 因主题不再匹配而直接返回
  document.documentElement.dataset.theme = "";
  document.documentElement.className = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("主题切换写入 theme-color meta", () => {
  const lightCases = ["light", "stone", "leaf"] as const;
  const darkCases = ["dark", "nord-dark"] as const;

  it.each(lightCases)("亮色主题 %s 写入实测底色", async (themeId) => {
    setStoredTheme("light", themeId, "dark");
    const { THEME_COLORS: exported } = await freshModule();

    expect(metaContents()).toEqual([
      exported[themeId],
      exported[themeId],
    ]);
    expect(document.documentElement.dataset.theme).toBe(themeId);
  });

  it.each(darkCases)("暗色主题 %s 写入实测底色", async (themeId) => {
    setStoredTheme("dark", "light", themeId);
    const { THEME_COLORS: exported } = await freshModule();

    expect(metaContents()).toEqual([
      exported[themeId],
      exported[themeId],
    ]);
    expect(document.documentElement.dataset.theme).toBe(themeId);
  });

  it("运行时切换亮色主题会立刻改写两条 meta", async () => {
    setStoredTheme("light", "light", "dark");
    const mod = await freshModule();

    expect(metaContents()).toEqual([
      THEME_COLORS.light,
      THEME_COLORS.light,
    ]);

    mod.setLightTheme("leaf");
    expect(metaContents()).toEqual([THEME_COLORS.leaf, THEME_COLORS.leaf]);

    mod.setLightTheme("stone");
    expect(metaContents()).toEqual([THEME_COLORS.stone, THEME_COLORS.stone]);
  });
});

describe("jsdom 没有真实样式时的兜底", () => {
  it("computed style 全透明时不写空值，退回 THEME_COLORS", async () => {
    setStoredTheme("light", "stone", "dark");
    const transparent = {
      getPropertyValue: () => "",
      backgroundColor: "rgba(0, 0, 0, 0)",
    } as unknown as CSSStyleDeclaration;
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transparent);

    await freshModule();

    expect(metaContents()).toEqual([
      THEME_COLORS.stone,
      THEME_COLORS.stone,
    ]);
    expect(metaContents()).not.toContain("");
  });

  it("有 canvas 时以 computed 值为准，而不是 THEME_COLORS", async () => {
    setStoredTheme("light", "light", "dark");

    // 模拟 Chromium 返回的 oklch token 经 canvas 栅格化 → rgb(1,2,3)
    vi.stubGlobal("CanvasRenderingContext2D", class {});
    const fakeCtx = {
      fillStyle: "",
      clearRect: () => {},
      fillRect: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }),
    };
    HTMLCanvasElement.prototype.getContext = (() =>
      fakeCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const computed = {
      getPropertyValue: (property: string) =>
        property === "--background" ? "oklch(0.9702 0 0)" : "",
      backgroundColor: "rgba(0, 0, 0, 0)",
    } as unknown as CSSStyleDeclaration;
    vi.spyOn(window, "getComputedStyle").mockReturnValue(computed);

    await freshModule();

    expect(metaContents()).toEqual(["#010203", "#010203"]);
  });
});
