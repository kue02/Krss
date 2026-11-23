import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Entry } from "@/types/api";
import { useAISummary } from "./useAISummary";

const {
  mockGetCachedSummary,
  mockStreamSummary,
  mockFetchCachedTranslations,
  mockSetSummaryStatus,
} = vi.hoisted(() => ({
  mockGetCachedSummary: vi.fn(),
  mockStreamSummary: vi.fn(),
  mockFetchCachedTranslations: vi.fn(() =>
    Promise.resolve({ translations: {}, language: "zh-CN" }),
  ),
  mockSetSummaryStatus: vi.fn(),
}));

vi.mock("@/api", () => ({
  getCachedSummary: mockGetCachedSummary,
  streamSummary: mockStreamSummary,
  fetchCachedTranslations: mockFetchCachedTranslations,
}));

vi.mock("@/stores/translation-store", () => ({
  translationActions: {
    setSummaryStatus: mockSetSummaryStatus,
  },
}));

const entry: Entry = {
  id: "entry-1",
  feedId: "feed-1",
  title: "Entry title",
  content: "<p>body</p>",
  read: false,
  starred: false,
  muted: false,
  publishedAt: "2024-01-01T09:00:00.000Z",
  createdAt: "2024-01-01T09:00:00.000Z",
  updatedAt: "2024-01-01T09:00:00.000Z",
};

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    entry,
    isReadableActive: false,
    readableContent: null,
    autoSummary: false,
    targetLanguage: "zh-CN",
    ...overrides,
  };
}

beforeEach(() => {
  mockGetCachedSummary.mockReset();
  mockStreamSummary.mockReset();
  mockFetchCachedTranslations.mockReset();
  mockSetSummaryStatus.mockReset();
  mockFetchCachedTranslations.mockResolvedValue({
    translations: {},
    language: "zh-CN",
  });
});

describe("useAISummary 缓存预取（问题④）", () => {
  it("有缓存时恢复摘要态，且不触发 summarize 流", async () => {
    mockGetCachedSummary.mockResolvedValue("已缓存的摘要");

    const { result } = renderHook(() => useAISummary(baseOptions()));

    await waitFor(() => {
      expect(result.current.aiSummary).toBe("已缓存的摘要");
    });
    expect(mockGetCachedSummary).toHaveBeenCalledWith("entry-1", false);
    expect(mockStreamSummary).not.toHaveBeenCalled();
  });

  it("无缓存时保持未摘要，不自动生成（autoSummary=false）", async () => {
    mockGetCachedSummary.mockResolvedValue(null);

    const { result } = renderHook(() => useAISummary(baseOptions()));

    await waitFor(() => {
      expect(mockGetCachedSummary).toHaveBeenCalled();
    });
    expect(result.current.aiSummary).toBeNull();
    expect(mockStreamSummary).not.toHaveBeenCalled();
  });
});
