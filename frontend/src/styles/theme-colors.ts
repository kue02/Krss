/**
 * 各配色主题「用户看到的那片底色」的单一来源。
 *
 * 取值不是肉眼估的：2026-11-22 在 Chromium（390×844，HeroUI v3.2.5）里逐个主题
 * 渲染后，把 `getComputedStyle(<html>).getPropertyValue("--background")` 的
 * oklch/rgb 计算值用 canvas 栅格化成 sRGB 得到的 hex。
 *   - light / dark 走 @heroui/styles 的默认 token（oklch）
 *   - stone / leaf / nord-dark 走 src/styles/theme-tokens.css 的覆写
 *
 * 消费方：
 *   1. src/hooks/useTheme.ts —— 运行时读 --background 写 theme-color meta，读不到时用这里兜底
 *   2. vite.config.ts —— PWA manifest 的 theme_color / background_color
 *   3. index.html —— 首屏没有 JS 计算机会，只能保留一份数值一致的字面量 + 注释指回这里
 *
 * 改主题 token（--background）时必须同步这三个地方，否则首屏/状态栏又会和页面底色漂移。
 */
export const THEME_COLORS: Record<string, string> = {
  light: "#F5F5F5",
  stone: "#E3E0DB",
  leaf: "#DFE7E1",
  dark: "#060607",
  "nord-dark": "#242933",
};

/** PWA manifest 只能写一个静态底色：默认亮色主题（安装闪屏用）。 */
export const DEFAULT_LIGHT_THEME_COLOR = THEME_COLORS.light;