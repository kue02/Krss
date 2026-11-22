import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentType } from "@/types/api";
import {
  MOBILE_TAB_SCROLL_TOP_THRESHOLD,
  applyMobileTabTap,
  getMobileListScrollTop,
  isMobileListAtTop,
  resolveMobileTabTap,
  scrollScopeForType,
} from "./mobile-tab-scroll";

function setScrollTop(value: number): void {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value,
  });
  document.documentElement.scrollTop = value;
}

beforeEach(() => {
  setScrollTop(0);
});

afterEach(() => {
  setScrollTop(0);
});

describe("移动端列表滚动位置", () => {
  it.each([
    [0, true],
    [7, true],
    [8, true],
    [500, false],
  ])("滚动 %ipx → atTop=%s（默认阈值 8）", (scrollTop, expected) => {
    setScrollTop(scrollTop);

    expect(MOBILE_TAB_SCROLL_TOP_THRESHOLD).toBe(8);
    expect(getMobileListScrollTop()).toBe(scrollTop);
    expect(isMobileListAtTop()).toBe(expected);
  });

  it("阈值可覆盖：9px 在默认阈值下算滚动过，在 12px 阈值下仍算顶部", () => {
    setScrollTop(9);

    expect(isMobileListAtTop()).toBe(false);
    expect(isMobileListAtTop(12)).toBe(true);
  });

  it("window.scrollY 为 0 时回落到 documentElement.scrollTop", () => {
    setScrollTop(0);
    document.documentElement.scrollTop = 320;

    expect(getMobileListScrollTop()).toBe(320);
    expect(isMobileListAtTop()).toBe(false);
  });
});

describe("内容类型 → 回顶部 scope", () => {
  it.each([
    ["article", "entrylist"],
    ["notification", "entrylist"],
    ["social", "entrylist"],
    ["picture", "picture"],
  ] satisfies Array<[ContentType, string]>)("%s → %s", (type, scope) => {
    expect(scrollScopeForType(type)).toBe(scope);
  });
});

describe("底栏点击判定", () => {
  const base = {
    isActiveTab: true,
    hasPluginView: false,
    selectionIsAll: false,
    scrollTop: 0,
  };

  it("点其他 tab：无论滚到哪里都切到该类型全部", () => {
    expect(
      resolveMobileTabTap({
        ...base,
        isActiveTab: false,
        scrollTop: 500,
      }),
    ).toBe("select-all");
  });

  it("点当前 tab 且列表已下滚：只回顶部", () => {
    expect(resolveMobileTabTap({ ...base, scrollTop: 500 })).toBe(
      "scroll-to-top",
    );
  });

  it("8px 仍算顶部：当前 tab 才切「全部」", () => {
    expect(resolveMobileTabTap({ ...base, scrollTop: 8 })).toBe("select-all");
  });

  it("已在顶部且已是「全部」、无插件视图：什么都不做", () => {
    expect(
      resolveMobileTabTap({ ...base, selectionIsAll: true, scrollTop: 0 }),
    ).toBe("noop");
  });

  it("已在顶部但当前是订阅/文件夹/星标：切到「全部」", () => {
    expect(
      resolveMobileTabTap({
        ...base,
        selectionIsAll: false,
        scrollTop: 0,
      }),
    ).toBe("select-all");
  });

  it("插件视图开着且已在顶部：走「切全部」以退出插件视图（与旧行为等价）", () => {
    expect(
      resolveMobileTabTap({
        ...base,
        hasPluginView: true,
        selectionIsAll: false,
      }),
    ).toBe("select-all");
  });

  it("插件视图不特判：文档已下滚时仍先回顶部", () => {
    expect(
      resolveMobileTabTap({
        ...base,
        hasPluginView: true,
        selectionIsAll: false,
        scrollTop: 500,
      }),
    ).toBe("scroll-to-top");
  });
});

describe("底栏点击副作用", () => {
  function spies() {
    return {
      scrollToTop: vi.fn<(scope: "entrylist" | "picture") => void>(),
      closePluginView: vi.fn<() => void>(),
      selectAll: vi.fn<() => void>(),
    };
  }

  it("已滚动时点当前 tab：只 dispatchScrollToTop、不调用 selectAll", () => {
    const s = spies();

    const action = applyMobileTabTap({
      type: "article",
      isActiveTab: true,
      hasPluginView: false,
      selectionIsAll: false,
      scrollTop: 500,
      ...s,
    });

    expect(action).toBe("scroll-to-top");
    expect(s.scrollToTop).toHaveBeenCalledOnce();
    expect(s.scrollToTop).toHaveBeenCalledWith("entrylist");
    expect(s.selectAll).not.toHaveBeenCalled();
    expect(s.closePluginView).not.toHaveBeenCalled();
  });

  it("图片瀑布流回顶部走 picture scope", () => {
    const s = spies();

    applyMobileTabTap({
      type: "picture",
      isActiveTab: true,
      hasPluginView: false,
      selectionIsAll: false,
      scrollTop: 500,
      ...s,
    });

    expect(s.scrollToTop).toHaveBeenCalledWith("picture");
  });

  it("点其他 tab：不滚动，直接切全部", () => {
    const s = spies();

    applyMobileTabTap({
      type: "social",
      isActiveTab: false,
      hasPluginView: false,
      selectionIsAll: false,
      scrollTop: 500,
      ...s,
    });

    expect(s.scrollToTop).not.toHaveBeenCalled();
    expect(s.selectAll).toHaveBeenCalledOnce();
    expect(s.closePluginView).not.toHaveBeenCalled();
  });

  it("已在顶部且已是全部：无副作用（不产生无意义导航）", () => {
    const s = spies();

    const action = applyMobileTabTap({
      type: "notification",
      isActiveTab: true,
      hasPluginView: false,
      selectionIsAll: true,
      scrollTop: 0,
      ...s,
    });

    expect(action).toBe("noop");
    expect(s.scrollToTop).not.toHaveBeenCalled();
    expect(s.selectAll).not.toHaveBeenCalled();
    expect(s.closePluginView).not.toHaveBeenCalled();
  });

  it("插件视图开着：先退出插件视图，再切全部", () => {
    const s = spies();

    applyMobileTabTap({
      type: "article",
      isActiveTab: true,
      hasPluginView: true,
      selectionIsAll: false,
      scrollTop: 0,
      ...s,
    });

    expect(s.closePluginView).toHaveBeenCalledOnce();
    expect(s.selectAll).toHaveBeenCalledOnce();

    const [closeOrder] = s.closePluginView.mock.invocationCallOrder;
    const [selectOrder] = s.selectAll.mock.invocationCallOrder;
    expect(closeOrder).toBeDefined();
    expect(selectOrder).toBeDefined();
    expect(Number(closeOrder)).toBeLessThan(Number(selectOrder));
  });
});