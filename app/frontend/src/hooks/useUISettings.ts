import { useCallback, useSyncExternalStore } from "react";
import type { ContentType } from "@/types/api";

export type CardImageSize = "none" | "small" | "large";
export type ScrollReadOverride = "inherit" | "on" | "off";
export type ViewFlags = Record<ContentType, boolean>;
export type ViewScrollRead = Record<ContentType, ScrollReadOverride>;

interface UISettings {
  feedColWidth: number;
  entryColWidth: number;
  sidebarVisible: boolean;
  /** 列表卡片的缩略图档位（对齐 Nextflux 的卡片图尺寸） */
  cardImageSize: CardImageSize;
  /** 卡片摘要显示行数，0 = 不显示摘要 */
  cardPreviewLines: number;
  /** 正文排版（本地偏好，不进后端设置） */
  entryFontFamily: string;
  entryFontSize: number;
  entryLineHeight: number;
  /** 社交媒体视图里，条目正文过短（只给摘要）时是否自动抓正文 */
  fetchReadableByView: ViewFlags;
  /** 按视图覆盖「滚动标已读」；inherit = 跟随通用设置 */
  scrollReadByView: ViewScrollRead;
}

const STORAGE_KEY = "gist-ui-settings";

export const defaultUISettings: UISettings = {
  feedColWidth: 256,
  entryColWidth: 356,
  sidebarVisible: true,
  cardImageSize: "small",
  cardPreviewLines: 2,
  entryFontFamily: "",
  entryFontSize: 17,
  entryLineHeight: 1.8,
  fetchReadableByView: {
    article: false,
    picture: false,
    notification: false,
    social: false,
  },
  scrollReadByView: {
    article: "inherit",
    picture: "inherit",
    notification: "inherit",
    social: "inherit",
  },
};

function getStoredSettings(): UISettings {
  if (typeof window === "undefined") return defaultUISettings;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...defaultUISettings, ...JSON.parse(stored) };
    }
  } catch {
    // ignore parse errors
  }
  return defaultUISettings;
}

let cachedSettings: UISettings = getStoredSettings();
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function getUISettings(): UISettings {
  return cachedSettings;
}

export function hasSidebarVisibilitySetting(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return "sidebarVisible" in parsed;
    }
  } catch {
    // ignore parse errors
  }
  return false;
}

export function setUISetting<K extends keyof UISettings>(
  key: K,
  value: UISettings[K],
): void {
  cachedSettings = { ...cachedSettings, [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedSettings));
  } catch {
    // ignore storage errors
  }
  emitChange();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): UISettings {
  return cachedSettings;
}

export function useUISettings(): UISettings {
  return useSyncExternalStore(subscribe, getSnapshot, () => defaultUISettings);
}

export function useUISettingKey<K extends keyof UISettings>(
  key: K,
): UISettings[K] {
  const settings = useUISettings();
  return settings[key];
}

export function useUISettingActions() {
  const setFeedColWidth = useCallback((width: number) => {
    setUISetting("feedColWidth", width);
  }, []);

  const setEntryColWidth = useCallback((width: number) => {
    setUISetting("entryColWidth", width);
  }, []);

  const setSidebarVisible = useCallback((visible: boolean) => {
    setUISetting("sidebarVisible", visible);
  }, []);

  const setCardImageSize = useCallback((size: CardImageSize) => {
    setUISetting("cardImageSize", size);
  }, []);

  const setCardPreviewLines = useCallback((lines: number) => {
    setUISetting("cardPreviewLines", lines);
  }, []);

  const setEntryFontFamily = useCallback((family: string) => {
    setUISetting("entryFontFamily", family);
  }, []);

  const setEntryFontSize = useCallback((size: number) => {
    setUISetting("entryFontSize", size);
  }, []);

  const setEntryLineHeight = useCallback((height: number) => {
    setUISetting("entryLineHeight", height);
  }, []);

  const setFetchReadableForView = useCallback(
    (view: ContentType, enabled: boolean) => {
      setUISetting("fetchReadableByView", {
        ...getUISettings().fetchReadableByView,
        [view]: enabled,
      });
    },
    [],
  );

  const setScrollReadForView = useCallback(
    (view: ContentType, value: ScrollReadOverride) => {
      setUISetting("scrollReadByView", {
        ...getUISettings().scrollReadByView,
        [view]: value,
      });
    },
    [],
  );

  const toggleSidebarVisible = useCallback(() => {
    const current = getUISettings().sidebarVisible;
    setUISetting("sidebarVisible", !current);
  }, []);

  const resetToDefaults = useCallback(() => {
    for (const [key, value] of Object.entries(defaultUISettings)) {
      setUISetting(key as keyof UISettings, value as never);
    }
  }, []);

  return {
    setFeedColWidth,
    setEntryColWidth,
    setSidebarVisible,
    toggleSidebarVisible,
    setCardImageSize,
    setCardPreviewLines,
    setEntryFontFamily,
    setEntryFontSize,
    setEntryLineHeight,
    setFetchReadableForView,
    setScrollReadForView,
    resetToDefaults,
  };
}
