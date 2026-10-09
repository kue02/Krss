import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScrollReadSetting } from "./useScrollReadSetting";

/**
 * 2026-10-09「改法 A」的口径测试：
 * - 按视图覆盖**永远优先**（通用那一档只是默认值）；
 * - 四档取值 ↔ 既有关键字（scrollReadByView / scrollReadTimingByView / scrollReadMode）的映射；
 * - mode 退化成 UI 形态标记（有覆盖 → perView），不再参与解析。
 */
const state = vi.hoisted(() => ({
  ui: {} as Record<string, unknown>,
  setUISetting: vi.fn(),
  markReadOnScroll: true,
}));

vi.mock("@/hooks/useUISettings", () => ({
  useUISettingKey: (key: string) => state.ui[key],
  setUISetting: state.setUISetting,
  getUISettings: () => state.ui,
}));

vi.mock("@/hooks/useGeneralSettings", () => ({
  useGeneralSettings: () => ({ data: { markReadOnScroll: state.markReadOnScroll } }),
}));

const ALL_INHERIT = {
  article: "inherit",
  picture: "inherit",
  notification: "inherit",
  social: "inherit",
} as const;

const ALL_PAST = {
  article: "scrollPast",
  picture: "scrollPast",
  notification: "scrollPast",
  social: "scrollPast",
} as const;

describe("useScrollReadSetting（改法 A：不强制）", () => {
  beforeEach(() => {
    state.ui = { scrollReadByView: { ...ALL_INHERIT }, scrollReadTimingByView: { ...ALL_PAST } };
    state.markReadOnScroll = true;
    state.setUISetting.mockClear();
  });

  it("通用开着、没有覆盖时，四个视图都跟随通用", () => {
    const { result } = renderHook(() => useScrollReadSetting());
    expect(result.current.resolveFor("article")).toBe(true);
    expect(result.current.resolveFor("social")).toBe(true);
    expect(result.current.mode).toBe("on");
    expect(result.current.overrideCount).toBe(0);
  });

  it("通用关着、某视图覆盖成 on：该视图开，其余跟随通用（旧版这里会被通用压掉）", () => {
    state.markReadOnScroll = false;
    state.ui = {
      scrollReadByView: { ...ALL_INHERIT, notification: "on" },
      scrollReadTimingByView: { ...ALL_PAST },
    };
    const { result } = renderHook(() => useScrollReadSetting());
    expect(result.current.resolveFor("notification")).toBe(true);
    expect(result.current.resolveFor("article")).toBe(false);
    expect(result.current.mode).toBe("perView");
    expect(result.current.overrideCount).toBe(1);
    expect(result.current.anyViewEnabled).toBe(true);
  });

  it("通用开着、文章覆盖成 off：文章不随滚动标已读，其余照旧", () => {
    state.ui = {
      scrollReadByView: { ...ALL_INHERIT, article: "off" },
      scrollReadTimingByView: { ...ALL_PAST },
    };
    const { result } = renderHook(() => useScrollReadSetting());
    expect(result.current.resolveFor("article")).toBe(false);
    expect(result.current.resolveFor("picture")).toBe(true);
  });

  it("四档取值映射：inherit / clickOnly / scrollPast / onVisible", () => {
    state.ui = {
      scrollReadByView: { ...ALL_INHERIT, article: "off", picture: "on", notification: "on" },
      scrollReadTimingByView: { ...ALL_PAST, notification: "onVisible" },
    };
    const { result } = renderHook(() => useScrollReadSetting());
    expect(result.current.perViewChoice("article")).toBe("clickOnly");
    expect(result.current.perViewChoice("picture")).toBe("scrollPast");
    expect(result.current.perViewChoice("notification")).toBe("onVisible");
    expect(result.current.perViewChoice("social")).toBe("inherit");
  });

  it("选「点开才标已读」：写 scrollReadByView=off；没有别的覆盖时回落到跟随通用的形态", () => {
    const { result } = renderHook(() => useScrollReadSetting());
    result.current.setPerViewChoice("article", "clickOnly");

    expect(state.setUISetting).toHaveBeenCalledWith("scrollReadByView", {
      ...ALL_INHERIT,
      article: "off",
    });
    expect(state.setUISetting).toHaveBeenCalledWith("scrollReadMode", "on");
  });

  it("选「看到即已读」：同时写时机；还有别的视图被单独设过 → 形态记 perView", () => {
    state.ui = {
      scrollReadByView: { ...ALL_INHERIT, social: "off" },
      scrollReadTimingByView: { ...ALL_PAST },
    };
    const { result } = renderHook(() => useScrollReadSetting());
    result.current.setPerViewChoice("article", "onVisible");

    expect(state.setUISetting).toHaveBeenCalledWith("scrollReadByView", {
      ...ALL_INHERIT,
      social: "off",
      article: "on",
    });
    expect(state.setUISetting).toHaveBeenCalledWith("scrollReadTimingByView", {
      ...ALL_PAST,
      article: "onVisible",
    });
    expect(state.setUISetting).toHaveBeenCalledWith("scrollReadMode", "perView");
  });

  it("通用关着且没有任何覆盖时：任何视图都不会滚动标已读（anyViewEnabled=false）", () => {
    state.markReadOnScroll = false;
    const { result } = renderHook(() => useScrollReadSetting());
    expect(result.current.anyViewEnabled).toBe(false);
    expect(result.current.resolveFor("article")).toBe(false);
  });
});
