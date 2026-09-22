import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AutomationSettings } from "./AutomationSettings";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import type { FilterRule } from "@/types/filters";

const { createMutate, updateMutate, removeMutate, revertMutate, applyHistoryMutate, nlDraftMutate, showToast } =
  vi.hoisted(() => ({
    createMutate: vi.fn(),
    updateMutate: vi.fn(),
    removeMutate: vi.fn(),
    revertMutate: vi.fn(),
    applyHistoryMutate: vi.fn(),
    nlDraftMutate: vi.fn(),
    showToast: vi.fn(),
  }));

const { getFilterImpact, revertFilter } = vi.hoisted(() => ({
  getFilterImpact: vi.fn(),
  revertFilter: vi.fn(),
}));

const { rules } = vi.hoisted(() => ({ rules: { current: [] as FilterRule[] } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useFilters", () => ({
  useFilters: () => ({ data: rules.current, isLoading: false, isError: false }),
  useFilterDraft: () => ({ mutate: nlDraftMutate, isPending: false }),
  useApplyFilterHistory: () => ({
    mutate: applyHistoryMutate,
    isPending: false,
    isError: false,
  }),
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

vi.mock("@/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api")>();
  return {
    ...actual,
    getFilterImpact: (id: string) => getFilterImpact(id),
    revertFilter: (id: string, options: unknown) => revertFilter(id, options),
  };
});

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
  getFilterImpact.mockReset();
  revertFilter.mockReset();
  applyHistoryMutate.mockClear();
  showToast.mockClear();
  useFilterEditorStore.getState().close();
});


/**
 * 打开某一行行尾的「⋯」菜单。
 *
 * 2026-09-17 重做自动化页时，编辑/回溯/撤销/删除 都从行内按钮收进了「⋯」菜单，
 * 测试不能再直接点文本，得先把菜单打开（react-aria 的 MenuTrigger 认指针事件）。
 */
function openRowMenu(index = 0) {
  const trigger = screen.getAllByLabelText("automation.more_actions")[index]!;
  fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
  fireEvent.pointerUp(trigger, { pointerType: "mouse", button: 0 });
  fireEvent.click(trigger);
}

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
    expect(screen.getByText("automation.hits")).toBeTruthy();
  });

  it("点「撤销影响」先给影响清单，确认后按勾选项撤销", async () => {
    // 用户 11-23：撤销前先看到会被影响的条目，只撤勾选的（不再是点一下全撤）
    rules.current = [rule()];
    getFilterImpact.mockResolvedValue({
      items: [
        {
          entryId: "e1",
          title: "赞助商投稿：某云厂商",
          feedTitle: "少数派",
          publishedAt: "2026-09-17T04:00:00Z",
          read: false,
          starred: false,
          muted: true,
          actions: { mute: true, markRead: false, star: false, unstar: false },
        },
        {
          entryId: "e2",
          title: "另一条推广",
          feedTitle: "少数派",
          publishedAt: "2026-09-16T04:00:00Z",
          read: true,
          starred: false,
          muted: true,
          actions: { mute: true, markRead: false, star: false, unstar: false },
        },
      ],
      total: 2,
    });
    revertFilter.mockResolvedValue({ reverted: 2 });

    render(<AutomationSettings />);
    openRowMenu();
    fireEvent.click(screen.getByText("automation.revert"));

    // 打开就拉清单，默认全选
    expect(getFilterImpact).toHaveBeenCalledWith("rule-1");
    await screen.findByText("赞助商投稿：某云厂商");
    expect(screen.getByText("另一条推广")).toBeTruthy();

    fireEvent.click(screen.getByText("automation.revert_selected_action"));

    await waitFor(() => {
      expect(revertFilter).toHaveBeenCalledWith("rule-1", {
        entryIds: ["e1", "e2"],
        includeStarred: false,
      });
    });
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith("automation.revert_done");
    });
  });

  it("顺序上下移：两条规则交换 position", () => {
    // 2026-09-17 起主交互改成拖动（行内不再摆 ↑↓），但「上移 / 下移」保留在行尾「⋯」菜单里
    // 供键盘用户与不想拖的人使用 —— 这条测的就是那条保底路径。
    rules.current = [
      rule({ id: "rule-1", name: "第一条", position: 0 }),
      rule({ id: "rule-2", name: "第二条", position: 1 }),
    ];
    render(<AutomationSettings />);

    openRowMenu(0);
    fireEvent.click(screen.getByText("automation.move_down"));

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

    openRowMenu();
    // 菜单里的「删除」项 → 打开确认弹窗
    fireEvent.click(screen.getByText("automation.delete"));
    // 弹窗里的确认按钮与菜单项同名，取最后一个（弹窗在 DOM 末尾）
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

    // 11-17 之后「命中 N · 最近命中 时间」整块是一个按钮（tooltip 取代了 title），
    // 所以按可访问名找它 —— 顺便盯住「最近命中」还在这块可点区域里
    // react-aria 的 TooltipTrigger 自己也会带 role=button，所以取里面那个真 <button>
    const hitsButton = screen
      .getAllByRole("button", {
        name: /automation\.hits.*automation\.(last_matched|never_matched)/,
      })
      .find((node) => node.tagName === "BUTTON");
    expect(hitsButton).toBeTruthy();
    fireEvent.click(hitsButton!);

    // 弹窗里断言（表格行里也有「少数派」这个范围名，得限定在弹窗内查）
    const dialogs = screen.getAllByRole("dialog");
    const dialog = dialogs[dialogs.length - 1]!;
    expect(within(dialog).getByText("automation.matches_of")).toBeTruthy();
    expect(within(dialog).getByText("赞助商投稿：某云厂商")).toBeTruthy();
    expect(within(dialog).getByText("少数派")).toBeTruthy();
  });

  it("回溯历史：先确认（说清范围与语义），确认后才调用接口并按结果提示", () => {
    rules.current = [rule()];
    render(<AutomationSettings />);

    openRowMenu();
    fireEvent.click(screen.getByText("automation.apply_history"));

    // 未确认前不该动数据
    expect(applyHistoryMutate).not.toHaveBeenCalled();
    expect(screen.getByText("automation.apply_history_title")).toBeTruthy();

    fireEvent.click(screen.getByText("automation.apply_history_confirm"));

    expect(applyHistoryMutate).toHaveBeenCalledTimes(1);
    const [variables, options] = applyHistoryMutate.mock.calls[0] as [
      { id: string; limit: number },
      { onSuccess: (result: { scanned: number; applied: number }) => void },
    ];
    expect(variables).toEqual({ id: "rule-1", limit: 500 });

    options.onSuccess({ scanned: 500, applied: 12 });
    expect(showToast).toHaveBeenCalledWith("automation.apply_history_done");
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
