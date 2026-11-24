import { describe, expect, it } from "vitest";
import { headerBackgroundBlurFor } from "./article-pane-style";

describe("headerBackgroundBlurFor（正文栏样式 → 内联工具栏是否保留模糊）", () => {
  it("卡片档（overflow:clip）关掉模糊，避免圆角边框合成出错", () => {
    expect(headerBackgroundBlurFor("card")).toBe(false);
  });

  it("原样档（clip-path）保留模糊", () => {
    expect(headerBackgroundBlurFor("plain")).toBe(true);
  });

  it("缺省按卡片档处理", () => {
    expect(headerBackgroundBlurFor(undefined)).toBe(false);
  });
});
