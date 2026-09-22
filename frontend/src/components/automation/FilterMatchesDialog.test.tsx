import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { FilterMatchesDialog } from "./FilterMatchesDialog";
import type { FilterMatch, FilterRule } from "@/types/filters";

const { matches } = vi.hoisted(() => ({
  matches: { current: [] as FilterMatch[] },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name === undefined ? key : `${key}:${options.name}`,
  }),
}));

vi.mock("@/hooks/useFilters", () => ({
  useFilterMatches: () => ({
    data: matches.current,
    isLoading: false,
    isError: false,
  }),
}));

const rule: FilterRule = {
  id: "rule-1",
  name: "静音赞助",
  enabled: true,
  position: 0,
  scopeType: "all",
  conditions: [],
  actions: { mute: true },
  matchCount: 2,
  createdAt: "2026-09-17T03:00:00Z",
  updatedAt: "2026-09-17T03:00:00Z",
};

afterEach(() => {
  cleanup();
  matches.current = [];
});

describe("FilterMatchesDialog", () => {
  it("rule 为 null 时不渲染内容", () => {
    render(<FilterMatchesDialog rule={null} onClose={vi.fn()} />);
    expect(screen.queryByText(/automation\.matches_of/)).toBeNull();
  });

  it("列出命中记录：时间、条目标题、来源与动作摘要", () => {
    matches.current = [
      {
        id: "m1",
        filterId: "rule-1",
        entryId: "e1",
        entryTitle: "赞助商投稿：某云厂商",
        feedTitle: "少数派",
        actions: { mute: true, markRead: true },
        createdAt: "2026-09-17T04:00:00Z",
      },
    ];
    render(<FilterMatchesDialog rule={rule} onClose={vi.fn()} />);

    expect(screen.getByText("automation.matches_of:静音赞助")).toBeTruthy();
    expect(screen.getByText("赞助商投稿：某云厂商")).toBeTruthy();
    expect(screen.getByText("少数派")).toBeTruthy();
    expect(
      screen.getByText("automation.action_mute · automation.action_mark_read"),
    ).toBeTruthy();
  });

  it("条目被删掉后显示占位文案（日志本身不该消失）", () => {
    matches.current = [
      {
        id: "m1",
        filterId: "rule-1",
        entryId: "e1",
        entryTitle: "",
        feedTitle: "",
        actions: { mute: true },
        createdAt: "2026-09-17T04:00:00Z",
      },
    ];
    render(<FilterMatchesDialog rule={rule} onClose={vi.fn()} />);

    expect(screen.getByText("automation.matches_deleted_entry")).toBeTruthy();
  });

  it("没有命中记录时显示空态", () => {
    render(<FilterMatchesDialog rule={rule} onClose={vi.fn()} />);
    expect(screen.getByText("automation.matches_empty")).toBeTruthy();
  });
});
