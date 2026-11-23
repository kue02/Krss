import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * 问题2回归：从「只看未读」列表点侧栏「星标」时，星标是收藏视图，
 * 不该带上当前未读筛选。之前 selectStarred 用 routeState.unreadOnly 拼 URL，
 * 在 `/all?type=social&unread=true` 下会生成 `/starred?...&unread=true`，
 * 而收藏里多半没有未读条目 ⇒ 「暂无文章」。这里锁死：任何未读状态下都 unread=false。
 */
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: "/all",
  search: "?type=social&unread=true",
}));

vi.mock("wouter", () => ({
  useLocation: () => [mocks.location, mocks.navigate],
  useSearch: () => mocks.search,
}));

vi.mock("@/hooks/useUISettings", () => ({
  useUISettingKey: (key: string) => (key === "unreadOnly" ? true : undefined),
  setUISetting: vi.fn(),
  getUISettings: () => ({}),
}));

import { useSelection } from "./useSelection";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useSelection selectStarred（问题2）", () => {
  beforeEach(() => {
    mocks.navigate.mockClear();
    mocks.location = "/all";
    mocks.search = "?type=social&unread=true";
  });

  it("当前 unread=true 时，selectStarred 生成的 URL 仍是 unread=false", () => {
    const { result } = renderHook(() => useSelection(), { wrapper });

    act(() => {
      result.current.selectStarred({ replace: true }, true);
    });

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    const url = mocks.navigate.mock.calls[0]?.[0] as string;
    expect(url).toContain("unread=false");
    expect(url).not.toContain("unread=true");
    expect(url).toContain("scope=view");
    expect(url).toContain("type=social");
  });

  it("viewOnly=false（看全部星标）时同样 unread=false、scope=all", () => {
    const { result } = renderHook(() => useSelection(), { wrapper });

    act(() => {
      result.current.selectStarred({ replace: true }, false);
    });

    const url = mocks.navigate.mock.calls[0]?.[0] as string;
    expect(url).toContain("unread=false");
    expect(url).not.toContain("unread=true");
    expect(url).toContain("scope=all");
  });

});
