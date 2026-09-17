import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * 用户第十一批 11-14：已读/未读标记要「全局统一、可切换」，并且有一档要用 HeroUI 的 Badge。
 * 这里钉住三档各自的渲染结果，以及「变灰」档只由行类负责（组件本身不出标记）。
 */
const settings: Record<string, unknown> = { unreadStyle: "badge" };

vi.mock("@/hooks/useUISettings", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useUISettings")>(
    "@/hooks/useUISettings",
  );
  return {
    ...actual,
    useUISettingKey: (key: string) => settings[key],
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { UnreadIndicator, unreadRowClass } from "./unread-indicator";

afterEach(() => {
  cleanup();
  settings.unreadStyle = "badge";
});

describe("已读/未读标记", () => {
  it("角标档：未读渲染 HeroUI Badge，已读什么都不渲染", () => {
    settings.unreadStyle = "badge";
    const { unmount } = render(<UnreadIndicator unread />);
    expect(
      document.querySelector('[data-unread-marker="badge"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-unread-marker="dot"]')).toBeNull();
    expect(screen.getByText("entry.unread")).toBeTruthy();
    unmount();

    render(<UnreadIndicator unread={false} />);
    expect(
      document.querySelector('[data-unread-marker="badge"]'),
    ).toBeNull();
  });

  it("小圆点档：渲染圆点、不出角标", () => {
    settings.unreadStyle = "dot";
    render(<UnreadIndicator unread />);
    expect(document.querySelector('[data-unread-marker="dot"]')).not.toBeNull();
    expect(document.querySelector('[data-unread-marker="badge"]')).toBeNull();
  });

  it("变灰档：组件不出任何标记（透明度交给 unreadRowClass）", () => {
    settings.unreadStyle = "dim";
    render(<UnreadIndicator unread />);
    expect(document.querySelector('[data-unread-marker="dot"]')).toBeNull();
    expect(document.querySelector('[data-unread-marker="badge"]')).toBeNull();
  });

  it("unreadRowClass：只有「变灰」档 + 已读 + 未加星 + 未选中才降透明度", () => {
    expect(unreadRowClass(false, false, false, "dim")).toBe("opacity-[0.78]");
    expect(unreadRowClass(true, false, false, "dim")).toBe(""); // 未读不降
    expect(unreadRowClass(false, true, false, "dim")).toBe(""); // 加星不降
    expect(unreadRowClass(false, false, true, "dim")).toBe(""); // 选中不降
    expect(unreadRowClass(false, false, false, "badge")).toBe(""); // 非变灰档不降
  });
});
