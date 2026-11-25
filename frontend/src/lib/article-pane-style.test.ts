import { describe, expect, it } from "vitest";
import {
  articlePaneFrameClasses,
  articlePaneStyleForFrame,
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

describe("articlePaneFrameClasses（正文栏外框）", () => {
  it("subtle 默认档：40% 边框 + 极轻投影", () => {
    expect(articlePaneFrameClasses("subtle")).toBe(
      "border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
    );
  });

  it("none 去掉卡片档边框和投影", () => {
    expect(articlePaneFrameClasses("none")).toBe("border-0 shadow-none");
  });

  it("full 由全宽分支处理，不叠加卡片外框", () => {
    expect(articlePaneFrameClasses("full")).toBe("");
  });
});

describe("articlePaneStyleForFrame（外框档位 → 容器形态）", () => {
  it("full 对应原来的「原样」全宽形态", () => {
    expect(articlePaneStyleForFrame("full")).toBe("plain");
  });

  it("subtle / none 都是卡片形态", () => {
    expect(articlePaneStyleForFrame("subtle")).toBe("card");
    expect(articlePaneStyleForFrame("none")).toBe("card");
  });
});
