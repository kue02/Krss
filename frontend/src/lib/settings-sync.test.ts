import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api", () => ({
  getAuthToken: vi.fn(),
  getUISettings: vi.fn(),
  putUISettings: vi.fn(),
}));

import { getAuthToken, getUISettings, putUISettings } from "@/api";
import type {
  UISettingsPackage,
  UISettingsPayload,
  UISettingsResponse,
  UISettingsTheme,
} from "@/types/settings";
import { SETTINGS_SYNC_FAILED_EVENT } from "./settings-saved";
import { LS_KEYS, readLocalValue } from "./settings-storage";
import {
  SETTINGS_FLUSH_DEBOUNCE_MS,
  buildSettingsPayload,
  currentDeviceClass,
  flushSettingsNow,
  initSettingsSync,
  mergeUiPackage,
  registerSettingsGroup,
  resetSettingsSyncForTests,
  scheduleSettingsFlush,
  type SettingsGroupValues,
} from "./settings-sync";

/**
 * 21 批（2026-09-18）：界面设置的「本地 ↔ 服务端」同步引擎。
 *
 * 这里测的是**引擎本身**（合批、合并、首次迁移、失败重试），
 * 具体设置项由各组自己注册 read/apply —— 测试里注册的是替身，不碰真实设置模块。
 */
const mockedGetAuthToken = vi.mocked(getAuthToken);
const mockedGetUISettings = vi.mocked(getUISettings);
const mockedPutUISettings = vi.mocked(putUISettings);

interface FakeGroupValues {
  ui: UISettingsPackage;
  theme: UISettingsTheme;
  lang: string;
  sidebar: Record<string, boolean>;
}

const local: FakeGroupValues = {
  ui: {
    shared: { cardPreviewLines: 3 },
    device: { desktop: { feedColWidth: 256 }, mobile: { feedColWidth: 120 } },
  },
  theme: { mode: "dark", lightTheme: "stone", darkTheme: "nord-dark" },
  lang: "zh",
  sidebar: { tech: true },
};

let applied: Partial<FakeGroupValues> = {};

function registerFakeGroups(): void {
  registerSettingsGroup({
    key: "ui",
    read: () => local.ui,
    apply: (value) => {
      applied.ui = value;
      local.ui = value;
    },
  });
  registerSettingsGroup({
    key: "ui.theme",
    read: () => local.theme,
    apply: (value) => {
      applied.theme = value;
      local.theme = value;
    },
  });
  registerSettingsGroup({
    key: "ui.lang",
    read: () => local.lang,
    apply: (value) => {
      applied.lang = value;
      local.lang = value;
    },
  });
  registerSettingsGroup({
    key: "ui.sidebar_state",
    read: () => local.sidebar,
    apply: (value) => {
      applied.sidebar = value;
      local.sidebar = value;
    },
  });
}

/**
 * 取第 n 次 PUT 的 payload。
 * 直接写 `mock.calls[0][0]` 在 noUncheckedIndexedAccess 下是 `T | undefined`，
 * tsc 会报 TS2532 —— 这里收口成一个带断言的取值函数，断言失败也给得出原因。
 */
function sentPayload(index = 0): UISettingsPayload {
  const call = mockedPutUISettings.mock.calls[index];
  if (!call) throw new Error(`期望有第 ${index + 1} 次 PUT，实际没有`);
  return call[0];
}

function emptyRemote(): UISettingsResponse {
  return {
    ui: {},
    theme: {},
    lang: "",
    sidebarState: {},
    empty: true,
  };
}

function serverRemote(): UISettingsResponse {
  return {
    ui: {
      shared: { cardPreviewLines: 9 },
      device: { desktop: { feedColWidth: 300 }, mobile: { feedColWidth: 150 } },
    },
    theme: { mode: "light", lightTheme: "leaf", darkTheme: "nord-dark" },
    lang: "en",
    sidebarState: { news: false },
    empty: false,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  applied = {};
  resetSettingsSyncForTests();
  registerFakeGroups();
  local.ui = {
    shared: { cardPreviewLines: 3 },
    device: { desktop: { feedColWidth: 256 }, mobile: { feedColWidth: 120 } },
  };
  local.theme = { mode: "dark", lightTheme: "stone", darkTheme: "nord-dark" };
  local.lang = "zh";
  local.sidebar = { tech: true };

  mockedGetAuthToken.mockReturnValue("token");
  mockedGetUISettings.mockResolvedValue(emptyRemote());
  mockedPutUISettings.mockResolvedValue(emptyRemote());
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("设备档（尺寸类按设备分套）", () => {
  it("按 768px 断点分 desktop / mobile（与 useIsMobile 同一条）", () => {
    expect(currentDeviceClass()).toBe("desktop");

    const original = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      value: 500,
      configurable: true,
    });
    expect(currentDeviceClass()).toBe("mobile");
    Object.defineProperty(window, "innerWidth", {
      value: original,
      configurable: true,
    });
  });

  it("推给服务端时：当前设备那一档用本地的，另一档保留服务端的", () => {
    const merged = mergeUiPackage(serverRemote().ui, local.ui, "desktop");

    expect(merged.shared).toEqual({ cardPreviewLines: 3 });
    expect(merged.device?.desktop?.feedColWidth).toBe(256);
    // 手机上那档没被桌面端覆盖掉 —— 这条就是「别把桌面列宽同步到手机」的判据
    expect(merged.device?.mobile?.feedColWidth).toBe(150);
  });

  it("服务端没有另一档时回落到本地值", () => {
    const merged = mergeUiPackage(
      { shared: {}, device: { desktop: { feedColWidth: 300 } } },
      local.ui,
      "desktop",
    );
    expect(merged.device?.mobile?.feedColWidth).toBe(120);
  });
});

describe("buildSettingsPayload（只发改过的组）", () => {
  /** 同步模块按「组键」取值（`ui` / `ui.theme` / …），这里的替身按同一套键名给 */
  function groupValues(): SettingsGroupValues {
    return {
      ui: local.ui,
      "ui.theme": local.theme,
      "ui.lang": local.lang,
      "ui.sidebar_state": local.sidebar,
    };
  }

  it("没碰过的组不进 payload（服务端那几项原样不动）", () => {
    const payload = buildSettingsPayload(serverRemote(), groupValues(), [
      "ui.theme",
    ]);
    expect(payload.theme).toEqual(local.theme);
    expect(payload.ui).toBeUndefined();
    expect(payload.lang).toBeUndefined();
    expect(payload.sidebarState).toBeUndefined();
  });

  it("四组都碰过时四组都在", () => {
    const payload = buildSettingsPayload(serverRemote(), groupValues(), [
      "ui",
      "ui.theme",
      "ui.lang",
      "ui.sidebar_state",
    ]);
    expect(Object.keys(payload).sort()).toEqual([
      "lang",
      "sidebarState",
      "theme",
      "ui",
    ]);
  });
});

describe("未登录 / 未初始化：只写本地 + 打脏标记", () => {
  it("没有 token 时改动不请求服务端，只留脏标记（登录后再推）", async () => {
    mockedGetAuthToken.mockReturnValue(null);

    scheduleSettingsFlush("ui.theme");
    await vi.advanceTimersByTimeAsync(SETTINGS_FLUSH_DEBOUNCE_MS * 2);

    expect(mockedPutUISettings).not.toHaveBeenCalled();
    expect(readLocalValue(LS_KEYS.settingsDirty)).toBe("1");
  });

  it("initSettingsSync 未登录时直接返回，不发请求", async () => {
    mockedGetAuthToken.mockReturnValue(null);

    await initSettingsSync();

    expect(mockedGetUISettings).not.toHaveBeenCalled();
    expect(mockedPutUISettings).not.toHaveBeenCalled();
  });
});

describe("initSettingsSync：首次迁移 vs 服务端为准", () => {
  it("服务端一条都没存过（empty）→ 把本地这份当基线推上去", async () => {
    await initSettingsSync();

    expect(mockedPutUISettings).toHaveBeenCalledTimes(1);
    const payload = sentPayload();
    expect(payload.ui).toEqual(local.ui);
    expect(payload.theme).toEqual(local.theme);
    expect(payload.lang).toBe("zh");
    expect(payload.sidebarState).toEqual({ tech: true });
    // 推上去就算对齐了，脏标记要清掉
    expect(readLocalValue(LS_KEYS.settingsDirty)).toBeNull();
  });

  it("服务端有值 → 以服务端为准覆盖本地四组，不反向写", async () => {
    mockedGetUISettings.mockResolvedValue(serverRemote());

    await initSettingsSync();

    expect(mockedPutUISettings).not.toHaveBeenCalled();
    expect(applied.ui).toEqual(serverRemote().ui);
    expect(applied.theme).toEqual({
      mode: "light",
      lightTheme: "leaf",
      darkTheme: "nord-dark",
    });
    expect(applied.lang).toBe("en");
    expect(applied.sidebar).toEqual({ news: false });
    expect(local.ui).toEqual(serverRemote().ui);
  });

  it("本地有脏标记（离线时改的 / 上次推失败）→ 以本地为准补推一次", async () => {
    // 先按服务端有值初始化一次（active=true），再模拟「未登录时的改动」留下的脏标记
    mockedGetUISettings.mockResolvedValue(serverRemote());
    await initSettingsSync();

    localStorage.setItem(LS_KEYS.settingsDirty.key, "1");
    mockedPutUISettings.mockClear();

    await initSettingsSync();

    expect(mockedPutUISettings).toHaveBeenCalledTimes(1);
    expect(sentPayload().ui).toEqual(local.ui);
    expect(readLocalValue(LS_KEYS.settingsDirty)).toBeNull();
  });

  it("拉不到服务端（网络错）→ 不启用同步、留脏标记、事件可订阅", async () => {
    mockedGetUISettings.mockRejectedValue(new Error("network down"));
    const onFailed = vi.fn();
    window.addEventListener(SETTINGS_SYNC_FAILED_EVENT, onFailed);

    await initSettingsSync();

    expect(readLocalValue(LS_KEYS.settingsDirty)).toBe("1");
    expect(onFailed).toHaveBeenCalledTimes(1);
    window.removeEventListener(SETTINGS_SYNC_FAILED_EVENT, onFailed);
  });
});

describe("写服务端的合批（700ms 防抖）", () => {
  it("连续改动合成一次 PUT，且只带改过的那一组", async () => {
    await initSettingsSync(); // empty → 首次推送
    mockedGetUISettings.mockResolvedValue(serverRemote());
    mockedGetUISettings.mockClear();
    mockedPutUISettings.mockClear();

    scheduleSettingsFlush("ui.theme");
    await vi.advanceTimersByTimeAsync(300);
    scheduleSettingsFlush("ui.theme"); // 300ms 内的第二次改动
    await vi.advanceTimersByTimeAsync(SETTINGS_FLUSH_DEBOUNCE_MS);

    expect(mockedPutUISettings).toHaveBeenCalledTimes(1);
    const payload = sentPayload();
    expect(payload.theme).toEqual(local.theme);
    expect(payload.ui).toBeUndefined();
    expect(payload.lang).toBeUndefined();
  });

  it("防抖窗口内没有改动就不发请求", async () => {
    await initSettingsSync();
    mockedPutUISettings.mockClear();

    await vi.advanceTimersByTimeAsync(SETTINGS_FLUSH_DEBOUNCE_MS * 3);

    expect(mockedPutUISettings).not.toHaveBeenCalled();
  });
});

describe("写服务端失败：可见提示 + 留着重试", () => {
  it("PUT 失败 → 发失败事件、留脏标记，下次改动重试成功", async () => {
    await initSettingsSync();
    mockedGetUISettings.mockResolvedValue(serverRemote());
    mockedPutUISettings.mockClear();

    const onFailed = vi.fn();
    window.addEventListener(SETTINGS_SYNC_FAILED_EVENT, onFailed);

    mockedPutUISettings.mockRejectedValueOnce(new Error("500 internal"));
    scheduleSettingsFlush("ui.lang");
    await vi.advanceTimersByTimeAsync(SETTINGS_FLUSH_DEBOUNCE_MS);

    expect(onFailed).toHaveBeenCalledTimes(1);
    const failedEvent = onFailed.mock.calls[0]?.[0] as CustomEvent | undefined;
    expect(failedEvent?.detail).toBe("500 internal");
    expect(readLocalValue(LS_KEYS.settingsDirty)).toBe("1");

    // 改动没丢：再推一次就成功（这条是「不许静默失败」的落地）
    mockedPutUISettings.mockClear();
    mockedPutUISettings.mockResolvedValue(emptyRemote());
    await flushSettingsNow();

    expect(mockedPutUISettings).toHaveBeenCalledTimes(1);
    expect(sentPayload().lang).toBe("zh");
    expect(readLocalValue(LS_KEYS.settingsDirty)).toBeNull();

    window.removeEventListener(SETTINGS_SYNC_FAILED_EVENT, onFailed);
  });
});
