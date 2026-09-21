import { beforeEach, describe, expect, it, vi } from "vitest";
import { spyOnStorageWrites } from "@/test/storage-write-spy";

/**
 * 21 批（2026-09-18）：`krss-ui-settings` 从「扁平一坨」变成
 * `{ shared, device: { desktop, mobile } }` —— 尺寸类（列宽/缩放/侧栏）按设备分套。
 *
 * 这里用「每个用例重新 import 模块」的方式测：该模块在导入时就同步读 localStorage
 * （首屏不闪的前提），所以要拿真实初始状态就必须拿到全新的模块实例。
 */
type UISettingsModule = typeof import("./useUISettings");

async function freshModule(): Promise<UISettingsModule> {
  vi.resetModules();
  return await import("./useUISettings");
}

function setWindowWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

function storedPackage(): {
  shared?: Record<string, unknown>;
  device?: { desktop?: Record<string, unknown>; mobile?: Record<string, unknown> };
} {
  return JSON.parse(localStorage.getItem("krss-ui-settings") ?? "{}");
}

beforeEach(() => {
  localStorage.clear();
  setWindowWidth(1024); // jsdom 默认视口 → 桌面档
});

describe("界面设置整包：尺寸类按设备分套（21 批）", () => {
  it("尺寸类写进当前设备那一档，其余进 shared", async () => {
    const mod = await freshModule();

    mod.setUISetting("feedColWidth", 300);
    mod.setUISetting("cardPreviewLines", 5);

    const raw = storedPackage();
    expect(raw.device?.desktop?.feedColWidth).toBe(300);
    expect(raw.shared?.cardPreviewLines).toBe(5);
    // 尺寸类不许落在共用档里（否则会同步到手机）
    expect(raw.shared?.feedColWidth).toBeUndefined();

    expect(mod.getUISettings().feedColWidth).toBe(300);
    expect(mod.getUISettings().cardPreviewLines).toBe(5);
  });

  it("新键 timelineTimeBasisByView：写 shared，服务端整包回来不丢", async () => {
    const mod = await freshModule();

    mod.setUISetting("timelineTimeBasisByView", {
      article: "published",
      picture: "published",
      notification: "fetched",
      social: "published",
    });

    const raw = storedPackage();
    expect(raw.shared?.timelineTimeBasisByView).toEqual({
      article: "published",
      picture: "published",
      notification: "fetched",
      social: "published",
    });
    expect(mod.getUISettings().timelineTimeBasisByView.notification).toBe("fetched");

    // 服务端整包（含新键）覆盖本地后不丢，且默认值仍是全发布时间
    const mod2 = await freshModule();
    mod2.applyUISettingsPackageFromServer({
      shared: {
        timelineTimeBasisByView: {
          article: "published",
          picture: "published",
          notification: "published",
          social: "published",
        },
      },
      device: { desktop: {}, mobile: {} },
    });
    expect(mod2.getUISettings().timelineTimeBasisByView.notification).toBe("published");
    expect(mod2.defaultUISettings.timelineTimeBasisByView.notification).toBe("published");
  });

  it("形状不对（既不是整包也不是可用的值）→ 走默认值，不崩", async () => {
    localStorage.setItem("krss-ui-settings", JSON.stringify({ feedColWidth: 300 }));

    const mod = await freshModule();

    // 扁平形状已不再被识别（改名清理摘掉兼容）：回落默认值
    expect(mod.getUISettings().feedColWidth).toBe(
      (await import("./useUISettings")).defaultUISettings.feedColWidth,
    );
  });

  it("服务端整包覆盖本地；窗口跨 768px 断点时尺寸类换到另一档、共用项不动", async () => {
    const mod = await freshModule();

    mod.applyUISettingsPackageFromServer({
      shared: { cardPreviewLines: 7 },
      device: {
        desktop: { feedColWidth: 300, uiScale: 1 },
        mobile: { feedColWidth: 140, uiScale: 0.9 },
      },
    });

    expect(mod.getUISettings().feedColWidth).toBe(300);
    expect(mod.getUISettings().uiScale).toBe(1);

    setWindowWidth(500);
    mod.refreshDeviceScopedSettings();

    expect(mod.getUISettings().feedColWidth).toBe(140);
    expect(mod.getUISettings().uiScale).toBe(0.9);
    expect(mod.getUISettings().cardPreviewLines).toBe(7);
  });

  it("服务端回来的野值被收窄：类型不对的丢掉、对象型的与默认值浅合并", async () => {
    const mod = await freshModule();
    mod.setUISetting("cardPreviewLines", 6);

    // 完全不是对象 → 保持本地不动
    mod.applyUISettingsPackageFromServer("nonsense");
    expect(mod.getUISettings().cardPreviewLines).toBe(6);

    // 类型不对的那一项被丢掉，回落默认值（而不是把字符串喂给组件）
    mod.applyUISettingsPackageFromServer({
      shared: { cardPreviewLines: "many" },
    });
    expect(mod.getUISettings().cardPreviewLines).toBe(
      mod.defaultUISettings.cardPreviewLines,
    );

    // 对象型只给了一半 → 与默认值合并，组件不会读到 undefined
    mod.applyUISettingsPackageFromServer({
      shared: { expandLongByView: { article: true } },
    });
    expect(mod.getUISettings().expandLongByView).toEqual({
      ...mod.defaultUISettings.expandLongByView,
      article: true,
    });
  });

  it("恢复默认：一次写入 + 两档设备值一起回到默认", async () => {
    const mod = await freshModule();
    mod.setUISetting("feedColWidth", 300);
    mod.setUISetting("cardPreviewLines", 9);

    const spy = spyOnStorageWrites();
    mod.resetUISettingsToDefaults();

    // 旧实现是 25 个键循环调 setUISetting（25 次写 + 25 次同步），这里必须是 1 次
    expect(spy.countOf("krss-ui-settings")).toBe(1);
    spy.restore();

    const raw = storedPackage();
    expect(raw.device?.desktop?.feedColWidth).toBe(
      mod.defaultUISettings.feedColWidth,
    );
    expect(raw.device?.mobile?.feedColWidth).toBe(
      mod.defaultUISettings.feedColWidth,
    );
    expect(raw.shared?.cardPreviewLines).toBe(
      mod.defaultUISettings.cardPreviewLines,
    );
    expect(mod.getUISettings().feedColWidth).toBe(
      mod.defaultUISettings.feedColWidth,
    );
  });

  it("hasSidebarVisibilitySetting：默认档（没存过）为 false，存过即 true", async () => {
    const mod = await freshModule();
    // 注意：本地缓存里没有 key ≠ 同步组没注册
    expect(mod.hasSidebarVisibilitySetting()).toBe(false);

    mod.setUISetting("sidebarVisible", false);
    expect(mod.hasSidebarVisibilitySetting()).toBe(true);
  });

  it("设备分套的键表就是那四项（多的不许往里塞）", async () => {
    const mod = await freshModule();
    expect([...mod.DEVICE_SCOPED_UI_KEYS]).toEqual([
      "feedColWidth",
      "entryColWidth",
      "uiScale",
      "sidebarVisible",
    ]);
  });
});
