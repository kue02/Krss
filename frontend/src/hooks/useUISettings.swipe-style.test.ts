import { describe, expect, it } from "vitest";
import {
  applyUISettingsPackageFromServer,
  getUISettings,
} from "./useUISettings";

describe("mobileSwipeActionStyle sanitize", () => {
  it("合法枚举保留", () => {
    applyUISettingsPackageFromServer({
      shared: { mobileSwipeActionStyle: "circle" },
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().mobileSwipeActionStyle).toBe("circle");
  });

  it("非法枚举回落默认 flat，避免设置页一个都不选中", () => {
    applyUISettingsPackageFromServer({
      shared: { mobileSwipeActionStyle: "CIRCLE" },
      device: { desktop: {}, mobile: {} },
    });
    expect(getUISettings().mobileSwipeActionStyle).toBe("flat");
  });
});
