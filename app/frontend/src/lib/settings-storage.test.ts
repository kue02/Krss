import { beforeEach, describe, expect, it } from "vitest";
import {
  LS_KEYS,
  peekLegacyValue,
  readLocalValue,
  removeLocalValue,
  writeLocalValue,
} from "./settings-storage";

/**
 * 21 批（2026-09-18）：键名 `gist-*` → `krss-*`，老键的值读的时候一次性搬过来。
 * 这批把「设置搬到服务端」与「键名改名」合并做了一次（不合并就要改两遍），
 * 所以「老用户的设置不掉、登录不掉」全靠这一层 —— 单独钉住它。
 */
beforeEach(() => {
  localStorage.clear();
});

describe("settings-storage 键名迁移（21 批）", () => {
  it("只有老键时：读一次就搬到新键，并删掉老键", () => {
    localStorage.setItem("gist-theme", "dark");

    expect(readLocalValue(LS_KEYS.theme)).toBe("dark");
    expect(localStorage.getItem("krss-theme")).toBe("dark");
    // 老键搬完就删，避免下次又走一遍迁移分支、也避免两份值打架
    expect(localStorage.getItem("gist-theme")).toBeNull();
  });

  it("新键已有值时：新键说了算，老键不动也不覆盖", () => {
    localStorage.setItem("krss-theme", "light");
    localStorage.setItem("gist-theme", "dark");

    expect(readLocalValue(LS_KEYS.theme)).toBe("light");
    expect(localStorage.getItem("gist-theme")).toBe("dark");
  });

  it("两个键都没有 → null（调用方走默认值）", () => {
    expect(readLocalValue(LS_KEYS.categoryState)).toBeNull();
    expect(peekLegacyValue(LS_KEYS.categoryState)).toBeNull();
  });

  it("peekLegacyValue 只看老键、不触发迁移", () => {
    localStorage.setItem("gist-lang", "en");

    expect(peekLegacyValue(LS_KEYS.lang)).toBe("en");
    expect(localStorage.getItem("krss-lang")).toBeNull();
  });

  it("写入 / 删除都落在新键上；删除时把老键一并清掉", () => {
    writeLocalValue(LS_KEYS.uiSettings, JSON.stringify({ shared: {} }));
    expect(JSON.parse(localStorage.getItem("krss-ui-settings") ?? "{}")).toEqual({
      shared: {},
    });

    localStorage.setItem("gist-ui-settings", JSON.stringify({ feedColWidth: 256 }));
    removeLocalValue(LS_KEYS.uiSettings);
    expect(localStorage.getItem("krss-ui-settings")).toBeNull();
    expect(localStorage.getItem("gist-ui-settings")).toBeNull();
  });

  it("键名表覆盖 21 批搬走/改名的那几项（含登录 token）", () => {
    expect(LS_KEYS.authToken).toEqual({
      key: "krss_auth_token",
      legacy: "gist_auth_token",
    });
    expect(LS_KEYS.uiSettings.key).toBe("krss-ui-settings");
    expect(LS_KEYS.settingsDirty.key).toBe("krss-settings-dirty");
    // 自动刷新历史也改了键名，但**不进服务端同步**（见 lib/auto-refresh-history.ts）
    expect(LS_KEYS.autoRefreshHistory.key).toBe("krss-auto-refresh-history");
  });
});
