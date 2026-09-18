/**
 * 本地缓存的键名与「老键名迁移」（21 批，2026-09-18）。
 *
 * 为什么要有这个文件：这批做了两件事，都动到 localStorage 的键名/形状 ——
 *   1. 界面设置搬到服务端（跨设备一致），localStorage 退化成**本地缓存**（首屏不闪的那份）；
 *   2. 顺手把 `gist-*` 键名改成 `krss-*`（发布方案里列过这件事，不一起改就要改两遍）。
 *
 * 迁移规则：读的时候 `krss-*` 没有、老 `gist-*` 还在 → 把值搬到新键并删掉老键。
 * 一次读走完，用户无感（不清缓存、不掉登录、不丢设置）。
 */

export interface StorageKeySpec {
  /** 现在的键名 */
  key: string;
  /** 老键名（迁移用；没有就填 null） */
  legacy: string | null;
}

export const LS_KEYS = {
  authToken: { key: "krss_auth_token", legacy: "gist_auth_token" },
  uiSettings: { key: "krss-ui-settings", legacy: "gist-ui-settings" },
  theme: { key: "krss-theme", legacy: "gist-theme" },
  lightTheme: { key: "krss-light-theme", legacy: "gist-light-theme" },
  darkTheme: { key: "krss-dark-theme", legacy: "gist-dark-theme" },
  lang: { key: "krss-lang", legacy: "gist-lang" },
  categoryState: { key: "krss-category-state", legacy: "gist-category-state" },
  autoRefreshHistory: {
    key: "krss-auto-refresh-history",
    legacy: "gist-auto-refresh-history",
  },
  /** 「本地有改动还没推给服务端」的脏标记（21 批） */
  settingsDirty: { key: "krss-settings-dirty", legacy: "gist-settings-dirty" },
} as const satisfies Record<string, StorageKeySpec>;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // 隐私模式等场景下访问 localStorage 会抛异常
    return null;
  }
}

/** 读本地值；老键名还有值就搬过来（一次性迁移）。 */
export function readLocalValue(spec: StorageKeySpec): string | null {
  const store = storage();
  if (!store) return null;

  try {
    const current = store.getItem(spec.key);
    if (current !== null) return current;
    if (!spec.legacy) return null;

    const legacy = store.getItem(spec.legacy);
    if (legacy === null) return null;
    store.setItem(spec.key, legacy);
    store.removeItem(spec.legacy);
    return legacy;
  } catch {
    return null;
  }
}

export function writeLocalValue(spec: StorageKeySpec, value: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(spec.key, value);
  } catch {
    // 配额满 / 被禁用：本地缓存写不进去不影响功能（服务端那份才是准的）
  }
}

export function removeLocalValue(spec: StorageKeySpec): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(spec.key);
    if (spec.legacy) store.removeItem(spec.legacy);
  } catch {
    // 同上
  }
}

/** 测试与调试用：读老键名（不做迁移）。 */
export function peekLegacyValue(spec: StorageKeySpec): string | null {
  const store = storage();
  if (!store || !spec.legacy) return null;
  try {
    return store.getItem(spec.legacy);
  } catch {
    return null;
  }
}
