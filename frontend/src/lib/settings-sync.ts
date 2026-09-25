/**
 * 21 批（2026-09-18）：界面设置的「本地 ↔ 服务端」同步。
 *
 * 背景：界面设置原先只存在浏览器 localStorage 里 —— 清缓存 / 换浏览器 / 换设备就全没了。
 * 这批把它们搬到服务端（`settings` 表的 `ui` / `ui.theme` / `ui.lang` / `ui.sidebar_state` 四个键），
 * localStorage 退化成**本地缓存**。
 *
 * 四条约定（用户拍板）：
 *   1. **尺寸类按设备分套**：列宽 / 整体缩放 / 侧栏显隐存 desktop / mobile 两档，
 *      不然桌面 256px 的列宽同步到手机上没法用；
 *   2. **写前先取再合并**：PUT 之前先 GET 当前包，只把自己改过的那几组盖上去，
 *      另一台设备的尺寸档原样保留（服务端不加乐观锁，靠这一步降低互相覆盖的面）；
 *   3. **本地缓存留着**：首屏照旧同步读 localStorage（不闪），服务端值拉回来再对账覆盖；
 *   4. **未登录/离线**：照写本地并打「脏标记」，登录后（或下次改动）一次性推上去；
 *      服务端一条都没存过（首次迁移）时以本地为准推上去。
 *
 * 谁负责什么：这个模块**不知道**任何具体设置项 —— 各组自己注册 `read` / `apply`
 * （见 useUISettings / useTheme / useCategoryState / lib/ui-lang.ts），
 * 免得同步逻辑与 25+ 个设置字段纠缠在一起。
 */
import { getAuthToken, getUISettings, putUISettings } from "@/api";
import type {
  UISettingsPackage,
  UISettingsPayload,
  UISettingsResponse,
  UISettingsTheme,
} from "@/types/settings";
import { LS_KEYS, readLocalValue, removeLocalValue, writeLocalValue } from "./settings-storage";
import { notifySettingsSyncFailed } from "./settings-saved";

/** 设备档：与 useIsMobile 同一条断点（768px），两处必须一致，不然会出现「设置已按手机走、布局还是桌面」 */
export const SETTINGS_MOBILE_BREAKPOINT = 768;

export type SettingsDeviceClass = "desktop" | "mobile";

/** 写服务端的防抖：拖列宽 / 连续拨滑杆时只在停手后合成一次 PUT */
export const SETTINGS_FLUSH_DEBOUNCE_MS = 700;

export function currentDeviceClass(): SettingsDeviceClass {
  if (typeof window === "undefined") return "desktop";
  return window.innerWidth < SETTINGS_MOBILE_BREAKPOINT ? "mobile" : "desktop";
}

export interface SettingsGroupValues {
  ui: UISettingsPackage;
  "ui.theme": UISettingsTheme;
  "ui.lang": string;
  "ui.sidebar_state": Record<string, boolean>;
}

export type SettingsGroupKey = keyof SettingsGroupValues;

export interface SettingsGroup<K extends SettingsGroupKey = SettingsGroupKey> {
  key: K;
  /** 当前本地值（就是要推给服务端的整组值） */
  read: () => SettingsGroupValues[K];
  /** 用服务端值覆盖本地（实现方只落本地，不要反过来再触发一次同步） */
  apply: (value: SettingsGroupValues[K]) => void;
}

/**
 * 内部存的是「抹掉泛型」的形态：各组的值类型不同（包 / 主题 / 字符串 / 映射），
 * 注册时抹一次类型，取用时靠上面的取值校验函数把类型收回来。
 */
interface RegisteredSettingsGroup {
  read: () => unknown;
  apply: (value: unknown) => void;
}

const ALL_GROUP_KEYS: SettingsGroupKey[] = [
  "ui",
  "ui.theme",
  "ui.lang",
  "ui.sidebar_state",
];

const groups = new Map<SettingsGroupKey, RegisteredSettingsGroup>();

/** 各组在自己的模块里注册一次（模块导入即注册）。 */
export function registerSettingsGroup<K extends SettingsGroupKey>(
  group: SettingsGroup<K>,
): void {
  groups.set(group.key, {
    read: group.read,
    apply: group.apply as (value: unknown) => void,
  });
}

let active = false;
let applying = false;
let pending = new Set<SettingsGroupKey>();
let timer: ReturnType<typeof setTimeout> | null = null;

function isDirtyFlag(): boolean {
  return readLocalValue(LS_KEYS.settingsDirty) === "1";
}

function markDirtyFlag(): void {
  writeLocalValue(LS_KEYS.settingsDirty, "1");
}

function clearDirtyFlag(): void {
  removeLocalValue(LS_KEYS.settingsDirty);
}

/**
 * 本地某一组改动了 → 攒起来、防抖写服务端。
 *
 * 未登录 / 还没初始化完时只打脏标记：本地改动照样生效，等登录后再推。
 */
export function scheduleSettingsFlush(key: SettingsGroupKey): void {
  // 正在「用服务端值覆盖本地」时不算改动（否则会把刚拉回来的值再写回去）
  if (applying) return;

  pending.add(key);

  if (!active || !getAuthToken()) {
    markDirtyFlag();
    return;
  }

  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    void flushSettings();
  }, SETTINGS_FLUSH_DEBOUNCE_MS);
}

/** 立刻把待写入的改动推给服务端（App 卸载/切页前兜底；测试里也用它代替等防抖）。 */
export async function flushSettingsNow(): Promise<void> {
  await flushSettings();
}

/**
 * 强制以服务端为准拉一次（导入设置文件后调它：导入改的是服务端那份，
 * 本地那四组要立刻跟着变，不然界面还显示旧值）。
 */
export async function pullSettingsFromServer(): Promise<void> {
  const remote = await getUISettings();
  applyRemote(remote);
  clearDirtyFlag();
  active = true;
}

async function flushSettings(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }

  if (!active) return;

  if (!getAuthToken()) {
    markDirtyFlag();
    return;
  }

  const sending = pending;
  if (sending.size === 0) return;
  pending = new Set();

  try {
    // 写前先取：另一台设备的尺寸档、以及别的组的最新值都在这一份里
    const remote = await getUISettings();
    // 28-9：只有这次真的要推 ui 组时才取走键表 —— 不然这一批没带 ui 的话，
    // 取走（清空）就等于把「本机改过哪几个键」白扔了，下一次推 ui 时无从得知。
    const payload = buildSettingsPayload(
      remote,
      collectLocalValues(),
      sending,
      sending.has("ui") ? takeChangedUiKeys() : [],
    );
    if (Object.keys(payload).length === 0) return;
    await putUISettings(payload);
    clearDirtyFlag();
  } catch (error) {
    // 失败要让用户看见（不许静默）：把改动放回去、留脏标记，下次改动/下次登录再推
    for (const key of sending) pending.add(key);
    markDirtyFlag();
    notifySettingsSyncFailed(error);
  }
}

/**
 * 登录后（或页面加载后已登录）调一次。
 *
 * - 服务端一条都没存过 → **首次迁移**：把本地这份当基线推上去；
 * - 本地有没推上去的改动（未登录时改的 / 上次推送失败） → 以本地为准补推；
 * - 其余情况 → **服务端为准**，覆盖本地那四组（这就是「换设备看到的是同一套设置」）。
 */
export async function initSettingsSync(): Promise<void> {
  if (!getAuthToken()) return;

  if (active) {
    if (isDirtyFlag()) {
      for (const key of ALL_GROUP_KEYS) pending.add(key);
      await flushSettings();
    }
    return;
  }

  try {
    const remote = await getUISettings();

    if (remote.empty || isDirtyFlag()) {
      active = true;
      for (const key of ALL_GROUP_KEYS) pending.add(key);
      await flushSettings();
      return;
    }

    applyRemote(remote);
    clearDirtyFlag();
    active = true;
  } catch (error) {
    // 拉不到就维持「未启用」：本地照旧可用，改动进脏标记，下次再试
    markDirtyFlag();
    notifySettingsSyncFailed(error);
  }
}

function collectLocalValues(): Partial<SettingsGroupValues> {
  const out: Partial<SettingsGroupValues> = {};

  const ui = groups.get("ui")?.read();
  if (isUISettingsPackage(ui)) out.ui = ui;

  const theme = groups.get("ui.theme")?.read();
  if (isTheme(theme)) out["ui.theme"] = theme;

  const lang = groups.get("ui.lang")?.read();
  if (typeof lang === "string" && lang) out["ui.lang"] = lang;

  const sidebar = groups.get("ui.sidebar_state")?.read();
  if (isSidebarState(sidebar)) out["ui.sidebar_state"] = sidebar;

  return out;
}

/**
 * 28-9：本机这一次真正动过哪几个 UI 键。
 *
 * 为什么需要：`buildSettingsPayload` 的 touched 是**组级**（`ui` / `ui.theme`…），
 * 一个 `ui` 组里到底动过哪几个键它并不知道，于是 `shared` 只能整份拿本地覆盖服务端 ——
 * 后果是 A 设备改了某设置、B 设备此时改了另一个不同设置，B 一推送就把 A 的改动盖掉（多设备丢改动）。
 *
 * 记到键级之后，推送时只盖这几个键，其余以服务端为基线。
 * device 段不需要这么处理：那一档是本机独占的，别人不会改。
 */
const changedUiKeys = new Set<string>();

/** 记录一个被本机改动过的 UI 键（`setUISetting` 调用）。 */
export function markUiSettingsChanged(key: string): void {
  changedUiKeys.add(key);
}

/** 整包替换（恢复默认等）时标记一批键都动过。 */
export function markManyUiSettingsChanged(keys: Iterable<string>): void {
  for (const key of keys) changedUiKeys.add(key);
}

/** 取走并清空本次累积的键（推送时调用一次）。 */
export function takeChangedUiKeys(): string[] {
  const keys = [...changedUiKeys];
  changedUiKeys.clear();
  return keys;
}

/** 仅供测试：清掉累积状态。 */
export function resetChangedUiKeys(): void {
  changedUiKeys.clear();
}

/**
 * 合并出真正要 PUT 的整包：以服务端那份为基线，只盖本地改过的组。
 *
 * 「ui」这一组要特别处理：**当前设备那一档用本地的，另一档保留服务端的** ——
 * 否则桌面端一改设置就会把手机上存的列宽/缩放抹掉。
 */
export function buildSettingsPayload(
  remote: UISettingsResponse,
  local: Partial<SettingsGroupValues>,
  keys: Iterable<SettingsGroupKey>,
  /** 28-9：`ui` 组里本机真正动过的键（见 markUiSettingsChanged）。缺省则不盖任何键。 */
  changedUiKeys: readonly string[] = [],
): UISettingsPayload {
  const payload: UISettingsPayload = {};
  const touched = new Set(keys);

  if (touched.has("ui") && local.ui) {
    payload.ui = mergeUiPackage(remote.ui, local.ui, currentDeviceClass(), changedUiKeys);
  }
  if (touched.has("ui.theme") && local["ui.theme"]) {
    payload.theme = local["ui.theme"];
  }
  if (touched.has("ui.lang") && local["ui.lang"]) {
    payload.lang = local["ui.lang"];
  }
  if (touched.has("ui.sidebar_state") && local["ui.sidebar_state"]) {
    payload.sidebarState = local["ui.sidebar_state"];
  }

  return payload;
}

/** 当前设备那一档取本地的，另一档取服务端的（服务端没有才回落到本地）。 */
export function mergeUiPackage(
  remote: UISettingsPackage | undefined,
  local: UISettingsPackage,
  device: SettingsDeviceClass = currentDeviceClass(),
  /**
   * 28-9：本机这次真正动过的键。**只盖这些键**，其余以服务端为基线 ——
   * 默认空数组（不盖任何键、完全以服务端为基线）是刻意的：忘了传不会造成丢改动，
   * 最多是这一次没把自己改的值推上去。
   */
  changedKeys: readonly string[] = [],
): UISettingsPackage {
  const other: SettingsDeviceClass = device === "desktop" ? "mobile" : "desktop";
  const remoteDevice = remote?.device ?? {};
  const localDevice = local.device ?? {};

  const remoteShared = remote?.shared ?? {};
  const localShared = local.shared ?? {};
  const shared: Record<string, unknown> = { ...remoteShared };
  // 服务端那份 shared 本来就是空的（一条都没存过 / 首次迁移 / 恢复过默认）：
  // 没有「别人的值」会被盖掉，这一次就该把本地整份当基线推上去。
  const keysToApply =
    Object.keys(remoteShared).length === 0 ? Object.keys(localShared) : changedKeys;
  for (const key of keysToApply) {
    if (Object.prototype.hasOwnProperty.call(localShared, key)) {
      shared[key] = localShared[key];
    }
  }

  return {
    shared,
    device: {
      [device]: localDevice[device] ?? {},
      [other]: remoteDevice[other] ?? localDevice[other] ?? {},
    },
  };
}

function applyRemote(remote: UISettingsResponse): void {
  applying = true;
  try {
    const ui = groups.get("ui");
    if (ui && isUISettingsPackage(remote.ui) && !isPackageEmpty(remote.ui)) {
      ui.apply(remote.ui);
    }

    const themeGroup = groups.get("ui.theme");
    const theme = remote.theme;
    if (themeGroup && theme && typeof theme.mode === "string" && theme.mode) {
      themeGroup.apply({
        mode: theme.mode,
        lightTheme: theme.lightTheme ?? "",
        darkTheme: theme.darkTheme ?? "",
      });
    }

    const langGroup = groups.get("ui.lang");
    if (langGroup && typeof remote.lang === "string" && remote.lang) {
      langGroup.apply(remote.lang);
    }

    const sidebarGroup = groups.get("ui.sidebar_state");
    if (sidebarGroup && isSidebarState(remote.sidebarState)) {
      sidebarGroup.apply(remote.sidebarState);
    }
  } finally {
    applying = false;
  }
}

// ---------- 取值校验（同时也是「服务端/导入回来的脏值」的闸门） ----------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUISettingsPackage(value: unknown): value is UISettingsPackage {
  if (!isPlainObject(value)) return false;
  const shared = value.shared;
  const device = value.device;
  if (shared !== undefined && !isPlainObject(shared)) return false;
  if (device !== undefined && !isPlainObject(device)) return false;
  return true;
}

function isPackageEmpty(pkg: UISettingsPackage): boolean {
  const sharedCount = Object.keys(pkg.shared ?? {}).length;
  const deviceCount = Object.keys(pkg.device?.desktop ?? {}).length + Object.keys(pkg.device?.mobile ?? {}).length;
  return sharedCount === 0 && deviceCount === 0;
}

export function isTheme(value: unknown): value is UISettingsTheme {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.mode === "string" &&
    typeof value.lightTheme === "string" &&
    typeof value.darkTheme === "string"
  );
}

export function isSidebarState(value: unknown): value is Record<string, boolean> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((item) => typeof item === "boolean");
}

/** 测试用：清掉模块级状态（每次用例之间互不影响）。 */
export function resetSettingsSyncForTests(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  active = false;
  applying = false;
  pending = new Set();
  groups.clear();
}

/** 测试用：看某个组当前本地值是否已注册。 */
export function hasSettingsGroup(key: SettingsGroupKey): boolean {
  return groups.has(key);
}
