import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFilterEditorStore } from "@/stores/filter-editor-store";

const mutate = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));

vi.mock("@/hooks/useFeeds", () => ({ useFeeds: () => ({ data: [] }) }));
vi.mock("@/hooks/useFolders", () => ({ useFolders: () => ({ data: [] }) }));
vi.mock("@/hooks/useFilters", () => ({
  useFilterPreview: () => ({ mutate: vi.fn(), isPending: false }),
  useFilterMutations: () => ({
    create: { mutate, isPending: false, isError: false },
    update: { mutate, isPending: false, isError: false },
    remove: { mutate: vi.fn() },
    revert: { mutate: vi.fn() },
  }),
}));

vi.mock("@/stores/toast-store", () => ({ showToast: vi.fn() }));

import { FilterEditorDialog } from "./FilterEditorDialog";
import { showToast } from "@/stores/toast-store";

/**
 * 用户第十一批 11-9 拍的口径：
 *   保存成功 → 只提示「已保存」（不拦）；**有未保存改动时离开** → 弹确认（保存并关闭 / 放弃更改 / 继续编辑）。
 */
describe("FilterEditorDialog 离开确认", () => {
  beforeEach(() => {
    mutate.mockClear();
    useFilterEditorStore.getState().close();
  });

  it("没改动时点取消直接关掉，不弹确认", async () => {
    useFilterEditorStore.getState().openNew();
    render(<FilterEditorDialog />);

    fireEvent.click(screen.getByText("automation.cancel"));

    await waitFor(() => {
      expect(useFilterEditorStore.getState().open).toBe(false);
    });
    expect(screen.queryByText("automation.unsaved_title")).toBeNull();
  });

  it("改了名字再点取消 → 弹确认，三个选项都在；「继续编辑」不关抽屉", async () => {
    useFilterEditorStore.getState().openNew();
    render(<FilterEditorDialog />);

    const nameInput = screen.getByPlaceholderText(
      "automation.name_placeholder",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "新的名字" } });

    fireEvent.click(screen.getByText("automation.cancel"));
    await waitFor(() => {
      expect(screen.getByText("automation.unsaved_title")).toBeTruthy();
    });
    expect(screen.getByText("automation.unsaved_save")).toBeTruthy();
    expect(screen.getByText("automation.unsaved_discard")).toBeTruthy();

    // 继续编辑 → 抽屉还在、表单内容还在
    fireEvent.click(screen.getByText("automation.unsaved_keep_editing"));
    await waitFor(() => {
      expect(screen.queryByText("automation.unsaved_title")).toBeNull();
    });
    expect(useFilterEditorStore.getState().open).toBe(true);
    expect((screen.getByPlaceholderText("automation.name_placeholder") as HTMLInputElement).value).toBe("新的名字");
  });

  it("「放弃更改」直接关掉且不提交", async () => {
    useFilterEditorStore.getState().openNew();
    render(<FilterEditorDialog />);

    fireEvent.change(screen.getByPlaceholderText("automation.name_placeholder"), {
      target: { value: "要丢掉的改动" },
    });
    fireEvent.click(screen.getByText("automation.cancel"));
    await waitFor(() => {
      expect(screen.getByText("automation.unsaved_discard")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("automation.unsaved_discard"));

    await waitFor(() => {
      expect(useFilterEditorStore.getState().open).toBe(false);
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("「保存并关闭」用表单当前内容提交，成功后提示「已保存」并关掉", async () => {
    useFilterEditorStore.getState().openNew();
    render(<FilterEditorDialog />);

    fireEvent.change(screen.getByPlaceholderText("automation.name_placeholder"), {
      target: { value: "要保存的规则" },
    });
    fireEvent.click(screen.getByText("automation.cancel"));
    await waitFor(() => {
      expect(screen.getByText("automation.unsaved_save")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("automation.unsaved_save"));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledTimes(1);
    });
    const [payload, options] = mutate.mock.calls[0] as [
      { name: string },
      { onSuccess: () => void },
    ];
    expect(payload.name).toBe("要保存的规则");

    options.onSuccess();
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith("automation.created_saved");
      expect(useFilterEditorStore.getState().open).toBe(false);
    });
  });
});
