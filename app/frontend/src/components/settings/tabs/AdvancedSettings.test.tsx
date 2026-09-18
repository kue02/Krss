import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  newCount: 12,
  updatedCount: 760,
  failedCount: 1,
  results: [
    { feedId: "f1", title: "小众软件", new: 3, updated: 120 },
    {
      feedId: "f2",
      title: "即刻精选 - Telegram 频道",
      new: 0,
      updated: 0,
      error: "Get \"https://rsshub.app/telegram/channel/xxx\": no such host",
    },
  ],
};

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem("krss-auto-refresh-history", JSON.stringify([RECORD]));
});

describe("AdvancedSettings（高级页外壳）", () => {
  it("渲染不崩：自动刷新历史 + 拉取设置 + 域名限速三段都在", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AdvancedSettings />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("settings.auto_refresh_history"),
    );
    // 自动刷新历史已抽成独立组件（第十九批重做），这里只确认它被挂上了
    expect(
      document.querySelector('[data-slot="disclosure-trigger"]'),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("settings.fetch_title");
    expect(document.body.textContent).toContain(
      "settings.advanced_domain_limits",
    );
  });
});
