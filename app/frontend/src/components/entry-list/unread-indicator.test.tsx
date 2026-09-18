import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * 用户第十一批 11-14：已读/未读标记要「全局统一、可切换」，并且有一档要用 HeroUI 的 Badge。
 * 这里钉住三档各自的渲染结果，以及「变灰」档只由行类负责（组件本身不出标记）。
 */
const settings: Record<string, unknown> = {
  unreadStyle: "badge",
  // 13-3：角标配置（默认档 = 小圆点，固定外观）
  unreadBadge: {
    content: "dot",
    placement: "top-left",
    size: 8,
    followAccent: true,
    color: "accent",
    customColor: null,
    variant: "primary",
    offset: 4,
  },
};

/** 12-2 起标记是挂在「条目图标」上的 —— 测试里给个假图标当锚点 */
const icon = <span data-testid="entry-icon" />;

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
  it("角标档默认内容=小圆点：渲染 HeroUI Badge（无文字），已读什么都不渲染", () => {
    settings.unreadStyle = "badge";
    const { unmount } = render(<UnreadIndicator unread>{icon}</UnreadIndicator>);
    // 13-3：默认档就是圆点（用户裁定「小圆点是设置成默认的，是一个单独的样式、不变的」）
    const badge = document.querySelector('[data-unread-marker="dot"]');
    expect(badge).not.toBeNull();
    // 12-14：标记是小圆点，不再是「未读」字样
    expect(badge!.textContent).toBe("");
    // 挂在图标上：图标还在，外面是 HeroUI 的 Badge.Anchor
    expect(screen.getByTestId("entry-icon")).toBeTruthy();
    expect(document.querySelector('[data-slot="badge-anchor"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="badge"]')).not.toBeNull();
    // 位置：用户 12-2 明确要「图标左上角」
    expect(badge!.className).toContain("top-left");
    unmount();

    render(<UnreadIndicator unread={false}>{icon}</UnreadIndicator>);
    expect(document.querySelector('[data-unread-marker="dot"]')).toBeNull();
    expect(screen.getByTestId("entry-icon")).toBeTruthy();
  });

  it("小圆点档：渲染圆点、不出角标", () => {
    settings.unreadStyle = "dot";
    render(<UnreadIndicator unread>{icon}</UnreadIndicator>);
    const dot = document.querySelector('[data-unread-marker="dot"]');
    expect(dot).not.toBeNull();
    expect(document.querySelector('[data-unread-marker="badge"]')).toBeNull();
    // 点状徽标 = 官方「空内容 Badge」，不该有文字
    expect(dot!.textContent).toBe("");
  });

  it("变灰档：组件不出任何标记（透明度交给 unreadRowClass）", () => {
    settings.unreadStyle = "dim";
    render(<UnreadIndicator unread>{icon}</UnreadIndicator>);
    expect(document.querySelector('[data-unread-marker="dot"]')).toBeNull();
    expect(document.querySelector('[data-unread-marker="badge"]')).toBeNull();
    expect(screen.getByTestId("entry-icon")).toBeTruthy();
  });

  it("unreadRowClass：只有「变灰」档 + 已读 + 未加星 + 未选中才降透明度", () => {
    expect(unreadRowClass(false, false, false, "dim")).toBe("opacity-[0.78]");
    expect(unreadRowClass(true, false, false, "dim")).toBe(""); // 未读不降
    expect(unreadRowClass(false, true, false, "dim")).toBe(""); // 加星不降
    expect(unreadRowClass(false, false, true, "dim")).toBe(""); // 选中不降
    expect(unreadRowClass(false, false, false, "badge")).toBe(""); // 非变灰档不降
  });
});

describe("13-3 角标可自定义（渲染器按配置走）", () => {
  const base = {
    content: "count" as const,
    placement: "top-right" as const,
    size: 12,
    followAccent: true,
    color: "accent" as const,
    customColor: null,
    variant: "soft" as const,
    offset: 6,
  };

  it("内容=未读数：出数字角标、按 px 定尺寸、位置/外观跟着配置走", () => {
    settings.unreadStyle = "badge";
    settings.unreadBadge = { ...base };
    render(
      <UnreadIndicator unread count={12}>
        {icon}
      </UnreadIndicator>,
    );
    const marker = document.querySelector('[data-unread-marker="count"]');
    expect(marker).not.toBeNull();
    expect(marker!.textContent).toContain("12");
    // 尺寸按 px（不清 min-* 会被 HeroUI sm 的 16px 顶回去 —— 12-14 踩过）
    expect(marker!.getAttribute("style") || "").toContain("12px");
    expect(marker!.className).toContain("min-h-0");
    // 位置与外观来自配置
    expect(marker!.className).toContain("top-right");
    expect(marker!.className).toContain("soft");
  });

  it("未读数 > 99 显示 99+", () => {
    settings.unreadBadge = { ...base };
    render(
      <UnreadIndicator unread count={150}>
        {icon}
      </UnreadIndicator>,
    );
    const marker = document.querySelector('[data-unread-marker="count"]');
    expect(marker!.textContent).toContain("99+");
  });

  it("内容=图标：出 svg、不出数字", () => {
    settings.unreadBadge = { ...base, content: "icon" as const };
    render(<UnreadIndicator unread>{icon}</UnreadIndicator>);
    const marker = document.querySelector('[data-unread-marker="icon"]');
    expect(marker).not.toBeNull();
    expect(marker!.querySelector("svg")).not.toBeNull();
    expect(marker!.textContent).toBe("");
  });
});

