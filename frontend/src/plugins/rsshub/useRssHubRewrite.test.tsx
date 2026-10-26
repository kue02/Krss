import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRssHubRewrite } from "./useRssHubRewrite";

const mocks = vi.hoisted(() => ({ fetchPluginSettings: vi.fn() }));

vi.mock("@/plugins/api", () => ({
  fetchPluginSettings: mocks.fetchPluginSettings,
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useRssHubRewrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("配了实例地址：把公共实例地址换到自有实例（带 ACCESS_KEY）", async () => {
    mocks.fetchPluginSettings.mockResolvedValue({
      base_url: "https://rsshub.mine.dev",
      access_key: "KEY1",
    });

    const { result } = renderHook(() => useRssHubRewrite(), { wrapper });

    await waitFor(() => expect(result.current.baseUrl).toBe("https://rsshub.mine.dev"));
    expect(result.current.rewrite("https://rsshub.app/twitter/user/x")).toBe(
      "https://rsshub.mine.dev/twitter/user/x?key=KEY1",
    );
  });

  it("没配实例地址：不碰原地址（返回 null）", async () => {
    mocks.fetchPluginSettings.mockResolvedValue({});

    const { result } = renderHook(() => useRssHubRewrite(), { wrapper });

    await waitFor(() => expect(result.current.baseUrl).toBe(""));
    expect(result.current.rewrite("https://rsshub.app/twitter/user/x")).toBeNull();
  });

  it("不是 RSSHub 地址：返回 null（普通源一个字都不改）", async () => {
    mocks.fetchPluginSettings.mockResolvedValue({
      base_url: "https://rsshub.mine.dev",
    });

    const { result } = renderHook(() => useRssHubRewrite(), { wrapper });

    await waitFor(() => expect(result.current.baseUrl).toBe("https://rsshub.mine.dev"));
    expect(result.current.rewrite("https://sspai.com/feed")).toBeNull();
  });

  it("地址与实例一致（换了等于没换）：返回 null", async () => {
    mocks.fetchPluginSettings.mockResolvedValue({
      base_url: "https://rsshub.mine.dev",
    });

    const { result } = renderHook(() => useRssHubRewrite(), { wrapper });

    await waitFor(() => expect(result.current.baseUrl).toBe("https://rsshub.mine.dev"));
    expect(
      result.current.rewrite("https://rsshub.mine.dev/twitter/user/x"),
    ).toBeNull();
  });
});
