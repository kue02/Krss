import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryListHeader } from "./EntryListHeader";

// 与 EntryListHeader.test.tsx 同一套桩：t 直接回键名，断言只看结构
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/useScrollToTop", () => ({
  dispatchScrollToTop: vi.fn(),
}));

const baseProps = {
  title: "少数派",
  unreadCount: 0,
  unreadOnly: false,
  onToggleUnreadOnly: vi.fn(),
  onMarkAllRead: vi.fn(),
};

/**
 * 52-4（用户第 4 条）：从条目的「订阅源名称/图标」点进订阅后，列表头要能给一颗「返回」，
 * 点了回到跳转前的样子（上一个选中的是文件夹就回文件夹）。
 *
 * 按钮只在父级传了 `onBackFromFeedJump`（= 确实是跳进来的）时渲染 ——
 * 与 articleLayout / pictureLayout 那两颗档位按钮同一口径：不传就不出现。
 */
describe("EntryListHeader 返回按钮（52-4）", () => {
  it("没传回调 → 不渲染返回按钮", () => {
    render(<EntryListHeader {...baseProps} />);
    expect(screen.queryByTitle("entry.back_to_previous")).toBeNull();
  });

  it("传了回调 → 渲染按钮，点击只触发回调一次", () => {
    const onBack = vi.fn();
    render(<EntryListHeader {...baseProps} onBackFromFeedJump={onBack} />);
    const button = screen.getByTitle("entry.back_to_previous");
    fireEvent.click(button);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
