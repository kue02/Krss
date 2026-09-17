import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AutomationSettings } from "./AutomationSettings";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import type { FilterRule } from "@/types/filters";

const { createMutate, updateMutate, removeMutate, revertMutate, showToast } =
  vi.hoisted(() => ({
    createMutate: vi.fn(),
    updateMutate: vi.fn(),
    removeMutate: vi.fn(),
    revertMutate: vi.fn(),
    showToast: vi.fn(),
  }));

const { rules } = vi.hoisted(() => ({ rules: { current: [] as FilterRule[] } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useFilters", () => ({
  useFilters: () => ({ data: rules.current, isLoading: false, isError: false }),
  useFilterMatches: () => ({
    data: [
      {
        id: "m1",
        filterId: "rule-1",
        entryId: "e1",
        entryTitle: "赞助商投稿：某云厂商",
        feedTitle: "少数派",
        actions: { mute: true },
        createdAt: "2026-09-17T04:00:00Z",
      },
    ],
    isLoading: false,
    isError: false,
  }),
  useFilterMutations: () => ({
    create: { mutate: createMutate, isPending: false, isError: false },
    update: { mutate: updateMutate, isPending: false, isError: false },
    remove: { mutate: removeMutate, isPending: false, isError: false },
    revert: { mutate: revertMutate, isPending: false, isError: false },
  }),
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: () => ({ data: [{ id: "feed-1", title: "少数派" }] }),
}));

vi.mock("@/hooks/useFolders", () => ({
  useFolders: () => ({ data: [{ id: "folder-1", name: "技术" }] }),
}));

vi.mock("@/stores/toast-store", () => ({
  showToast: (message: string) => showToast(message),
  copyToClipboard: vi.fn(),
}));

function rule(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: "rule-1",
    name: "屏蔽推广",
    enabled: true,
    position: 0,
    scopeType: "feed",
    scopeId: "feed-1",
    conditions: [
      { field: "title", operator: "contains", value: "推广" },
    ],
    actions: { mute: true },
    matchCount: 3,
    lastMatchedAt: "2026-09-17T04:00:00Z",
    createdAt: "2026-09-17T03:00:00Z",
    updatedAt: "2026-09-17T03:00:00Z",
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  rules.current = [];
  createMutate.mockClear();
  updateMutate.mockClear();
  removeMutate.mockClear();
  revertMutate.mockClear();
  showToast.mockClear();
  useFilterEditorStore.getState().close();
});

describe("AutomationSettings", () => {
  it("没有规则时显示空态与新建入口", () => {
    render(<AutomationSettings />);

    expect(screen.getByText("automation.empty")).toBeTruthy();
    expect(screen.getByText("+ automation.new_rule")).toBeTruthy();
  });

  it("渲染规则行：范围解析成订阅名、条件与动作摘要、命中数", () => {
    rules.current = [rule()];
    render(<AutomationSettings />);

    expect(screen.getByText("屏蔽推广")).toBeTruthy();
    expect(screen.getByText("少数派")).toBeTruthy();
    expect(screen.getByText("automation.field_title automation.op_contains 推广")).toBeTruthy();
    expect(screen.getByText("automation.action_mute")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("点「撤销影响」调用撤销接口，并按返回条数提示", () => {
    rules.current = [rule()];
    render(<AutomationSettings />);

    fireEvent.click(screen.getByText("automation.revert"));

    expect(revertMutate).toHaveBeenCalledTimes(1);
    const [, options] = revertMutate.mock.calls[0] as [
      string,
      { onSuccess: (result: { reverted: number }) => void },
    ];
    options.onSuccess({ reverted: 5 });
    expect(showToast).toHaveBeenCalledWith("automation.revert_done");
  });

  it("顺序上下移：两条规则交换 position", () => {
    rules.current = [
      rule({ id: "rule-1", name: "第一条", position: 0 }),
      rule({ id: "rule-2", name: "第二条", position: 1 }),
    ];
    render(<AutomationSettings />);

    fireEvent.click(screen.getAllByTitle("automation.move_down")[0]!);

    expect(updateMutate).toHaveBeenCalledTimes(2);
    const payloads = updateMutate.mock.calls.map(
      ([variables]) => variables as { id: string; payload: { position: number } },
    );
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "rule-1", payload: expect.objectContaining({ position: 1 }) }),
        expect.objectContaining({ id: "rule-2", payload: expect.objectContaining({ position: 0 }) }),
      ]),
    );
  });

  it("删除走确认弹窗，确认时把「同时恢复」带给后端", () => {
    rules.current = [rule()];
    render(<AutomationSettings />);

    fireEvent.click(screen.getByText("automation.delete"));
    // 弹窗里的确认按钮与行内按钮同名，取最后一个（弹窗在 DOM 末尾）
    const confirmButtons = screen.getAllByText("automation.delete");
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    expect(removeMutate).toHaveBeenCalledTimes(1);
    const [variables] = removeMutate.mock.calls[0] as [
      { id: string; revert: boolean },
    ];
    expect(variables).toEqual({ id: "rule-1", revert: true });
  });

  it("点名称进入编辑（交给共用的规则编辑器 store）", () => {
    rules.current = [rule()];
    render(<AutomationSettings />);

    fireEvent.click(screen.getByText("屏蔽推广"));

    const state = useFilterEditorStore.getState();
    expect(state.open).toBe(true);
    expect(state.editingId).toBe("rule-1");
    expect(state.draft?.name).toBe("屏蔽推广");
  });

  it("点命中数打开命中日志（条目标题 + 来源 + 动作）", () => {
    rules.current = [rule()];
    render(<AutomationSettings />);

    expect(screen.queryByText("赞助商投稿：某云厂商")).toBeNull();

    fireEvent.click(screen.getByTitle("automation.matches_title"));

    // 弹窗里断言（表格行里也有「少数派」这个范围名，得限定在弹窗内查）
    const dialogs = screen.getAllByRole("dialog");
    const dialog = dialogs[dialogs.length - 1]!;
    expect(within(dialog).getByText("automation.matches_of")).toBeTruthy();
    expect(within(dialog).getByText("赞助商投稿：某云厂商")).toBeTruthy();
    expect(within(dialog).getByText("少数派")).toBeTruthy();
  });

  it("点「新建规则」打开空白编辑器", () => {
    render(<AutomationSettings />);

    fireEvent.click(screen.getByText("+ automation.new_rule"));

    const state = useFilterEditorStore.getState();
    expect(state.open).toBe(true);
    expect(state.editingId).toBeNull();
    expect(state.draft?.conditions).toEqual([]);
  });
});
