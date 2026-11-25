import { describe, expect, it } from "vitest";
import {
  headerBackgroundBlurFor,
  headerBackgroundRoundedTopFor,
} from "./article-pane-style";

describe("headerBackgroundBlurFor（正文栏样式 → 内联工具栏是否保留模糊）", () => {
  it("卡片档现在也保留模糊（模糊层自带圆角可裁住 backdrop-filter）", () => {
    expect(headerBackgroundBlurFor("card")).toBe(true);
  });

  it("原样档（clip-path）保留模糊", () => {
    expect(headerBackgroundBlurFor("plain")).toBe(true);
  });

  it("缺省按卡片档处理，同样保留模糊", () => {
    expect(headerBackgroundBlurFor(undefined)).toBe(true);
  });
});

describe("headerBackgroundRoundedTopFor（背景层是否自带顶部圆角）", () => {
  it("卡片档 + 正文栏非贴顶 → 自带 12px 顶角", () => {
    expect(headerBackgroundRoundedTopFor("card", false)).toBe(true);
  });

  it("缺省（卡片档）+ 非贴顶 → 自带 12px 顶角", () => {
    expect(headerBackgroundRoundedTopFor(undefined, false)).toBe(true);
  });

  it("卡片档 + 贴顶（pane 直角全宽）→ 不补圆角", () => {
    expect(headerBackgroundRoundedTopFor("card", true)).toBe(false);
  });

  it("原样档由 clip-path 裁圆角，不需要背景层自带圆角", () => {
    expect(headerBackgroundRoundedTopFor("plain", false)).toBe(false);
    expect(headerBackgroundRoundedTopFor("plain", true)).toBe(false);
  });
});
