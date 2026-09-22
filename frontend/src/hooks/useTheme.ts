import { useCallback, useEffect, useSyncExternalStore } from "react";
import { LS_KEYS, readLocalValue, writeLocalValue } from "@/lib/settings-storage";
import { registerSettingsGroup, scheduleSettingsFlush } from "@/lib/settings-sync";

/**
 * 主题系统（Nextflux 皮肤）
 *
 * 模式：light / dark / system
 * 亮色主题：light(白色) / stone(石灰) / leaf
 * 暗色主题：dark(黑色) / nord-dark(深蓝)
 *
 * 落地方式：<html class="light|dark" data-theme="<主题 id>">
 *   - class 承载 light/dark 语义（HeroUI 与 Tailwind 的 dark: 变体都读它）
 *   - data-theme 指向具体配色（明暗各选一套），token 定义见 src/styles/nextflux-theme.css
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
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** 各配色主题的首屏/状态栏底色（与 index.html 里内联的取值保持一致） */
const THEME_COLORS: Record<string, string> = {
  light: "#E3E1DE",
  stone: "#E3E1DE",
  leaf: "#DFE7E1",
  dark: "#242933",
  "nord-dark": "#242933",
};

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
  const themeColor = THEME_COLORS[themeId];
  if (themeColor) {
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => {
        meta.content = themeColor;
      });
  }
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
