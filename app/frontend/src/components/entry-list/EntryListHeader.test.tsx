import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryListHeader } from "./EntryListHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/useScrollToTop", () => ({
  dispatchScrollToTop: vi.fn(),
}));

const baseProps = {
  title: "全部文章",
  unreadCount: 12,
  unreadOnly: false,
  onToggleUnreadOnly: vi.fn(),
  onMarkAllRead: vi.fn(),
};

function refreshButton() {
  return screen.getByTitle("entry.refresh_view");
}

describe("EntryListHeader 刷新按钮", () => {
  it("非刷新态：普通刷新图标，没有进度数字", () => {
    render(<EntryListHeader {...baseProps} onRefresh={vi.fn()} />);

    const button = refreshButton();
    expect(button.querySelector(".animate-spin")).toBeNull();
    expect(button.textContent).toBe("");
  });

  it("刷新中：图标持续转圈，圈内显示「还剩几个源」", () => {
    render(
      <EntryListHeader
        {...baseProps}
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={23}
        refreshCompleted={8}
      />,
    );

    const button = refreshButton();
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("15");
  });

  it("刷新中：每完成一个源，圈内数字减一", () => {
    const { rerender } = render(
      <EntryListHeader
        {...baseProps}
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={3}
        refreshCompleted={0}
      />,
    );
    expect(refreshButton().textContent).toBe("3");

    rerender(
      <EntryListHeader
        {...baseProps}
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={3}
        refreshCompleted={1}
      />,
    );
    expect(refreshButton().textContent).toBe("2");

    rerender(
      <EntryListHeader
        {...baseProps}
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={3}
        refreshCompleted={3}
      />,
    );
    expect(refreshButton().textContent).toBe("0");
  });

  it("刷新中：进度取不到（total 为 0）时不显示负数", () => {
    render(
      <EntryListHeader
        {...baseProps}
        onRefresh={vi.fn()}
        isRefreshing
        refreshTotal={0}
        refreshCompleted={5}
      />,
    );
    expect(refreshButton().textContent).toBe("0");
  });

  it("点击刷新按钮会触发 onRefresh", () => {
    const onRefresh = vi.fn();
    render(<EntryListHeader {...baseProps} onRefresh={onRefresh} />);

    fireEvent.click(refreshButton());
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("不传 onRefresh 时不渲染刷新按钮", () => {
    render(<EntryListHeader {...baseProps} />);
    expect(screen.queryByTitle("entry.refresh_view")).toBeNull();
  });
});
