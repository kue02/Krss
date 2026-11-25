import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * 回归：移动端「右滑返回」回到列表。
 *
 * 详情页是从列表 push 上来的；showList 若再用 push 写一条列表历史，
 * 浏览器再后退会先回到刚关掉的正文（真机反馈：「右滑返回像退了一个网页」）。
 * 这里锁死 showList 必须用 `{ replace: true }`，且生成的 URL 去掉了 entryId。
 */
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: "/all",
  search: "?type=article",
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

import { useMobileLayout } from "./useMobileLayout";

describe("useMobileLayout showList（移动端返回列表）", () => {
  beforeEach(() => {
    mocks.navigate.mockClear();
    mocks.location = "/all";
    mocks.search = "?type=article";
  });

  it("详情态（URL 带 entryId）时 mobileView = detail", () => {
    mocks.location = "/all/123";
    const { result } = renderHook(() => useMobileLayout());
    expect(result.current.mobileView).toBe("detail");
  });

  it("showList 用 replace 返回列表，且 URL 不带 entryId", () => {
    mocks.location = "/all/123";
    const { result } = renderHook(() => useMobileLayout());

    act(() => {
      result.current.showList();
    });

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.navigate.mock.calls[0] as [
      string,
      { replace?: boolean } | undefined,
    ];
    expect(options).toEqual({ replace: true });
    expect(url).toBe("/all?unread=true&type=article");
    expect(url).not.toContain("/all/123");
  });

  it("feed 详情返回对应 feed 列表，同样 replace", () => {
    mocks.location = "/feed/42/999";
    mocks.search = "?type=article&unread=false";
    const { result } = renderHook(() => useMobileLayout());

    act(() => {
      result.current.showList();
    });

    const [url, options] = mocks.navigate.mock.calls[0] as [
      string,
      { replace?: boolean } | undefined,
    ];
    expect(options).toEqual({ replace: true });
    expect(url).toBe("/feed/42?unread=false&type=article");
  });
});
