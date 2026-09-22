import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

describe("iOS PWA metadata", () => {
  it("keeps the iOS 27 PWA viewport inside the system safe area", () => {
    expect(indexHtml).toContain("viewport-fit=contain");
    expect(indexHtml).not.toContain("viewport-fit=cover");
    expect(indexHtml).toContain(
      'name="apple-mobile-web-app-status-bar-style" content="default"',
    );
    expect(indexHtml).not.toContain('content="black-translucent"');
  });

  it("provides matching light and dark colors before the app loads", () => {
    expect(indexHtml).toContain('name="color-scheme" content="light dark"');
    // 与 Nextflux 的底色对齐（亮 #E3E1DE / 暗 #242933），避免首屏与安装后的状态栏串色
    expect(indexHtml).toContain('content="#E3E1DE"');
    expect(indexHtml).toContain('content="#242933"');
    expect(indexHtml).toContain("background-color: #242933");
    expect(indexHtml).toContain("background-color: #e3e1de");
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
