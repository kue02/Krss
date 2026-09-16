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
    expect(indexHtml).toContain('content="#FFFFFF"');
    expect(indexHtml).toContain('content="#09090B"');
    expect(indexHtml).toContain("background-color: #09090b");
  });

  it("applies the stored theme palette before the app loads", () => {
    // 首屏内联脚本要能读出「亮/暗各选一套」的配色，并把 data-theme 指向具体主题
    expect(indexHtml).toContain('localStorage.getItem("gist-theme")');
    expect(indexHtml).toContain('localStorage.getItem("gist-light-theme")');
    expect(indexHtml).toContain('localStorage.getItem("gist-dark-theme")');
    expect(indexHtml).toContain(
      'root.dataset.theme = isDark ? darkTheme : lightTheme',
    );
    expect(indexHtml).toContain('root.classList.toggle("dark", isDark)');
  });
});
