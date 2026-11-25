import { describe, expect, it } from "vitest";
import {
  applyUISettingsPackageFromServer,
  getUISettings,
} from "./useUISettings";

/**
 * 正文栏外框合并旧「原样」档后的兼容：老包里的 articlePaneStyle=plain 必须还用户全宽，
 * 旧的 default（现状）迁成新默认 subtle，脏档位回落 subtle。
 */
describe("正文栏外框（articlePaneFrame）迁移与收窄", () => {
  it("老 articlePaneStyle=plain 迁成 full（原样全宽）", () => {
    applyUISettingsPackageFromServer({
      shared: { articlePaneStyle: "plain" },
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().articlePaneFrame).toBe("full");
  });

  it("旧 default 档迁成新默认 subtle", () => {
    applyUISettingsPackageFromServer({
      shared: { articlePaneFrame: "default" },
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().articlePaneFrame).toBe("subtle");
  });

  it("合法档位原样保留", () => {
    applyUISettingsPackageFromServer({
      shared: { articlePaneFrame: "none" },
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().articlePaneFrame).toBe("none");
  });

  it("不认识的脏档位回落默认 subtle", () => {
    applyUISettingsPackageFromServer({
      shared: { articlePaneFrame: "ghost" },
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().articlePaneFrame).toBe("subtle");
  });
});
