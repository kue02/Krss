import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
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

/**
 * 52-6（用户第 6 条「创建自动化时，如果没有输入标题，也是可以预览的」）：
 * 预览是 dry-run、不落库，名称对它没有任何意义 ⇒ 空名称也要能预览。
 * 保存仍然要求名称（那条口径由 FilterEditor.test.tsx 覆盖，这里不重复放宽）。
 */
describe("FilterEditor 预览不要求名称（52-6）", () => {
  it("名称为空 → 点预览照样发请求，且不报校验错", () => {
    render(
      <FilterEditor
        initial={draft({ name: "   " })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.preview"));

    expect(previewMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("automation.invalid")).toBeNull();
  });

  it("预览发的 body 里名称就是空的（不替用户编一个），其余字段照旧带上", () => {
    render(
      <FilterEditor
        initial={draft({ name: "" })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.preview"));

    const payload = previewMutate.mock.calls.at(-1)?.[0] as {
      payload: FilterWritePayload;
    };
    expect(payload.payload.name).toBe("");
    expect(payload.payload.kind).toBe("rule");
    expect(payload.payload.actions).toEqual({ mute: true });
    expect(payload.payload.conditions).toHaveLength(1);
  });

  it("名称空 + 动作也没配 → 仍然拦（拦的是动作，不是名称）", () => {
    render(
      <FilterEditor
        initial={draft({ name: "", actions: {} })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.preview"));

    expect(previewMutate).not.toHaveBeenCalled();
    expect(screen.getByText("automation.invalid")).toBeTruthy();
  });

  it("名称空 + 条件缺值 → 仍然拦（条件校验一条不少）", () => {
    render(
      <FilterEditor
        initial={draft({
          name: "",
          conditions: [{ field: "title", operator: "contains", value: "  " }],
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("automation.preview"));

    expect(previewMutate).not.toHaveBeenCalled();
    expect(screen.getByText("automation.invalid")).toBeTruthy();
  });
});
