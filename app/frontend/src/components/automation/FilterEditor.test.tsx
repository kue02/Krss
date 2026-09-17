import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import { FilterEditor } from "./FilterEditor";
import type { FilterWritePayload } from "@/types/filters";

const { previewMutate } = vi.hoisted(() => ({ previewMutate: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: () => ({ data: [{ id: "feed-1", title: "少数派" }] }),
}));

vi.mock("@/hooks/useFolders", () => ({
  useFolders: () => ({ data: [{ id: "folder-1", name: "技术" }] }),
}));

vi.mock("@/hooks/useFilters", () => ({
  useFilterPreview: () => ({
    mutate: previewMutate,
    isPending: false,
    isError: false,
  }),
}));

afterEach(cleanup);
beforeEach(() => previewMutate.mockClear());

function draft(overrides: Partial<FilterWritePayload> = {}): FilterWritePayload {
  return {
    name: "屏蔽推广",
    scopeType: "all",
    conditions: [{ field: "title", operator: "contains", value: "推广" }],
    actions: { mute: true },
    ...overrides,
  };
}

describe("FilterEditor", () => {
  it("名称为空时不提交，并给出校验提示", () => {
    const onSubmit = vi.fn();
    render(
      <FilterEditor
        initial={draft({ name: "  " })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.save"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("automation.invalid")).toBeTruthy();
  });

  it("没有任何动作时不提交（后端也会拦）", () => {
    const onSubmit = vi.fn();
    render(
      <FilterEditor
        initial={draft({ actions: {} })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.save"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("automation.invalid")).toBeTruthy();
  });

  it("条件值缺失时不提交（有值操作符必填）", () => {
    const onSubmit = vi.fn();
    render(
      <FilterEditor
        initial={draft({
          conditions: [{ field: "title", operator: "contains", value: "" }],
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.save"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("三个互斥维度是三态分段控件：选「静音」后「取消静音」自动落选，再选「不变」两边都清空", () => {
    const submit = vi.fn();
    render(
      <FilterEditor
        initial={draft({ actions: { unmute: true } })}
        onSubmit={submit}
        onCancel={vi.fn()}
      />,
    );

    // 文本在分段控件内部的 <span> 上，按钮是它的祖先；「不变」三行都有 → 取第 0 行（静音维度）
    const btn = (label: string) =>
      screen.getByText(label).closest("button") as HTMLButtonElement;
    const mute = btn("automation.action_mute");
    const unmute = btn("automation.action_unmute");
    const none = (
      screen.getAllByText("automation.action_none")[0] as HTMLElement
    ).closest("button") as HTMLButtonElement;

    // 初始是反向（unmute）
    expect(unmute.getAttribute("data-state")).toBe("active");
    expect(mute.getAttribute("data-state")).toBe("inactive");

    // 选正向 → 反向落选
    fireEvent.click(mute);
    expect(mute.getAttribute("data-state")).toBe("active");
    expect(unmute.getAttribute("data-state")).toBe("inactive");

    // 选「不变」→ 两边都不带
    fireEvent.click(none);
    expect(mute.getAttribute("data-state")).toBe("inactive");
    expect(unmute.getAttribute("data-state")).toBe("inactive");
  });

  it("勾了「只保留匹配」后「静音」被禁用（否则等于全静音），并给出提示", () => {
    render(
      <FilterEditor
        initial={draft({ actions: { keepOnly: true } })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const mute = screen.getByText("automation.action_mute").closest("button") as HTMLButtonElement;
    expect(mute.disabled).toBe(true);
    // 反向仍然可用：「只保留匹配 + 取消静音」是合法的例外写法
    const unmute = screen
      .getByText("automation.action_unmute")
      .closest("button") as HTMLButtonElement;
    expect(unmute.disabled).toBe(false);
    // 并且告诉用户为什么点不动
    expect(screen.getByText("automation.mute_blocked_by_keep_only")).toBeTruthy();
  });

  it("可以添加条件行", () => {
    render(
      <FilterEditor
        initial={draft({ conditions: [] })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("automation.conditions_any")).toBeTruthy();
    fireEvent.click(screen.getByText("+ automation.add_condition"));
    expect(screen.queryByText("automation.conditions_any")).toBeNull();
    expect(document.querySelectorAll("select").length).toBeGreaterThanOrEqual(2);
  });

  it("点「预览影响」调用干跑接口，成功后展示命中摘要", async () => {
    render(
      <FilterEditor initial={draft()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );

    fireEvent.click(screen.getByText("automation.preview"));

    expect(previewMutate).toHaveBeenCalledTimes(1);
    const [variables, options] = previewMutate.mock.calls[0] as [
      { payload: FilterWritePayload },
      { onSuccess: (result: unknown) => void },
    ];
    expect(variables.payload).toMatchObject({ name: "屏蔽推广" });

    // 模拟后端返回：命中 2 条、将静音 2 条（回调在 React 事件之外触发，要包 act）
    await act(async () => {
      options.onSuccess({
        scanned: 120,
        matchedCount: 2,
        muteCount: 2,
        markReadCount: 0,
        starCount: 0,
        matched: [
          {
            id: "1",
            title: "赞助商投稿",
            feedTitle: "Solidot",
            actions: { mute: true },
          },
        ],
      });
    });

    expect(screen.getByText("automation.preview_summary")).toBeTruthy();
    expect(screen.getByText("automation.preview_mute")).toBeTruthy();
    expect(screen.getByText("赞助商投稿")).toBeTruthy();
  });

  it("保存时提交去掉首尾空格的名称", () => {
    const onSubmit = vi.fn();
    render(
      <FilterEditor
        initial={draft({ name: "  屏蔽推广  " })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.save"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "屏蔽推广" }),
    );
  });
});
