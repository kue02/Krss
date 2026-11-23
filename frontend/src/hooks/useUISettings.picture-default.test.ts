import { describe, expect, it } from "vitest";
import { defaultUISettings } from "./useUISettings";

describe("图片视图默认布局", () => {
  it("未设置过布局时默认使用网格档", () => {
    expect(defaultUISettings.pictureLayout).toBe("grid");
  });
});
