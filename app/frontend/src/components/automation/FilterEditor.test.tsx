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

  it("正反动作互斥：勾了静音，取消静音按钮禁用", () => {
    render(
      <FilterEditor initial={draft()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );

    const unmute = screen.getByText("automation.action_unmute");
    expect((unmute as HTMLButtonElement).disabled).toBe(true);
  });

  it("勾了「只保留匹配」后「静音」被禁用（否则等于全静音）", () => {
    render(
      <FilterEditor
        initial={draft({ actions: { keepOnly: true } })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const mute = screen.getByText("automation.action_mute");
    expect((mute as HTMLButtonElement).disabled).toBe(true);
    // 反动作仍然可用：「只保留匹配 + 取消静音」是合法的例外写法
    expect(
      (screen.getByText("automation.action_unmute") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
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
