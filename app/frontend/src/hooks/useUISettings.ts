import { useCallback, useSyncExternalStore } from "react";
import { notifySettingsSaved } from "@/lib/settings-saved";
import type { ContentType } from "@/types/api";
import type { ScrollMarkReadTiming } from "@/components/entry-list/useScrollMarkRead";

export type CardImageSize = "none" | "small" | "large";
export type ScrollReadOverride = "inherit" | "on" | "off";
export type ScrollReadMode = "off" | "on" | "perView";
export type ViewFlags = Record<ContentType, boolean>;
export type ViewScrollRead = Record<ContentType, ScrollReadOverride>;
export type QuoteStyle = "block" | "divider" | "card";
/**
 * 已读/未读的全局统一标记（用户 11-14）：
 *   badge = HeroUI `Badge` 角标（**用户拍板的默认**）
 *   dot   = 小圆点（原来只有社交媒体视图有）
 *   dim   = 已读变灰（原来只有其它视图有）
 * 三种都同时作用于所有视图 —— 用户原话：「需要做成可切换的全局统一样式」。
 */
/**
 * 12-18 圆角档位 —— 值直接照 HeroUI 官方刻度：
 * `--radius: 0.5rem` = 8px，`xs/sm/md/lg/xl` = 0.25/0.5/0.75/1/1.5 倍 ⇒ 2/4/6/8/12px。
 * `default` = 不动 HeroUI 自己的圆角（默认值，保证行为零变化）；`full` = 全圆。
 */
export type RadiusPreset =
  | "default"
  | "none"
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "xl"
  | "full";

/** 档位 → CSS 值；`default` 返回 null（表示「跟随 HeroUI」，要把属性摘掉） */
export function radiusPresetToCss(preset: RadiusPreset): string | null {
  switch (preset) {
    case "none":
      return "0px";
    case "xs":
      return "2px";
    case "sm":
      return "4px";
    case "md":
      return "6px";
    case "lg":
      return "8px";
    case "xl":
      return "12px";
    case "full":
      return "9999px";
    default:
      return null;
  }
}

/**
 * 13-3：未读角标的可自定义项 —— **每一项都直接对应 HeroUI `Badge` 的一个官方 prop**，不自己造。
 * 取值域从 HeroUI 的样式产物里点清：placement 四档 / color 五档（accent·danger·success·warning·default）
 * / size sm·md·lg / variant primary·secondary·soft。
 *
 * 用户 2026-09-18 的裁定：「小圆点那个和角标合并，但是小圆角是设置成默认的，是一个单独的样式，不变的」
 * —— 所以 `content: "dot"` 就是**默认档**，且它保持今天这套固定外观（8px、跟随主题色、压边 2px），
 * 不吃面板里的位置/大小/颜色/外观（那几项只作用于「未读数 / 图标」两档，选圆点时置灰并给出提示）。
 */
export interface UnreadBadgeConfig {
  /** 内容：圆点（默认，固定外观）/ 未读数 / 图标 */
  content: "dot" | "count" | "icon";
  /** 位置（HeroUI `placement` 四档） */
  placement: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** 大小（px，6–16） */
  size: number;
  /** 颜色是否跟随主题色（`--accent`）；关掉才用 color / customColor */
  followAccent: boolean;
  /** HeroUI 官方色档 */
  color: "accent" | "danger" | "success" | "warning" | "default";
  /** 自定义颜色（写入 `--accent` 那种做法，仅 followAccent=false 时生效） */
  customColor: string | null;
  /** 外观（HeroUI `variant`） */
  variant: "primary" | "secondary" | "soft";
  /** 压住图标边缘的额外偏移（px，0–6；HeroUI 自带 4px，这里是叠加值） */
  offset: number;
}

/** 默认 = 今天的样子（12-14 定的那套：左上角、8px 小圆点、跟随主题色、压边 2px） */
export const DEFAULT_UNREAD_BADGE: UnreadBadgeConfig = {
  content: "dot",
  placement: "top-left",
  size: 8,
  followAccent: true,
  color: "accent",
  customColor: null,
  variant: "primary",
  offset: 4,
};

export type UnreadStyle = "badge" | "dot" | "dim";
/**
 * 第一栏（侧栏）订阅行的外观（用户 11-12）：
 *   default       = 现在这样，只有订阅名
 *   name_and_site = 名称 + @源站（悬浮源站可点，直接开主页）
 */
export type SidebarFeedAppearance = "default" | "name_and_site";

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
  /** 12-18：按钮圆角（HeroUI 刻度档位；default = 跟随 HeroUI） */
  buttonRadius: RadiusPreset;
  /** 12-18：订阅图标圆角（同上，与按钮分开设置） */
  iconRadius: RadiusPreset;
  /** 已读/未读的标记样式（全局统一，见 UnreadStyle） */
  unreadStyle: UnreadStyle;
  /** 13-3：未读角标的外观配置（选「角标」档时生效） */
  unreadBadge: UnreadBadgeConfig;
  /** 第一栏订阅行的外观（默认只有名称；可切成「名称 + @源站」） */
  sidebarFeedAppearance: SidebarFeedAppearance;
  /**
   * 主题色（用户 11-13）：用户自选的强调色，`null` = 跟随当前主题（默认）。
   * 落地方式：在 `<html>` 上写内联的 `--accent` / `--accent-foreground` ——
   * 内联样式压过 `[data-theme=…]` 里各主题自带的那对值，所以明暗主题都跟着这个色走。
   */
  accentColor: string | null;
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
  unreadStyle: "badge",
  unreadBadge: DEFAULT_UNREAD_BADGE,
  buttonRadius: "default",
  iconRadius: "default",
  sidebarFeedAppearance: "default",
  accentColor: null,
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
  // 12-7：即时型改动给一句「已保存」（App 订阅事件、带防抖后弹 toast）
  notifySettingsSaved();
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

  const setSidebarFeedAppearance = useCallback(
    (appearance: SidebarFeedAppearance) => {
      setUISetting("sidebarFeedAppearance", appearance);
    },
    [setUISetting],
  );

  const setAccentColor = useCallback(
    (color: string | null) => {
      setUISetting("accentColor", color);
    },
    [setUISetting],
  );

  const setUnreadStyle = useCallback(
    (style: UnreadStyle) => {
      setUISetting("unreadStyle", style);
    },
    [setUISetting],
  );

  /** 13-3：只覆盖传进来的字段（面板里逐项改，不该互相踩） */
  const setUnreadBadge = useCallback((patch: Partial<UnreadBadgeConfig>) => {
    setUISetting("unreadBadge", {
      ...getUISettings().unreadBadge,
      ...patch,
    });
  }, []);

  const setButtonRadius = useCallback((preset: RadiusPreset) => {
    setUISetting("buttonRadius", preset);
  }, []);

  const setIconRadius = useCallback((preset: RadiusPreset) => {
    setUISetting("iconRadius", preset);
  }, []);

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
    setButtonRadius,
    setIconRadius,
    setUnreadBadge,
    setUnreadStyle,
    setAccentColor,
    setSidebarFeedAppearance,
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
/**
 * 把用户自选的主题色写到 `<html>` 的内联样式上；`null` = 清掉，回到当前主题自带的强调色。
 *
 * 顺带按亮度算一个 `--accent-foreground`：主题自带的强调色都配好了前景色（多为白），
 * 用户随手选个浅色（黄 / 淡青）时白字会糊在底上，这里按相对亮度在近黑 / 近白之间挑一个。
 */
const ACCENT_FOREGROUND_LIGHT = "rgb(255 255 255)";
const ACCENT_FOREGROUND_DARK = "rgb(17 17 17)";

export function accentForegroundFor(color: string): string {
  const hex = color.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return ACCENT_FOREGROUND_LIGHT;
  const channel = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  const r = channel(0);
  const g = channel(2);
  const b = channel(4);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.5 ? ACCENT_FOREGROUND_DARK : ACCENT_FOREGROUND_LIGHT;
}

export function applyAccentColorToDocument(color: string | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!color) {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-foreground");
    return;
  }
  root.style.setProperty("--accent", color);
  root.style.setProperty("--accent-foreground", accentForegroundFor(color));
}

export function applyQuoteStyleToDocument(style: QuoteStyle): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-quote-style", style);
}

/**
 * 12-18：把圆角落到 `<html>` 上 —— 属性 + 变量两件套。
 * 属性只在**显式设置**时加（`default` 时摘掉）⇒ 默认状态完全不碰 HeroUI 自己的圆角，行为零变化。
 * 索引里拿变量而不是写死，是为了让「按钮」「订阅图标」各自独立、又能被用户改。
 */
export function applyButtonRadiusToDocument(preset: RadiusPreset): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const css = radiusPresetToCss(preset);
  if (!css) {
    root.removeAttribute("data-button-radius");
    root.style.removeProperty("--ui-button-radius");
    return;
  }
  root.setAttribute("data-button-radius", preset);
  root.style.setProperty("--ui-button-radius", css);
}

export function applyIconRadiusToDocument(preset: RadiusPreset): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const css = radiusPresetToCss(preset);
  if (!css) {
    root.removeAttribute("data-icon-radius");
    root.style.removeProperty("--ui-icon-radius");
    return;
  }
  root.setAttribute("data-icon-radius", preset);
  root.style.setProperty("--ui-icon-radius", css);
}

/** 把「减少动态效果」开关落到 <html data-reduce-motion> 上，供 CSS 统一处理 */
export function applyReduceMotionToDocument(enabled: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(
    "data-reduce-motion",
    enabled ? "true" : "false",
  );
}
