import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobileTabBar } from "./MobileTabBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: () => ({ data: undefined }),
}));

vi.mock("@/hooks/useEntries", () => ({
  useUnreadCounts: () => ({ data: undefined }),
}));

const ALL_TYPES = ["article", "picture", "notification", "social"] as const;

function setScrollY(value: number) {
  Object.defineProperty(window, "scrollY", {
    value,
    writable: true,
    configurable: true,
  });
}

function renderTabBar() {
  return render(
    <MobileTabBar
      contentType="article"
      visibleContentTypes={[...ALL_TYPES]}
      onSelect={() => {}}
    />,
  );
}

function getNav() {
  return screen.getByRole("navigation");
}

/**
 * 底栏是否收起，只看对外可观测的契约：`data-state` 语义值 + `inert`。
 * 不锁 className —— 换等价实现（inline transform、纯 CSS）不该让测试变红。
 */
function expectHidden() {
  const nav = getNav();
  expect(nav.getAttribute("data-state")).toBe("hidden");
  expect(nav.getAttribute("inert")).not.toBeNull();
}

function expectVisible() {
  const nav = getNav();
  expect(nav.getAttribute("data-state")).toBe("open");
  expect(nav.getAttribute("inert")).toBeNull();
}

/** 派发一次滚动到指定位置（window.scrollY 已先设好）。 */
function scrollTo(y: number) {
  setScrollY(y);
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("MobileTabBar 收起逻辑", () => {
  beforeEach(() => {
    setScrollY(0);
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setScrollY(0);
  });

  it("向下滚动收起、向上滚动展开", () => {
    renderTabBar();
    expectVisible();

    scrollTo(400);
    expectHidden();

    advance(400);
    scrollTo(300);
    expectVisible();
  });

  it("方向静默期内滑回顶部也会立即展开（到顶判定排在静默期之前）", () => {
    renderTabBar();
    scrollTo(400);
    expectHidden();

    // 静默期尚未结束就滑回顶部：旧实现会在 update() 首行直接 return，底栏卡住
    scrollTo(0);
    expectVisible();
  });

  it("静默期结束后的首帧不会用陈旧基准误判方向", () => {
    renderTabBar();
    scrollTo(400);
    advance(400);
    // 静默期内继续向下滚到 1200（旧实现不更新 last）
    scrollTo(1200);
    advance(400);
    // 真正向上滚一点点，应该展开而不是因为 dy 巨大再次收起
    scrollTo(1190);
    expectVisible();
  });

  it("滚动落地校正（140ms）就能把到顶的底栏叫回来", () => {
    renderTabBar();
    scrollTo(400);
    expectHidden();

    // 位置已经回到 0，但这次 scroll 被静默期吞掉；只让 settle 定时器有机会跑
    setScrollY(0);
    advance(200);
    expectVisible();
  });

  it("完全不派发 scroll 时，一次性兜底校正也能展开", () => {
    renderTabBar();
    scrollTo(400);
    // 先把 settle 定时器耗掉（此时位置仍是 400，不会展开）
    advance(200);
    expectHidden();

    // 位置变了但没有任何 scroll 事件：只剩 600ms 的一次性兜底
    setScrollY(0);
    advance(600);
    expectVisible();
  });

  it("页面从缓存恢复（pageshow）时按真实位置复位", () => {
    renderTabBar();
    scrollTo(1200);
    expectHidden();

    // bfcache 恢复：位置被浏览器换成 0，不派发 scroll
    setScrollY(0);
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expectVisible();
  });

  it("resize 只校正基准、不清方向静默期（避免地址栏收放时闪动）", () => {
    renderTabBar();
    scrollTo(400);
    expectHidden();

    // iOS 地址栏收缩触发 resize：旧实现会清掉静默期
    setScrollY(390);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    // 静默期仍在，向上 10px 不该把底栏闪出来
    scrollTo(380);
    expectHidden();
  });

  it("resize 发生在顶部时仍然直接展开", () => {
    renderTabBar();
    scrollTo(400);
    expectHidden();

    setScrollY(0);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expectVisible();
  });

  it("切换内容类型时按当前滚动位置复位", () => {
    const { rerender } = renderTabBar();
    scrollTo(400);
    expectHidden();

    setScrollY(0);
    rerender(
      <MobileTabBar
        contentType="picture"
        visibleContentTypes={[...ALL_TYPES]}
        onSelect={() => {}}
      />,
    );
    expectVisible();
  });

  it("收起时不参与命中测试与朗读", () => {
    renderTabBar();
    scrollTo(400);
    expectHidden();

    advance(400);
    scrollTo(0);
    expectVisible();
  });

  it("点击 tab 回调内容类型", () => {
    const onSelect = vi.fn();
    render(
      <MobileTabBar
        contentType="article"
        visibleContentTypes={[...ALL_TYPES]}
        onSelect={onSelect}
      />,
    );
    // CONTENT_TYPE_ORDER 是 article / social / picture / notification
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[2]!);
    expect(onSelect).toHaveBeenCalledWith("picture");
  });
});
