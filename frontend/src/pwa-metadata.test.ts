import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

describe("iOS PWA metadata", () => {
  it("uses viewport-fit=cover so the app can paint into the iOS safe area", () => {
    expect(indexHtml).toContain("viewport-fit=cover");
    expect(indexHtml).not.toContain("viewport-fit=contain");
    expect(indexHtml).toContain(
      'name="apple-mobile-web-app-status-bar-style" content="default"',
    );
    expect(indexHtml).not.toContain('content="black-translucent"');
  });

  it("provides matching light and dark colors before the app loads", () => {
    expect(indexHtml).toContain('name="color-scheme" content="light dark"');
    // 值 = 浏览器实测的各主题 --background 计算色（来源 src/styles/theme-colors.ts），
    // 保证首屏、theme-color 与实际页面底色一致，避免状态栏串色
    expect(indexHtml).toContain('content="#F5F5F5"');
    expect(indexHtml).toContain('content="#060607"');
    expect(indexHtml).toContain("background-color: #060607");
    expect(indexHtml).toContain("background-color: #f5f5f5");
  });

  it("applies the stored theme palette before the app loads", () => {
    // 首屏内联脚本要能读出「亮/暗各选一套」的配色，并把 data-theme 指向具体主题
    // 键名 krss-*（改名清理后不留老键兼容）
    expect(indexHtml).toContain('localStorage.getItem("krss-theme")');
    expect(indexHtml).toContain('localStorage.getItem("krss-light-theme")');
    expect(indexHtml).toContain('localStorage.getItem("krss-dark-theme")');
    expect(indexHtml).not.toContain("gist-");
    expect(indexHtml).toContain(
      'root.dataset.theme = isDark ? darkTheme : lightTheme',
    );
    expect(indexHtml).toContain('root.classList.toggle("dark", isDark)');
  });
});
