import { useCallback, useEffect, useSyncExternalStore } from "react";

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

const MODE_KEY = "gist-theme";
const LIGHT_KEY = "gist-light-theme";
const DARK_KEY = "gist-dark-theme";

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
  try {
    const mode = localStorage.getItem(MODE_KEY);
    const light = localStorage.getItem(LIGHT_KEY);
    const dark = localStorage.getItem(DARK_KEY);
    return {
      mode: isMode(mode) ? mode : "system",
      lightTheme: isLightTheme(light) ? light : "light",
      darkTheme: isDarkTheme(dark) ? dark : "dark",
    };
  } catch {
    return fallback;
  }
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

function applyTheme(config: ThemeConfig) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const isDark =
    config.mode === "dark" || (config.mode === "system" && prefersDark());
  const themeId = isDark ? config.darkTheme : config.lightTheme;

  root.classList.toggle("dark", isDark);
  root.classList.toggle("light", !isDark);
  root.dataset.theme = themeId;
}

function persist(config: ThemeConfig) {
  try {
    localStorage.setItem(MODE_KEY, config.mode);
    localStorage.setItem(LIGHT_KEY, config.lightTheme);
    localStorage.setItem(DARK_KEY, config.darkTheme);
  } catch {
    // ignore storage errors
  }
}

function update(patch: Partial<ThemeConfig>) {
  cached = { ...cached, ...patch };
  persist(cached);
  applyTheme(cached);
  emitChange();
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
