import { describe, expect, it } from "vitest";
import {
  articlePaneFrameClasses,
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

describe("articlePaneFrameClasses（卡片档正文栏外框三档）", () => {
  it("default 保持现状：border-border/60 + shadow-nf", () => {
    expect(articlePaneFrameClasses("default")).toBe(
      "border border-border/60 shadow-nf",
    );
  });

  it("subtle 降为 40% 边框 + 极轻投影", () => {
    expect(articlePaneFrameClasses("subtle")).toBe(
      "border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
    );
  });

  it("none 去掉边框和投影", () => {
    expect(articlePaneFrameClasses("none")).toBe("border-0 shadow-none");
  });

  it("缺省/未知值按现状兜底，避免读回脏档位后没有外框", () => {
    expect(articlePaneFrameClasses(undefined)).toBe(
      "border border-border/60 shadow-nf",
    );
  });
});
