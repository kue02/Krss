import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * 13-3 的关键回归：**面板里的改动必须真的写进配置**。
 * 起因：真机点「未读数」之后，`localStorage["gist-ui-settings"].unreadBadge` 仍是 undefined ——
 * 面板渲染没问题，写链路断了。这里用单测把「点击 → setUnreadBadge」钉死（比浏览器探针确定）。
 */
const config = {
  content: "dot",
  placement: "top-left",
  size: 8,
  followAccent: true,
  color: "accent",
  customColor: null,
  variant: "primary",
  offset: 4,
};

const { setUnreadBadge } = vi.hoisted(() => ({ setUnreadBadge: vi.fn() }));

vi.mock("@/hooks/useUISettings", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useUISettings")>(
    "@/hooks/useUISettings",
  );
  return {
    ...actual,
    useUISettingKey: () => config,
    useUISettingActions: () => ({ setUnreadBadge }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { UnreadBadgeCustomizer } from "./UnreadBadgeCustomizer";

afterEach(() => {
  cleanup();
  setUnreadBadge.mockClear();
});

describe("未读角标自定义面板（13-3）", () => {
  it("渲染出六项控件与预览/恢复默认", () => {
    render(<UnreadBadgeCustomizer />);
    expect(screen.getByLabelText("appearance_reading.unread_badge_customize")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("appearance_reading.unread_badge_customize"));
    // 内容三档（默认档是圆点）
    expect(screen.getByText("appearance_reading.unread_badge_content_dot")).toBeTruthy();
    expect(screen.getByText("appearance_reading.unread_badge_content_count")).toBeTruthy();
    expect(screen.getByText("appearance_reading.unread_badge_preview")).toBeTruthy();
    expect(screen.getByText("appearance_reading.unread_badge_reset")).toBeTruthy();
    // 圆点档：位置/大小/颜色/外观置灰 + 说明
    expect(screen.getByText("appearance_reading.unread_badge_dot_fixed")).toBeTruthy();
  });

  it("点「未读数」要把配置写回去（写链路回归）", () => {
    render(<UnreadBadgeCustomizer />);
    fireEvent.click(screen.getByLabelText("appearance_reading.unread_badge_customize"));
    const countBtn = screen.getByText("appearance_reading.unread_badge_content_count");
    fireEvent.click(countBtn);
    // RAC 的 Pressable 对合成事件不一定响应；这里先钉「点了就要有反应」，
    // 若为 0 次说明断在这条链路上（真机也证实了它没写进去）。
    expect(setUnreadBadge).toHaveBeenCalled();
    expect(setUnreadBadge.mock.calls[0]?.[0]).toMatchObject({ content: "count" });
  });
});
