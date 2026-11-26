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

/** 派发一次滚动到指定位置（window.scrollY 已先设好）。 */
function scrollTo(y: number) {
  setScrollY(y);
  act(() => {
    window.dispatchEvent(new Event("scroll"));
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
    expect(getNav().className).toContain("translate-y-0");

    scrollTo(400);
    expect(getNav().className).toContain("translate-y-full");
    expect(getNav().getAttribute("data-hidden")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    scrollTo(300);
    expect(getNav().className).toContain("translate-y-0");
  });

  it("方向静默期内滑回顶部也会立即展开（到顶判定排在静默期之前）", () => {
    renderTabBar();
    // 先向下滚，进入 300ms 方向静默期并收起
    scrollTo(400);
    expect(getNav().className).toContain("translate-y-full");

    // 静默期尚未结束就滑回顶部：旧实现会在 update() 首行直接 return，底栏卡住
    scrollTo(0);
    expect(getNav().className).toContain("translate-y-0");
    expect(getNav().getAttribute("data-hidden")).toBeNull();
  });

  it("静默期结束后的首帧不会用陈旧基准误判方向", () => {
    renderTabBar();
    scrollTo(400);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // 静默期内继续向下滚到 1200（旧实现不更新 last）
    scrollTo(1200);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // 真正向上滚一点点，应该展开而不是因为 dy 巨大再次收起
    scrollTo(1190);
    expect(getNav().className).toContain("translate-y-0");
  });

  it("收起后滚动停住不再有 scroll 事件，落地校正也会展开到顶的底栏", () => {
    renderTabBar();
    scrollTo(400);
    expect(getNav().className).toContain("translate-y-full");

    // 模拟「惯性滚动/程序化回顶」：位置已到 0，但只有一次 scroll 被静默期吞掉
    setScrollY(0);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(getNav().className).toContain("translate-y-0");
  });

  it("收起状态下完全不派发 scroll 时，兜底轮询也能展开", () => {
    renderTabBar();
    scrollTo(400);
    expect(getNav().className).toContain("translate-y-full");

    setScrollY(0);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(getNav().className).toContain("translate-y-0");
  });

  it("切换内容类型时按当前滚动位置复位", () => {
    const { rerender } = renderTabBar();
    scrollTo(400);
    expect(getNav().className).toContain("translate-y-full");

    setScrollY(0);
    rerender(
      <MobileTabBar
        contentType="picture"
        visibleContentTypes={[...ALL_TYPES]}
        onSelect={() => {}}
      />,
    );
    expect(getNav().className).toContain("translate-y-0");
  });

  it("收起时不参与命中测试与朗读", () => {
    renderTabBar();
    scrollTo(400);
    const nav = getNav();
    expect(nav.getAttribute("inert")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    scrollTo(0);
    expect(getNav().getAttribute("inert")).toBeNull();
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
