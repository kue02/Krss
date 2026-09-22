import { beforeEach, describe, expect, it } from "vitest";
import {
  LS_KEYS,
  readLocalValue,
  removeLocalValue,
  writeLocalValue,
} from "./settings-storage";

/**
 * 本地缓存键（改名清理后：只有 `krss-*`）。
 * 21 批把设置搬到服务端后，localStorage 只是首屏不闪的本地缓存；
 * 服务端那份才是准的，这里只钉住「读写删都落在新键上」。
 */
beforeEach(() => {
  localStorage.clear();
});

describe("settings-storage 本地缓存", () => {
  it("读：有值返回值，没有返回 null（调用方走默认值）", () => {
    localStorage.setItem("krss-theme", "dark");

    expect(readLocalValue(LS_KEYS.theme)).toBe("dark");
    expect(readLocalValue(LS_KEYS.categoryState)).toBeNull();
  });

  it("写：落在新键上；删：只删新键", () => {
    writeLocalValue(LS_KEYS.uiSettings, JSON.stringify({ shared: {} }));
    expect(JSON.parse(localStorage.getItem("krss-ui-settings") ?? "{}")).toEqual(
      {
        shared: {},
      },
    );

    removeLocalValue(LS_KEYS.uiSettings);
    expect(localStorage.getItem("krss-ui-settings")).toBeNull();
  });

  it("键名表全是 krss-*（含登录 token）", () => {
    expect(LS_KEYS.authToken).toEqual({
      key: "krss_auth_token",
    });
    expect(LS_KEYS.uiSettings.key).toBe("krss-ui-settings");
    expect(LS_KEYS.settingsDirty.key).toBe("krss-settings-dirty");
    // 自动刷新历史不进服务端同步（见 lib/auto-refresh-history.ts），但键名同规则
    expect(LS_KEYS.autoRefreshHistory.key).toBe("krss-auto-refresh-history");
  });
});
