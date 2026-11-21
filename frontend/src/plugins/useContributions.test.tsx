import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useContributions, usePluginContributions } from "./useContributions";
import type { PluginContribution } from "./types";

const mocks = vi.hoisted(() => ({ fetchPluginContributions: vi.fn() }));

vi.mock("@/plugins/api", () => ({
  fetchPluginContributions: mocks.fetchPluginContributions,
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function item(
  id: string,
  surface: PluginContribution["surface"],
  plugin = "demo",
): PluginContribution {
  return {
    plugin,
    pluginName: "Demo",
    id,
    surface,
    action: "act",
    label: id,
    selection: "multi",
  };
}

describe("useContributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("按 surface 分组取贡献：entry.contextmenu 两条、feed.contextmenu 一条", async () => {
    mocks.fetchPluginContributions.mockResolvedValue({
      "entry.contextmenu": [
        item("copy-link", "entry.contextmenu"),
        item("translate", "entry.contextmenu", "other"),
      ],
      "feed.contextmenu": [item("mark-all-read", "feed.contextmenu")],
    });

    const { result } = renderHook(
      () => ({
        all: usePluginContributions(),
        entry: useContributions("entry.contextmenu"),
        feed: useContributions("feed.contextmenu"),
        missing: useContributions("view.toolbar"),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.entry).toHaveLength(2));
    expect(result.current.entry.map((c) => c.id)).toEqual([
      "copy-link",
      "translate",
    ]);
    expect(result.current.feed).toHaveLength(1);
    expect(result.current.feed[0]?.id).toBe("mark-all-read");
    // 后端没给的分组一律空数组，页面直接 map 不会踩空
    expect(result.current.missing).toEqual([]);
    expect(mocks.fetchPluginContributions).toHaveBeenCalledTimes(1);
  });

  it("后端返回空对象：不崩，按空数组处理", async () => {
    mocks.fetchPluginContributions.mockResolvedValue({});

    const { result } = renderHook(
      () => ({
        all: usePluginContributions(),
        entry: useContributions("entry.contextmenu"),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.all.isSuccess).toBe(true));
    expect(result.current.all.data).toEqual({});
    expect(result.current.entry).toEqual([]);
  });
});
