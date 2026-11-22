import { useCallback, useEffect, useSyncExternalStore } from "react";
import { LS_KEYS, readLocalValue, writeLocalValue } from "@/lib/settings-storage";
import { registerSettingsGroup, scheduleSettingsFlush } from "@/lib/settings-sync";
import { THEME_COLORS } from "@/styles/theme-colors";

/**
 * 主题系统（Nextflux 皮肤）
 *
 * 模式：light / dark / system
 * 亮色主题：light(白色) / stone(石灰) / leaf
 * 暗色主题：dark(黑色) / nord-dark(深蓝)
 *
 * 落地方式：<html class="light|dark" data-theme="<主题 id>">
 *   - class 承载 light/dark 语义（HeroUI 与 Tailwind 的 dark: 变体都读它）
 *   - data-theme 指向具体配色（明暗各选一套），token 定义见 src/styles/theme-tokens.css
 */

export type Theme = "light" | "dark" | "system";
export type ThemeId = "light" | "stone" | "leaf" | "dark" | "nord-dark";
export type LightThemeId = "light" | "stone" | "leaf";
export type DarkThemeId = "dark" | "nord-dark";

export interface ThemeOption {
  id: ThemeId;
  name: string;
  color: string;
}

export const themes: { light: ThemeOption[]; dark: ThemeOption[] } = {
  light: [
    { id: "light", name: "白色", color: "#ffffff" },
    { id: "stone", name: "石灰", color: "#F3F1ED" },
    { id: "leaf", name: "leaf", color: "#c8e6c9" },
  ],
  dark: [
    { id: "dark", name: "黑色", color: "#1E1E1E" },
    { id: "nord-dark", name: "深蓝", color: "#4c566a" },
  ],
};

const MODE_SPEC = LS_KEYS.theme;
const LIGHT_SPEC = LS_KEYS.lightTheme;
const DARK_SPEC = LS_KEYS.darkTheme;

interface ThemeConfig {
  mode: Theme;
  lightTheme: LightThemeId;
  darkTheme: DarkThemeId;
}

const isMode = (value: string | null): value is Theme =>
  value === "light" || value === "dark" || value === "system";

const isLightTheme = (value: string | null): value is LightThemeId =>
  themes.light.some((item) => item.id === value);

const isDarkTheme = (value: string | null): value is DarkThemeId =>
  themes.dark.some((item) => item.id === value);

function readStored(): ThemeConfig {
  const fallback: ThemeConfig = {
    mode: "system",
    lightTheme: "light",
    darkTheme: "dark",
  };
  if (typeof window === "undefined") return fallback;

  // 本地缓存键名见 LS_KEYS（改名清理后只有 krss-*）
  const mode = readLocalValue(MODE_SPEC);
  const light = readLocalValue(LIGHT_SPEC);
  const dark = readLocalValue(DARK_SPEC);
  return {
    mode: isMode(mode) ? mode : "system",
    lightTheme: isLightTheme(light) ? light : "light",
    darkTheme: isDarkTheme(dark) ? dark : "dark",
  };
}

let cached: ThemeConfig = readStored();
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/**
 * 运行时从浏览器读「用户看到的那片底色」，不再维护第二份颜色表：
 * 先读 <html> 的 --background token（主题切换是瞬时的，不受 background-color 过渡影响），
 * 再用 1×1 canvas 栅格化成 sRGB —— HeroUI 的 token 是 oklch，getComputedStyle 在
 * Chromium 里会原样返回 oklch(...)，不能直接写进 meta。
 * 读不到（jsdom 没有 canvas / 样式未就绪 / 透明）时退回 THEME_COLORS（实测值，见
 * src/styles/theme-colors.ts）。
 */
const TRANSPARENT_COLORS = new Set([
  "",
  "transparent",
  "rgba(0, 0, 0, 0)",
  "rgba(0,0,0,0)",
]);

function cssColorToHex(color: string): string | null {
  const value = color.trim();
  if (!value || TRANSPARENT_COLORS.has(value.toLowerCase())) return null;
  // jsdom 没有 CanvasRenderingContext2D；用类型存在性守卫，
  // 避免测试里调用 getContext 刷 "not implemented" 噪声。
  if (
    typeof document === "undefined" ||
    typeof CanvasRenderingContext2D === "undefined"
  ) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  const r = data[0] ?? 0;
  const g = data[1] ?? 0;
  const b = data[2] ?? 0;
  const a = data[3] ?? 0;
  if (a === 0) return null;
  return `#${[r, g, b]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function readThemeColor(): string | null {
  if (
    typeof document === "undefined" ||
    typeof window === "undefined" ||
    typeof window.getComputedStyle !== "function"
  ) {
    return null;
  }

  const root = document.documentElement;
  const token = window.getComputedStyle(root).getPropertyValue("--background");
  const fromToken = cssColorToHex(token);
  if (fromToken) return fromToken;

  // token 读不到时退一步：读真正铺满屏幕的那几层（顺序 = 实际绘制层级）
  for (const layer of [
    document.querySelector(".app-shell"),
    document.body,
    root,
  ]) {
    if (!layer) continue;
    const fromLayer = cssColorToHex(
      window.getComputedStyle(layer).backgroundColor,
    );
    if (fromLayer) return fromLayer;
  }
  return null;
}

let themeColorFrame: number | null = null;

function writeThemeColor(color: string): void {
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => {
      meta.content = color;
    });
}

function applyThemeColor(themeId: string): void {
  const write = () => {
    const color = readThemeColor() ?? THEME_COLORS[themeId];
    if (color) writeThemeColor(color);
  };

  // 先同步写一次（data-theme 已设好，getComputedStyle 会强制重算）；
  // 下一帧再补一次：首帧 CSS 尚未注入时读不到 --background，下一帧就能读到。
  write();
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    if (themeColorFrame !== null) window.cancelAnimationFrame(themeColorFrame);
    themeColorFrame = window.requestAnimationFrame(() => {
      themeColorFrame = null;
      if (document.documentElement.dataset.theme !== themeId) return;
      write();
    });
  }
}

function applyTheme(config: ThemeConfig) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const isDark =
    config.mode === "dark" || (config.mode === "system" && prefersDark());
  const themeId = isDark ? config.darkTheme : config.lightTheme;

  root.classList.toggle("dark", isDark);
  root.classList.toggle("light", !isDark);
  root.dataset.theme = themeId;

  // PWA 状态栏/主屏图标底色跟随当前配色，而不是只跟亮暗
  applyThemeColor(themeId);
}

export { THEME_COLORS };

function persist(config: ThemeConfig) {
  writeLocalValue(MODE_SPEC, config.mode);
  writeLocalValue(LIGHT_SPEC, config.lightTheme);
  writeLocalValue(DARK_SPEC, config.darkTheme);
}

function update(patch: Partial<ThemeConfig>) {
  cached = { ...cached, ...patch };
  persist(cached);
  applyTheme(cached);
  emitChange();
  // 21 批：主题也进服务端（跨设备一致），防抖后写
  scheduleSettingsFlush("ui.theme");
}

export function setTheme(mode: Theme): void {
  update({ mode });
}

export function setLightTheme(lightTheme: LightThemeId): void {
  update({ lightTheme });
}

export function setDarkTheme(darkTheme: DarkThemeId): void {
  update({ darkTheme });
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): ThemeConfig {
  return cached;
}

const serverSnapshot: ThemeConfig = {
  mode: "system",
  lightTheme: "light",
  darkTheme: "dark",
};

function getServerSnapshot(): ThemeConfig {
  return serverSnapshot;
}

export function useTheme() {
  const config = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  useEffect(() => {
    // Apply theme on mount
    applyTheme(config);

    // Listen for system theme changes
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (cached.mode === "system") {
        applyTheme(cached);
      }
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [config]);

  const setThemeValue = useCallback((mode: Theme) => setTheme(mode), []);
  const setLightThemeValue = useCallback(
    (id: LightThemeId) => setLightTheme(id),
    [],
  );
  const setDarkThemeValue = useCallback(
    (id: DarkThemeId) => setDarkTheme(id),
    [],
  );

  return {
    theme: config.mode,
    setTheme: setThemeValue,
    lightTheme: config.lightTheme,
    setLightTheme: setLightThemeValue,
    darkTheme: config.darkTheme,
    setDarkTheme: setDarkThemeValue,
  };
}

// Initialize theme on load
if (typeof window !== "undefined") {
  applyTheme(cached);
}

// ---------- 21 批：注册「主题」同步组 ----------

/**
 * 服务端那份主题覆盖本地（只在登录后首次拉取时走）。
 * 三档值各过一遍枚举校验：服务端/导入文件里的野值不许把界面带到「不存在的主题」上。
 */
export function applyThemeFromServer(value: {
  mode: string;
  lightTheme: string;
  darkTheme: string;
}): void {
  const mode: Theme = isMode(value.mode) ? value.mode : cached.mode;
  const lightTheme: LightThemeId = isLightTheme(value.lightTheme)
    ? value.lightTheme
    : cached.lightTheme;
  const darkTheme: DarkThemeId = isDarkTheme(value.darkTheme)
    ? value.darkTheme
    : cached.darkTheme;

  cached = { mode, lightTheme, darkTheme };
  persist(cached);
  applyTheme(cached);
  emitChange();
}

registerSettingsGroup({
  key: "ui.theme",
  read: () => ({
    mode: cached.mode,
    lightTheme: cached.lightTheme,
    darkTheme: cached.darkTheme,
  }),
  apply: (value) => applyThemeFromServer(value),
});
