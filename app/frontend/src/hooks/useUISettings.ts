import { useCallback, useSyncExternalStore } from "react";
import type { ContentType } from "@/types/api";
import type { ScrollMarkReadTiming } from "@/components/entry-list/useScrollMarkRead";

export type CardImageSize = "none" | "small" | "large";
export type ScrollReadOverride = "inherit" | "on" | "off";
export type ScrollReadMode = "off" | "on" | "perView";
export type ViewFlags = Record<ContentType, boolean>;
export type ViewScrollRead = Record<ContentType, ScrollReadOverride>;
export type QuoteStyle = "block" | "divider" | "card";

interface UISettings {
  feedColWidth: number;
  entryColWidth: number;
  sidebarVisible: boolean;
  /**
   * 图片视图的排布：masonry = 瀑布流（按原图比例，默认）/ grid = 等高正方格（对齐整齐）。
   * 用户 2026-09-17 要求加这一档。
   */
  pictureLayout: "masonry" | "grid";
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
  /** 社交媒体视图里，长贴是否默认展开（不折叠） */
  expandLongByView: ViewFlags;
  /**
   * 第一栏（订阅栏）与第二栏之间那条分界限，在哪些视图里显示。
   * 用户 2026-09-18 要求：可以按视图关掉（例如图片/社交媒体视图里不显示）。
   * 默认全开 = 与改之前完全一致。
   */
  splitterVisibleByView: ViewFlags;
  /** 减少动态效果：涟漪、过渡、折叠动画一律压到最短（系统 prefers-reduced-motion 也会自动生效） */
  reduceMotion: boolean;
  /**
   * 引文（引用推文）的呈现：
   *   block   = 强调色竖线 + 淡底（默认，我们原来的样子）
   *   divider = Folo 那样一条很浅的分割线
   *   card    = 卡片（描边 + 圆角 + 淡底 + 轻阴影，用户 2026-09-18 要求新增）
   */
  quoteStyle: QuoteStyle;
  /**
   * 正文代码块是否显示行号（Nextflux 也有这个开关，但它默认关）。
   * 用户 2026-09-17 明确要「代码块显示行号」，所以这里默认开；不想要的去 外观 → 阅读 关掉。
   */
  showLineNumbers: boolean;
  /** 界面整体缩放：改的是 rem 基准字号，1 = 标准（对应 16px） */
  uiScale: number;
  /**
   * 「滚动标已读」的总开关形态（2026-09-17 收口，用户要求）：
   * off = 全关（各视图的「已读判定」不再生效）；on = 全开；perView = 允许下面按视图覆盖。
   * 未设置时按既有数据推导（见 hooks/useScrollReadSetting.ts），老用户行为不变。
   */
  scrollReadMode?: ScrollReadMode;
  /** 按视图覆盖「滚动标已读」；inherit = 跟随通用设置（仅 perView 模式下生效） */
  scrollReadByView: ViewScrollRead;
  /** 已读判定时机：scrollPast = 滚出顶部（默认）；onVisible = 看到即已读（Folo 语义） */
  scrollReadTimingByView: Record<ContentType, ScrollMarkReadTiming>;
}

const STORAGE_KEY = "gist-ui-settings";

export const defaultUISettings: UISettings = {
  feedColWidth: 256,
  entryColWidth: 336,
  sidebarVisible: true,
  pictureLayout: "masonry",
  cardImageSize: "small",
  cardPreviewLines: 2,
  entryFontFamily: "",
  entryFontSize: 16,
  entryLineHeight: 1.8,
  fetchReadableByView: {
    article: false,
    picture: false,
    notification: false,
    social: false,
  },
  expandLongByView: {
    article: false,
    picture: false,
    notification: false,
    social: false,
  },
  splitterVisibleByView: {
    article: true,
    picture: true,
    notification: true,
    social: true,
  },
  reduceMotion: false,
  quoteStyle: "block",
  showLineNumbers: true,
  uiScale: 1,
  scrollReadTimingByView: {
    article: "scrollPast",
    picture: "scrollPast",
    notification: "scrollPast",
    social: "scrollPast",
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

  const setPictureLayout = useCallback((layout: "masonry" | "grid") => {
    setUISetting("pictureLayout", layout);
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

  const setShowLineNumbers = useCallback((enabled: boolean) => {
    setUISetting("showLineNumbers", enabled);
  }, []);

  const setReduceMotion = useCallback((enabled: boolean) => {
    setUISetting("reduceMotion", enabled);
  }, []);

  const setUiScale = useCallback((scale: number) => {
    setUISetting("uiScale", scale);
  }, []);

  const setExpandLongForView = useCallback(
    (view: ContentType, enabled: boolean) => {
      setUISetting("expandLongByView", {
        ...getUISettings().expandLongByView,
        [view]: enabled,
      });
    },
    [],
  );

  const setQuoteStyle = useCallback(
    (style: QuoteStyle) => {
      setUISetting("quoteStyle", style);
    },
    [setUISetting],
  );

  const setSplitterVisibleForView = useCallback(
    (view: ContentType, visible: boolean) => {
      setUISetting("splitterVisibleByView", {
        ...getUISettings().splitterVisibleByView,
        [view]: visible,
      });
    },
    [],
  );

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

  const setScrollReadTimingForView = useCallback(
    (view: ContentType, timing: ScrollMarkReadTiming) => {
      setUISetting("scrollReadTimingByView", {
        ...getUISettings().scrollReadTimingByView,
        [view]: timing,
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
    setPictureLayout,
    setCardPreviewLines,
    setEntryFontFamily,
    setEntryFontSize,
    setEntryLineHeight,
    setFetchReadableForView,
    setExpandLongForView,
    setSplitterVisibleForView,
    setReduceMotion,
    setShowLineNumbers,
    setUiScale,
    setQuoteStyle,
    setScrollReadForView,
    setScrollReadTimingForView,
    resetToDefaults,
  };
}

/** 把「界面字号」落到 <html> 的基准字号上（页面全是 rem，一改就整体缩放） */
export function applyUiScaleToDocument(scale: number): void {
  if (typeof document === "undefined") return;
  const safe = Number.isFinite(scale) && scale > 0.5 && scale < 2 ? scale : 1;
  document.documentElement.style.fontSize = `${16 * safe}px`;
}

/** 把「引文样式」落到 <html data-quote-style> 上，供 CSS 统一处理（正文与时间线卡片共用） */
export function applyQuoteStyleToDocument(style: QuoteStyle): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-quote-style", style);
}

/** 把「减少动态效果」开关落到 <html data-reduce-motion> 上，供 CSS 统一处理 */
export function applyReduceMotionToDocument(enabled: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(
    "data-reduce-motion",
    enabled ? "true" : "false",
  );
}
