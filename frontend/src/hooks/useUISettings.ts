import { useCallback, useSyncExternalStore } from "react";
import { notifySettingsSaved } from "@/lib/settings-saved";
import { LS_KEYS, readLocalValue, writeLocalValue } from "@/lib/settings-storage";
import {
  currentDeviceClass,
  registerSettingsGroup,
  scheduleSettingsFlush,
  type SettingsDeviceClass,
} from "@/lib/settings-sync";
import type { ContentType } from "@/types/api";
import type { ScrollMarkReadTiming } from "@/components/entry-list/useScrollMarkRead";
import type {
  TimelineCollapse,
  TimelineGranularity,
  TimelineTimeBasis,
} from "@/lib/timeline-model";

export type CardImageSize = "none" | "small" | "large";
export type ScrollReadOverride = "inherit" | "on" | "off";
export type ScrollReadMode = "off" | "on" | "perView";
export type ViewFlags = Record<ContentType, boolean>;
export type ViewScrollRead = Record<ContentType, ScrollReadOverride>;
/** 第十五批：通知视图时间线的两个按视图设置（粒度 / 折叠行数） */
export type ViewTimelineGranularity = Record<ContentType, TimelineGranularity>;
export type ViewTimelineCollapse = Record<ContentType, TimelineCollapse>;
/** 26-2：通知视图时间线的时间基准（发布时间 / 抓取时间），默认发布时间 = 现状 */
export type ViewTimelineTimeBasis = Record<ContentType, TimelineTimeBasis>;
export type QuoteStyle = "block" | "divider" | "card";
/**
 * 已读/未读的全局统一标记（用户 11-14）：
 *   badge = HeroUI `Badge` 角标（**用户拍板的默认**）
 *   dot   = 小圆点（原来只有社交媒体视图有）
 *   dim   = 已读变灰（原来只有其它视图有）
 * 三种都同时作用于所有视图 —— 用户原话：「需要做成可切换的全局统一样式」。
 */
/**
 * 18 批（圆角统一）：档位照 HeroUI 官方刻度，基准是 `--radius` 的 `.5rem`(8px) ——
 * 直角 0 · XS 2px(×.25) · SM 4px(×.5) · 默认 8px(×1) · LG 10px(×1.25) · XL 12px(×1.5) · 全圆。
 * `default` = **一个变量都不写**（把 `--radius` / `--field-radius` 摘掉）⇒ 回到 HeroUI 出厂值，行为零变化。
 */
export type RadiusPreset =
  | "default"
  | "none"
  | "xs"
  | "sm"
  | "lg"
  | "xl"
  | "full";

/** 档位 → CSS 值；`default` 返回 null（表示「跟随组件库」，要把变量摘掉） */
export function radiusPresetToCss(preset: RadiusPreset): string | null {
  switch (preset) {
    case "none":
      return "0px";
    case "xs":
      return "2px";
    case "sm":
      return "4px";
    case "lg":
      return "10px";
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
  /** 压住图标边缘的额外偏移（px，0–12；HeroUI 自带 4px，这里是叠加值） */
  offset: number;
}

/**
 * 「压住边缘」滑杆的上限（23-5：用户要更激进，原上限 6px 太保守）。
 * 12px 时角标已经能整块压进图标里（默认档圆点只有 8px），再大就没有可表达的差别了。
 */
export const MAX_UNREAD_BADGE_OFFSET = 12;

/** 默认 = 今天的样子（12-14 定的那套：左上角、8px 小圆点、跟随主题色、压边 2px） */
export const DEFAULT_UNREAD_BADGE: UnreadBadgeConfig = {
  content: "dot",
  placement: "top-left",
  size: 8,
  followAccent: true,
  color: "accent",
  customColor: null,
  variant: "primary",
  // 「压住边缘」= 角标压进图标里多少 px。21-1：默认 2 → 4（8px 圆点对半压边，
  // 之前 6px 悬空在外、看着像被切掉一半，保证完整显示；面板里可调回去）
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
  pictureLayout: "masonry" | "grid" | "hover";
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
   * 18 批：组件圆角 —— 直接写 HeroUI 自己的 `--radius`（按钮 / 卡片 / 浮层都读它）。
   * default = 把变量摘掉，回出厂 `.5rem`。
   */
  componentRadius: RadiusPreset;
  /**
   * 18 批：表单圆角 —— 写 HeroUI 的 `--field-radius`（输入框 / 下拉 / 搜索框读它）。
   * default = 跟随组件（HeroUI 出厂的 `calc(var(--radius) * 1.5)`），也就是什么都不写。
   */
  fieldRadius: RadiusPreset;
  /** 12-18：订阅图标圆角（用户要求与组件分开设置）；default = 跟随组件（各处既有的 3/4px） */
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
  /**
   * 20-3（用户 2026-09-18）：滚动标已读后，这些条目**不立刻**从「只看未读」列表里消失 ——
   * 边滚边消失会把下面的条目往上顶（往回滚时体验尤其差）。
   * 默认 true：推迟到「离开这个视图 / 换订阅再回来」时才摘掉；关掉就是原来的即时消失。
   */
  scrollReadDeferRemoval: boolean;
  /**
   * 第十五批（15-5）：通知视图时间线的**时间粒度**（只影响分组与节点标注，不重新请求数据）。
   * 放在 ByView 家族里是为了和「按视图设置」其他项同一套存储（只有 notification 会用到）。
   */
  timelineGranularityByView: ViewTimelineGranularity;
  /**
   * 第十五批（15-3/15-5）：通知视图卡片的**折叠行数**（1/2/3/全文），默认 2 行。
   * 注意：**没有「切回列表」这一项** —— 通知视图只有时间线这一种形态（用户定案）。
   */
  timelineCollapseByView: ViewTimelineCollapse;
  /**
   * 26-2：通知视图时间线的**时间基准**（发布时间 / 抓取时间），默认发布时间。
   * 放在 ByView 家族里是为了和「按视图设置」其他项同一套存储（只有 notification 会用到）。
   */
  timelineTimeBasisByView: ViewTimelineTimeBasis;
  /**
   * 窄栏自动合一栏（默认开）：时间线容器宽度 < 385px 时退化成单侧
   * （左时间列 + 右卡片），关掉则始终左右交替。
   */
  timelineSingleSideByView: ViewFlags;
}

/**
 * 21 批（2026-09-18）：设置搬到服务端后，localStorage 退化成**本地缓存** ——
 * 首屏照旧同步读它（不闪），服务端值拉回来再对账覆盖。
 */
const STORAGE_SPEC = LS_KEYS.uiSettings;

/**
 * **尺寸/布局类**：这些按设备分套存（桌面 / 手机各一份）。
 *
 * 用户拍板的理由：桌面 `feedColWidth=256`、`uiScale` 这类值同步到手机上直接没法用，
 * 所以「跨设备一致」只对共用那部分成立，尺寸类各设备自己一套。
 */
export const DEVICE_SCOPED_UI_KEYS = [
  "feedColWidth",
  "entryColWidth",
  "uiScale",
  "sidebarVisible",
] as const;

const DEVICE_SCOPED = new Set<string>(DEVICE_SCOPED_UI_KEYS);

/** 存储/同步的整包形状（与 `types/settings.ts` 的 UISettingsPackage 同形） */
export interface UISettingsPackageShape {
  shared: Record<string, unknown>;
  device: {
    desktop: Record<string, unknown>;
    mobile: Record<string, unknown>;
  };
}

/**
 * 不在 defaultUISettings 里、或默认值是 `null` 的键 —— 它们的值类型不可能从默认值推出来，
 * 必须在这里显式放行，否则会被下面的类型闸门当成「脏值」丢掉。
 *
 * `accentColor`（22-2 附带修）：默认值是 `null`，而实际值是 `"#RRGGBB"` —— 老写法拿
 * `typeof fallback`（`"object"`）比 `typeof value`（`"string"`），一律判为类型不符 ⇒ **每次加载
 * （localStorage 与 服务端两条路都过这里）都把主题色丢掉**，界面回到「跟随主题」。
 * 21 批之前是 `{...defaultUISettings, ...JSON.parse(stored)}` 直接合并，没这个闸门 —— 这是 21 批引入的回归。
 */
const OPTIONAL_UI_KEYS = new Set<string>(["scrollReadMode", "accentColor"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyPackage(): UISettingsPackageShape {
  return { shared: {}, device: { desktop: {}, mobile: {} } };
}

/** 认得的档位集合（用来丢弃老档位，如 18 批去掉的 `md` 6px） */
const RADIUS_PRESETS = new Set<string>([
  "default",
  "none",
  "xs",
  "sm",
  "lg",
  "xl",
  "full",
]);

/**
 * 收窄一个 bag：只留认识的键、类型对得上的值；对象型的项与默认值浅合并
 * （防止服务端/导入回来的半份配置把组件读成 undefined）。
 */
function sanitizeBag(input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) return {};

  const out: Record<string, unknown> = {};
  const defaults = defaultUISettings as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(input)) {
    const fallback = defaults[key];
    /**
     * 默认值是 `null` 的键（`accentColor`）**推不出类型** —— `typeof null === "object"`，
     * 拿它跟 `"#RRGGBB"`（string）比必然不符，老写法会把主题色直接丢掉（见 OPTIONAL_UI_KEYS 的说明）。
     * 这类键一律走下面的白名单，不参与类型比对。
     */
    if (fallback !== undefined && fallback !== null) {
      if (typeof value !== typeof fallback) continue;
      if (isPlainObject(fallback) && isPlainObject(value)) {
        out[key] = { ...fallback, ...value };
        continue;
      }
      out[key] = value;
      continue;
    }
    if (OPTIONAL_UI_KEYS.has(key) && typeof value === "string") {
      out[key] = value;
    }
  }

  // 18 批改键名：`buttonRadius` → `componentRadius`（语义从「只改 HeroUI 的按钮」升级成「组件圆角」）。
  // 老值原样搬过来、不丢用户设置；只在这里认一次老键，之后统一用新键。
  if (out.componentRadius === undefined && typeof input.buttonRadius === "string") {
    out.componentRadius = input.buttonRadius;
  }

  // 18 批换刻度后（去掉 md 6px）不认得的档位直接丢掉 ⇒ 回落默认档，
  // 免得下拉显示成「一个都不选中」那种说不清的状态。
  for (const key of ["componentRadius", "fieldRadius", "iconRadius"]) {
    if (typeof out[key] === "string" && !RADIUS_PRESETS.has(out[key] as string)) {
      delete out[key];
    }
  }

  return out;
}

function normalizePackage(input: unknown): UISettingsPackageShape | null {
  if (!isPlainObject(input)) return null;

  const device = isPlainObject(input.device) ? input.device : {};
  return {
    shared: sanitizeBag(input.shared),
    device: {
      desktop: sanitizeBag(device.desktop),
      mobile: sanitizeBag(device.mobile),
    },
  };
}

function readStoredPackage(): UISettingsPackageShape {
  if (typeof window === "undefined") return emptyPackage();

  try {
    const stored = readLocalValue(STORAGE_SPEC);
    if (!stored) return emptyPackage();

    const parsed: unknown = JSON.parse(stored);
    if (!isPlainObject(parsed)) return emptyPackage();

    // 只认新格式（{ shared, device }）；形状不对就丢掉走默认值，
    // 服务端那份拉回来会覆盖（改名清理后不留扁平格式兼容）。
    const pkg = normalizePackage(parsed) ?? emptyPackage();

    // 顺手把收窄后的形状写回去（下次启动就是干净的新格式）
    persistPackage(pkg);
    return pkg;
  } catch {
    return emptyPackage();
  }
}

function persistPackage(pkg: UISettingsPackageShape): void {
  writeLocalValue(STORAGE_SPEC, JSON.stringify(pkg));
}

function flatFromPackage(
  pkg: UISettingsPackageShape,
  device: SettingsDeviceClass,
): UISettings {
  const merged: Record<string, unknown> = {
    ...defaultUISettings,
    ...pkg.shared,
    ...pkg.device[device],
  };
  // sanitizeBag 已经保证「键认识、类型对」，这里只是把宽类型收回到 UISettings
  return merged as unknown as UISettings;
}

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
  componentRadius: "default",
  fieldRadius: "default",
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
  // 20-3：默认「不实时消失」（离开视图/换订阅回来才摘掉）
  scrollReadDeferRemoval: true,
  // 第十五批：通知视图时间线 —— 默认「每小时」+ 折叠 2 行（都是用户拍板的默认档）
  timelineGranularityByView: {
    article: "hour",
    picture: "hour",
    notification: "hour",
    social: "hour",
  },
  timelineCollapseByView: {
    article: "2",
    picture: "2",
    notification: "2",
    social: "2",
  },
  // 26-2：通知视图时间线的时间基准 —— 默认「发布时间」（= 现状，升级零变化）
  timelineTimeBasisByView: {
    article: "published",
    picture: "published",
    notification: "published",
    social: "published",
  },
  // 窄栏自动合一栏（默认开）
  timelineSingleSideByView: {
    article: true,
    picture: true,
    notification: true,
    social: true,
  },
};

let cachedPackage: UISettingsPackageShape = readStoredPackage();
let cachedSettings: UISettings = flatFromPackage(cachedPackage, currentDeviceClass());
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function getUISettings(): UISettings {
  return cachedSettings;
}

/** 当前整包（shared + 两档设备值）—— 同步模块要把它推给服务端 */
export function readUISettingsPackage(): UISettingsPackageShape {
  return cachedPackage;
}

/**
 * 用服务端那份覆盖本地（**服务端为准**，只在登录后首次拉取时走）。
 *
 * 为什么要整包覆盖而不是逐项合并：服务端那台设备是「另一处的真相」，
 * 逐项合并会让两台设备谁的旧值都不肯退让；这里统一由服务端说话，
 * 本地缓存随后跟着写，下次首屏就是同一套。
 */
export function applyUISettingsPackageFromServer(pkg: unknown): void {
  const next = normalizePackage(pkg);
  if (!next) {
    // 形状不对（或服务端没有）→ 保持本地不动，宁可不动也不要清空
    return;
  }

  cachedPackage = next;
  cachedSettings = flatFromPackage(cachedPackage, currentDeviceClass());
  persistPackage(cachedPackage);
  emitChange();
}

/**
 * 窗口跨过 768px 断点时重算「尺寸类那几项」。
 *
 * 尺寸类是按设备分套的，同一台机器把窗口拉窄（或用响应式调试）就换到了另一档，
 * 不重算的话会看到「手机布局 + 桌面列宽」这种错位。
 */
export function refreshDeviceScopedSettings(): void {
  const device = currentDeviceClass();
  const next = flatFromPackage(cachedPackage, device);

  const changed = DEVICE_SCOPED_UI_KEYS.some((key) => next[key] !== cachedSettings[key]);
  if (!changed) return;

  cachedSettings = next;
  emitChange();
}

export function hasSidebarVisibilitySetting(): boolean {
  return (
    "sidebarVisible" in cachedPackage.shared ||
    "sidebarVisible" in cachedPackage.device.desktop ||
    "sidebarVisible" in cachedPackage.device.mobile
  );
}

export function setUISetting<K extends keyof UISettings>(
  key: K,
  value: UISettings[K],
): void {
  const device = currentDeviceClass();

  if (DEVICE_SCOPED.has(key as string)) {
    cachedPackage = {
      ...cachedPackage,
      device: {
        ...cachedPackage.device,
        [device]: { ...cachedPackage.device[device], [key]: value },
      },
    };
  } else {
    cachedPackage = {
      ...cachedPackage,
      shared: { ...cachedPackage.shared, [key]: value },
    };
  }

  cachedSettings = flatFromPackage(cachedPackage, device);
  persistPackage(cachedPackage);
  emitChange();
  // 12-7：即时型改动给一句「已保存」（App 订阅事件、带防抖后弹 toast）
  notifySettingsSaved();
  // 21 批：本地立即生效之外，防抖后写服务端（跨设备一致）；失败会另弹一句可见的提示
  scheduleSettingsFlush("ui");
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

  const setPictureLayout = useCallback((layout: "masonry" | "grid" | "hover") => {
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

  const setComponentRadius = useCallback((preset: RadiusPreset) => {
    setUISetting("componentRadius", preset);
  }, []);

  const setFieldRadius = useCallback((preset: RadiusPreset) => {
    setUISetting("fieldRadius", preset);
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

  /** 第十五批：通知视图时间线的时间粒度（只改分组与节点标注，不重新请求数据） */
  const setTimelineGranularityForView = useCallback(
    (view: ContentType, granularity: TimelineGranularity) => {
      setUISetting("timelineGranularityByView", {
        ...getUISettings().timelineGranularityByView,
        [view]: granularity,
      });
    },
    [],
  );

  /** 第十五批：通知视图卡片的折叠行数（1/2/3/全文） */
  const setTimelineCollapseForView = useCallback(
    (view: ContentType, collapse: TimelineCollapse) => {
      setUISetting("timelineCollapseByView", {
        ...getUISettings().timelineCollapseByView,
        [view]: collapse,
      });
    },
    [],
  );

  /** 26-2：通知视图时间线的时间基准（发布时间 / 抓取时间） */
  const setTimelineTimeBasisForView = useCallback(
    (view: ContentType, basis: TimelineTimeBasis) => {
      setUISetting("timelineTimeBasisByView", {
        ...getUISettings().timelineTimeBasisByView,
        [view]: basis,
      });
    },
    [],
  );

  /** 窄栏自动合一栏（关掉则始终左右交替） */
  const setTimelineSingleSideForView = useCallback(
    (view: ContentType, enabled: boolean) => {
      setUISetting("timelineSingleSideByView", {
        ...getUISettings().timelineSingleSideByView,
        [view]: enabled,
      });
    },
    [],
  );

  const toggleSidebarVisible = useCallback(() => {
    const current = getUISettings().sidebarVisible;
    setUISetting("sidebarVisible", !current);
  }, []);

  const resetToDefaults = useCallback(() => {
    resetUISettingsToDefaults();
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
    setComponentRadius,
    setFieldRadius,
    setIconRadius,
    setUnreadBadge,
    setUnreadStyle,
    setAccentColor,
    setSidebarFeedAppearance,
    setScrollReadForView,
    setScrollReadTimingForView,
    setTimelineGranularityForView,
    setTimelineCollapseForView,
    setTimelineTimeBasisForView,
    setTimelineSingleSideForView,
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
 * 18 批：圆角落到 `<html>` 上 —— **写组件库自己的变量**，不是按 slot 覆盖。
 *
 * HeroUI 的圆角是两套变量：`--radius`（组件基座：按钮 / 卡片 / 浮层都读它）与
 * `--field-radius`（表单控件单独一套，出厂 `calc(var(--radius) * 1.5)`）。
 * 写在 `<html>` 上内联，所有读它们的组件一起变；**默认档把变量摘掉** ⇒ 回出厂值、行为零变化。
 *
 * `data-component-radius` 只是给 `index.css` 的一个开关：非默认时把 HeroUI `Button` 也拉到
 * `var(--radius)`（它自己本来是 `calc(var(--radius) * 3)`，不拉就会出现「组件圆角改了、按钮没跟」）。
 */
export function applyComponentRadiusToDocument(preset: RadiusPreset): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const css = radiusPresetToCss(preset);
  if (!css) {
    root.removeAttribute("data-component-radius");
    root.style.removeProperty("--radius");
    return;
  }
  root.setAttribute("data-component-radius", preset);
  root.style.setProperty("--radius", css);
}

/**
 * 18 批：表单圆角 → `--field-radius`（输入框 / 下拉 / 搜索框读它）；默认档摘掉 ⇒ 跟随组件的 ×1.5。
 * `data-field-radius` 与组件圆角那个一样，只是留个可读的落点标记，CSS 不依赖它。
 */
export function applyFieldRadiusToDocument(preset: RadiusPreset): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const css = radiusPresetToCss(preset);
  if (!css) {
    root.removeAttribute("data-field-radius");
    root.style.removeProperty("--field-radius");
    return;
  }
  root.setAttribute("data-field-radius", preset);
  root.style.setProperty("--field-radius", css);
}

/** 12-18：订阅图标圆角 → `--ui-icon-radius`（消费方是 sidebar/styles.ts 等处）；默认档摘掉 ⇒ 各处既有的 3/4px */
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

// ---------- 21 批：整包读取 / 恢复默认 / 注册同步组 ----------

/**
 * 恢复默认：**一次写完**（旧实现在 25 个键上循环调 setUISetting，
 * 等于弹 25 次「已保存」、发 25 次同步请求）。两档设备值一起回到默认，
 * 免得「在手机上恢复了默认、回桌面发现列宽还是老值」。
 */
export function resetUISettingsToDefaults(): void {
  const shared: Record<string, unknown> = {};
  const desktop: Record<string, unknown> = {};
  const mobile: Record<string, unknown> = {};
  const defaults = defaultUISettings as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(defaults)) {
    if (DEVICE_SCOPED.has(key)) {
      desktop[key] = value;
      mobile[key] = value;
    } else {
      shared[key] = value;
    }
  }

  cachedPackage = { shared, device: { desktop, mobile } };
  cachedSettings = flatFromPackage(cachedPackage, currentDeviceClass());
  persistPackage(cachedPackage);
  emitChange();
  notifySettingsSaved();
  scheduleSettingsFlush("ui");
}

/**
 * 注册「界面设置」这个同步组：整包推给服务端 / 服务端整包覆盖本地。
 * 与 useTheme / useCategoryState / lib/ui-lang 各自注册的那组一起，构成四组设置。
 */
registerSettingsGroup({
  key: "ui",
  read: () => cachedPackage,
  apply: (pkg) => applyUISettingsPackageFromServer(pkg),
});
