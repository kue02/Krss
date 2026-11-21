/**
 * 正文工具栏（第三栏阅读器右上角那排按钮）的**自定义配置**。
 *
 * 用户可以：
 *   1. 拖动调整顺序（framer-motion Reorder）
 *   2. 逐项决定去向：显示在工具栏 / 收进「更多」（三点菜单） / 永久隐藏（连更多都不进）
 *
 * 存进 UI 设置（`entryToolbar`，见 `hooks/useUISettings.ts`），形状是
 * `{ id, placement }[]`（只保留用户能认得的七项，顺序即渲染顺序，
 * 工具栏与「更多」各自保持这个相对顺序）。
 *
 * 读：`EntryContentHeader` 用 `normalizeEntryToolbar` 把存储值归一后再按顺序渲染。
 * 写：`components/settings/tabs/EntryToolbarSettings` 用它生成新值再 `setUISetting`。
 */

/** 可自定义的工具栏项（与现有渲染顺序默认一致）。 */
export type EntryToolbarItemId =
  | "star"
  | "read"
  | "summary"
  | "translate"
  | "originalsite"
  | "readable"
  | "openexternal";

/**
 * 每个按钮的去向：
 *   - toolbar：直接显示在正文顶部工具栏；
 *   - more：收进「更多」（三点）菜单，为以后插件/新按钮腾位置；
 *   - hidden：永久隐藏，连「更多」也不出现。
 */
export type EntryToolbarPlacement = "toolbar" | "more" | "hidden";

export interface EntryToolbarItem {
  id: EntryToolbarItemId;
  placement: EntryToolbarPlacement;
}

/** 默认顺序 = 现有按钮的渲染顺序，全部显示在工具栏。 */
export const ENTRY_TOOLBAR_ITEM_IDS: readonly EntryToolbarItemId[] = [
  "star",
  "read",
  "summary",
  "translate",
  "originalsite",
  "readable",
  "openexternal",
] as const;

const KNOWN_IDS = new Set<string>(ENTRY_TOOLBAR_ITEM_IDS);

/** 合法的去向值，用于归一脏数据。 */
const PLACEMENTS = new Set<EntryToolbarPlacement>([
  "toolbar",
  "more",
  "hidden",
]);

export function isEntryToolbarItemId(value: unknown): value is EntryToolbarItemId {
  return typeof value === "string" && KNOWN_IDS.has(value);
}

export function isEntryToolbarPlacement(
  value: unknown,
): value is EntryToolbarPlacement {
  return (
    typeof value === "string" &&
    PLACEMENTS.has(value as EntryToolbarPlacement)
  );
}

export function defaultEntryToolbar(): EntryToolbarItem[] {
  return ENTRY_TOOLBAR_ITEM_IDS.map((id) => ({ id, placement: "toolbar" }));
}

/** 默认值（每次新建数组，避免被外部改动污染模块级常量）。 */
export const DEFAULT_ENTRY_TOOLBAR: EntryToolbarItem[] = defaultEntryToolbar();

/** 把一条存储项归一成 placement：兼容早期的 `{ hidden: true }` 老数据。 */
function normalizePlacement(item: unknown): EntryToolbarPlacement {
  if (!item || typeof item !== "object") return "toolbar";
  const raw = (item as { placement?: unknown }).placement;
  if (isEntryToolbarPlacement(raw)) return raw;
  // 老版本只有 hidden 布尔：true → 永久隐藏，false → 显示在工具栏。
  return (item as { hidden?: unknown }).hidden === true ? "hidden" : "toolbar";
}

/**
 * 把存储值归一成「完整、去重、按已知项补齐」的配置：
 *   - 未知 id（升级回退等残留）直接丢弃（配置里无法渲染）；
 *   - 重复 id 只保留第一次出现；
 *   - 存储里缺失的默认项**回落到默认值并追加到末尾**（新增项不会因为老数据而消失）；
 *   - placement 只认三档合法值，非法一律回落到 toolbar。
 */
export function normalizeEntryToolbar(value: unknown): EntryToolbarItem[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<EntryToolbarItemId>();
  const result: EntryToolbarItem[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (!isEntryToolbarItemId(id) || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, placement: normalizePlacement(item) });
  }

  // 存储里没出现过的默认项 → 按默认顺序补到末尾（默认显示在工具栏）。
  for (const id of ENTRY_TOOLBAR_ITEM_IDS) {
    if (!seen.has(id)) {
      result.push({ id, placement: "toolbar" });
    }
  }

  return result;
}
