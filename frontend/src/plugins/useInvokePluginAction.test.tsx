import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useInvokePluginAction } from "./useInvokePluginAction";
import type { PluginContribution } from "./types";

const mocks = vi.hoisted(() => ({
  invokePluginAction: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("@/plugins/api", () => ({
  invokePluginAction: mocks.invokePluginAction,
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
});
