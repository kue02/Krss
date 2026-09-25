import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { RefreshTooltip } from "./RefreshTooltip";
import type { RefreshStatus } from "@/api";

/**
 * 用户 9-25 反馈「刷新列表不会变动，固定就显示那几个」：
 * `shown` 原来取 `results.slice(0, MAX_ROWS)`（最早的 8 个）—— 刷新推进时永远是同一批源。
 * 现在取尾部（最近完成的），这里锁死方向：第 15 个源完成后，第 0 个必须已被挤出列表。
 *
 * 注意：浮层内容渲染在 portal（document.body）里，不在 render 返回的 container 内。
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

vi.mock("@/stores/refresh-report-store", () => ({
  buildRefreshReport: (r: unknown) => r,
  useRefreshReportStore: (sel: (s: { open: () => void }) => unknown) =>
    sel({ open: () => {} }),
}));

function statusWith(completed: number, total: number): RefreshStatus {
  return {
    isRefreshing: true,
    total,
    completed,
    startedAt: new Date().toISOString(),
    trigger: "manual",
    results: Array.from({ length: completed }, (_, i) => ({
      feedId: `feed-${i}`,
      title: `源编号${i}`,
      new: 1,
      updated: 0,
    })),
  } as RefreshStatus;
}

function openWith(status: RefreshStatus | undefined) {
  const { container } = render(
    <RefreshTooltip status={status}>
      <button type="button" title="刷新当前范围">
        refresh
      </button>
    </RefreshTooltip>,
  );
  const trigger = container.querySelector('[data-slot="popover-trigger"]');
  if (trigger) fireEvent.mouseEnter(trigger);
  return container;
}

describe("RefreshTooltip · 逐源列表取最近完成的（用户 9-25 复验）", () => {
  it("15 个源已完成时显示最后 8 个，最早的已被挤出（本次修复的锁）", () => {
    openWith(statusWith(15, 15));
    const text = document.body.textContent ?? "";
    expect(text).toContain("源编号14");
    expect(text).toContain("源编号7");
    expect(text).not.toContain("源编号6");
    expect(text).not.toContain("源编号0");
  });

  it("列表行数不超过 8（MAX_ROWS）", () => {
    openWith(statusWith(15, 15));
    const rows = document.body.querySelectorAll('[data-slot="refresh-tooltip-row"]');
    expect(rows.length).toBeLessThanOrEqual(8);
  });

  it("刷新中显示进度（completed / total）", () => {
    openWith(statusWith(13, 15));
    expect(document.body.textContent).toContain("refresh_tooltip.refreshing");
  });

  it("空闲（isRefreshing=false）不渲染逐源列表", () => {
    openWith({
      isRefreshing: false,
      lastRefreshedAt: new Date().toISOString(),
      results: [{ feedId: "a", title: "源编号0", new: 2, updated: 0 }],
    } as RefreshStatus);
    expect(
      document.body.querySelectorAll('[data-slot="refresh-tooltip-row"]').length,
    ).toBe(0);
  });
});
