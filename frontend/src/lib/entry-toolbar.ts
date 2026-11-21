/**
 * 正文工具栏（第三栏阅读器右上角那排按钮）的**自定义配置**。
 *
 * 用户可以：
 *   1. 拖动调整顺序（framer-motion Reorder）
 *   2. 逐项显示 / 隐藏
 *
 * 存进 UI 设置（`entryToolbar`，见 `hooks/useUISettings.ts`），形状是
 * `{ id, hidden }[]`（只保留用户能认得的七项，顺序即渲染顺序）。
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

export interface EntryToolbarItem {
  id: EntryToolbarItemId;
  hidden: boolean;
}

/** 默认顺序 = 现有按钮的渲染顺序，全部可见。 */
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

export function isEntryToolbarItemId(value: unknown): value is EntryToolbarItemId {
  return typeof value === "string" && KNOWN_IDS.has(value);
}

export function defaultEntryToolbar(): EntryToolbarItem[] {
  return ENTRY_TOOLBAR_ITEM_IDS.map((id) => ({ id, hidden: false }));
}

/** 默认值（每次新建数组，避免被外部改动污染模块级常量）。 */
export const DEFAULT_ENTRY_TOOLBAR: EntryToolbarItem[] = defaultEntryToolbar();

/**
 * 把存储值归一成「完整、去重、按已知项补齐」的配置：
 *   - 未知 id（升级回退等残留）直接丢弃（配置里无法渲染）；
 *   - 重复 id 只保留第一次出现；
 *   - 存储里缺失的默认项**回落到默认值并追加到末尾**（新增项不会因为老数据而消失）；
 *   - `hidden` 只认布尔 true，其余一律视为 false（可见）。
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
    result.push({ id, hidden: (item as { hidden?: unknown }).hidden === true });
  }

  // 存储里没出现过的默认项 → 按默认顺序补到末尾（默认可见）。
  for (const id of ENTRY_TOOLBAR_ITEM_IDS) {
    if (!seen.has(id)) {
      result.push({ id, hidden: false });
    }
  }

  return result;
}
