import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { AdvancedSettings } from "./AdvancedSettings";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock("@/api", () => ({
  ApiError: class extends Error {},
  getDomainRateLimits: vi.fn(async () => ({ items: [] })),
  createDomainRateLimit: vi.fn(),
  updateDomainRateLimit: vi.fn(),
  deleteDomainRateLimit: vi.fn(),
  getFetchSettings: vi.fn(async () => ({
    intervalMinutes: 15,
    concurrency: 8,
    perHostConcurrency: 6,
    timeoutSeconds: 15,
  })),
  updateFetchSettings: vi.fn(),
}));

const RECORD = {
  at: new Date().toISOString(),
  trigger: "auto" as const,
  created: 12,
  updated: 760,
  failed: 1,
  results: [
    { feedId: "f1", title: "小众软件", new: 3, updated: 120 },
    {
      feedId: "f2",
      title: "即刻精选 - Telegram 频道",
      new: 0,
      updated: 0,
      error:
        "Get \"https://rsshub.app/telegram/channel/xxx\": dial tcp: lookup rsshub.app: no such host — 这是一条很长的错误信息用来触发跑马灯显示",
    },
  ],
};

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem("krss-auto-refresh-history", JSON.stringify([RECORD]));
});

describe("AdvancedSettings 自动刷新历史（12-19）", () => {
  it("渲染不崩：表头可排序 + 报错行有复制按钮", async () => {
    localStorage.setItem("krss-auto-refresh-history", JSON.stringify([RECORD]));
    render(<AdvancedSettings />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("settings.auto_refresh_history"),
    );
    // 展开「自动刷新历史」那条记录
    const trigger = [...document.querySelectorAll("button[aria-expanded]")].find((b) =>
      /auto_refresh_history_(row|record|item|summary)/.test((b.textContent || "") + (b.getAttribute("aria-label") || "")),
    ) ?? [...document.querySelectorAll("button[aria-expanded]")].pop();
    expect(trigger).toBeTruthy();
    (trigger as HTMLButtonElement).click();
    await screen.findByText("小众软件", undefined, { timeout: 15000 });
    expect(document.body.textContent).toContain("即刻精选");
    // 回归：表头是 HeroUI 的 SortableColumnHeader（可点排序），错误行有复制按钮
    expect(document.querySelectorAll('[data-slot="table-sortable-column-header"]').length).toBeGreaterThan(0);
    expect(
      document.querySelector('button[aria-label="settings.auto_refresh_history_copy_error"]'),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("no such host");
  });
});
