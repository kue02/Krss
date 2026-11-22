import { beforeEach, describe, expect, it } from "vitest";
import { applyUISettingsPackageFromServer, getUISettings } from "./useUISettings";

/**
 * 22-2 附带修：**主题色要能从「整包」里活下来**。
 *
 * 21 批把界面设置改成「整包（shared / device.desktop / device.mobile）读写 + 收窄闸门」，
 * 闸门是拿 `typeof 默认值` 比 `typeof 值`：`accentColor` 的值可以是 `null`（「跟随主题」，
 * `typeof` = `"object"`）或 `"#RRGGBB"`（`"string"`）。因为显式 null 表示跟随主题，
 * 不能参与 `typeof` 比对，必须在类型闸门前单独放行（见 NULLABLE_STRING_KEYS）。
 * 这条用例钉住：服务端/本地那份包里带 accentColor 时，读出来必须是它；显式 null 仍能保留。
 */
describe("主题色跟随整包落盘/回灌", () => {
  beforeEach(() => {
    applyUISettingsPackageFromServer({
      shared: { accentColor: null },
      device: { desktop: {}, mobile: {} },
    });
  });

  it("新装默认强调色是 #000000（与生产实例一致）", () => {
    applyUISettingsPackageFromServer({
      shared: {},
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().accentColor).toBe("#000000");
  });

  it("服务端整包里的 accentColor 会被应用（不再被类型闸门丢掉）", () => {
    applyUISettingsPackageFromServer({
      shared: { accentColor: "#5504F7", cardPreviewLines: 3 },
      device: { desktop: {}, mobile: {} },
    });

    expect(getUISettings().accentColor).toBe("#5504F7");
    expect(getUISettings().cardPreviewLines).toBe(3);
  });

  it("显式 null 仍是「跟随主题」", () => {
    applyUISettingsPackageFromServer({
      shared: { accentColor: "#5504F7" },
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().accentColor).toBe("#5504F7");

    applyUISettingsPackageFromServer({
      shared: { accentColor: null },
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().accentColor).toBeNull();
  });

  it("形状不对的包不动本地（宁可不动也不要清空）", () => {
    applyUISettingsPackageFromServer({
      shared: { accentColor: "#10b981" },
      device: { desktop: {}, mobile: {} },
    });

    applyUISettingsPackageFromServer("not-a-package");

    expect(getUISettings().accentColor).toBe("#10b981");
  });
});
