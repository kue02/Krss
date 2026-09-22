/**
 * 本地缓存的键名（改名清理后：只有 `krss-*`，不留老键兼容）。
 *
 * 21 批（2026-09-18）把界面设置搬到服务端（跨设备一致），localStorage 退化成
 * **本地缓存**（首屏不闪的那份）；顺手把键名改成了 `krss-*`。
 * 改名清理（2026-09-20，用户拍板：dev 版不留兼容）把老 `gist-*` 键与迁移逻辑
 * 一并摘掉 —— 没跑过 21 批代码的浏览器最多是本地缓存重置，服务端那份才是准的。
 */

export interface StorageKeySpec {
  /** 键名 */
  key: string;
}

export const LS_KEYS = {
  authToken: { key: "krss_auth_token" },
  uiSettings: { key: "krss-ui-settings" },
  theme: { key: "krss-theme" },
  lightTheme: { key: "krss-light-theme" },
  darkTheme: { key: "krss-dark-theme" },
  lang: { key: "krss-lang" },
  categoryState: { key: "krss-category-state" },
  autoRefreshHistory: {
    key: "krss-auto-refresh-history",
  },
  /** 「本地有改动还没推给服务端」的脏标记（21 批） */
  settingsDirty: { key: "krss-settings-dirty" },
} as const satisfies Record<string, StorageKeySpec>;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // 隐私模式等场景下访问 localStorage 会抛异常
    return null;
  }
}

/** 读本地值。 */
export function readLocalValue(spec: StorageKeySpec): string | null {
  const store = storage();
  if (!store) return null;

  try {
    return store.getItem(spec.key);
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
  } catch {
    // 同上
  }
}
