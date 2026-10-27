import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useInvokePluginAction } from "./useInvokePluginAction";
import type { PluginContribution } from "./types";

const mocks = vi.hoisted(() => ({
  invokePluginAction: vi.fn(),
  exportPluginFiles: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("@/plugins/api", () => ({
  invokePluginAction: mocks.invokePluginAction,
  exportPluginFiles: mocks.exportPluginFiles,
}));

vi.mock("@/stores/toast-store", () => ({
  showToast: mocks.showToast,
}));

const contribution: PluginContribution = {
  plugin: "demo",
  pluginName: "Demo",
  id: "translate",
  surface: "entry.contextmenu",
  action: "translate",
  label: "翻译",
  selection: "multi",
  refresh: ["entries"],
};

const selection = { entryIds: ["1", "2"] };

function setup(item: PluginContribution = contribution) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useInvokePluginAction(item), { wrapper });
  return { result, invalidate };
}

describe("useInvokePluginAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("成功：把 plugin/action 与 surface+selection+config 传给接口，并弹插件给的提示", async () => {
    mocks.invokePluginAction.mockResolvedValue({ message: "已翻译 2 条" });
    const { result } = setup();

    await act(async () => {
      await result.current.mutateAsync({
        selection,
        config: { target: "zh" },
      });
    });

    expect(mocks.invokePluginAction).toHaveBeenCalledWith(
      "demo",
      "translate",
      {
        surface: "entry.contextmenu",
        selection,
        config: { target: "zh" },
      },
    );

    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith("已翻译 2 条"),
    );
  });

  it("refresh 里的 feeds → invalidateQueries({queryKey:[\"feeds\"]})", async () => {
    mocks.invokePluginAction.mockResolvedValue({ refresh: ["feeds"] });
    const { result, invalidate } = setup();

    await act(async () => {
      await result.current.mutateAsync({ selection });
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["feeds"] });
  });

  it("refresh 里的 decorations → invalidateQueries({queryKey:[\"decorations\"]})", async () => {
    // 56-32：标注插件高亮后回 refresh:["decorations"]，阅读器要立刻重画标记。
    mocks.invokePluginAction.mockResolvedValue({ refresh: ["decorations"] });
    const { result, invalidate } = setup();

    await act(async () => {
      await result.current.mutateAsync({ selection });
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decorations"] });
  });

  it("失败：把后端错误消息弹成 error 提示", async () => {
    mocks.invokePluginAction.mockRejectedValue(new Error("插件超时"));
    const { result } = setup();

    await act(async () => {
      await result.current.mutateAsync({ selection }).catch(() => undefined);
    });

    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith("插件超时"),
    );
  });

  // 插件导出的两条路（56-33）：有导出目录就落盘、没有就回落浏览器下载。
  describe("导出文件", () => {
    let clickSpy: ReturnType<typeof vi.fn<() => void>>;

    beforeEach(() => {
      mocks.exportPluginFiles.mockReset();
      clickSpy = vi.fn<() => void>();
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => clickSpy());
      // jsdom 没有 createObjectURL
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:x");
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    });

    it("写进导出目录：提示落盘位置，不再弹下载", async () => {
      mocks.invokePluginAction.mockResolvedValue({
        message: "已导出",
        files: [{ filename: "笔记.md", content: "# x" }],
      });
      mocks.exportPluginFiles.mockResolvedValue({ paths: ["/vault/笔记.md"] });
      const { result } = setup();

      await act(async () => {
        await result.current.mutateAsync({ selection: { entryIds: ["1"] } });
      });

      await waitFor(() =>
        expect(mocks.exportPluginFiles).toHaveBeenCalledWith([
          { name: "笔记.md", content: "# x" },
        ]),
      );
      await waitFor(() =>
        expect(mocks.showToast).toHaveBeenCalledWith("已写入 /vault"),
      );
      expect(clickSpy).not.toHaveBeenCalled();
    });

    it("没配导出目录（后端 400）：回落浏览器下载", async () => {
      mocks.invokePluginAction.mockResolvedValue({
        files: [{ filename: "笔记.md", content: "# x" }],
      });
      mocks.exportPluginFiles.mockRejectedValue(new Error("未设置导出目录"));
      const { result } = setup();

      await act(async () => {
        await result.current.mutateAsync({ selection: { entryIds: ["1"] } });
      });

      await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    });
  });
});
