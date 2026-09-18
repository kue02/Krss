import { describe, it, expect, beforeEach } from "vitest";
import {
  clearDirtySettings,
  getDirtySettings,
  registerSettingsDirty,
} from "./settings-dirty-store";

/**
 * 12-7：表单型设置页的「未保存」登记表。
 * 关键是三条：登记了能查到、注销后查不到、离开时能一次清空（「放弃更改」用）。
 */
describe("设置页未保存登记表", () => {
  beforeEach(() => clearDirtySettings());

  it("登记 / 注销", () => {
    expect(getDirtySettings()).toHaveLength(0);
    registerSettingsDirty("ai", { label: "AI", save: () => {} });
    registerSettingsDirty("network", { label: "网络" });
    expect(getDirtySettings().map((e) => e.label)).toEqual(["AI", "网络"]);

    registerSettingsDirty("network", null);
    expect(getDirtySettings().map((e) => e.label)).toEqual(["AI"]);
  });

  it("navigate 前清空（放弃更改）", () => {
    registerSettingsDirty("ai", { label: "AI" });
    registerSettingsDirty("rsshub", { label: "RSSHub" });
    clearDirtySettings();
    expect(getDirtySettings()).toHaveLength(0);
  });

  it("重复登记同一页不会出现两条", () => {
    registerSettingsDirty("ai", { label: "AI" });
    registerSettingsDirty("ai", { label: "AI" });
    expect(getDirtySettings()).toHaveLength(1);
  });
});
