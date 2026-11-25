import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEntryMeta } from "./useEntryMeta";
import type { Entry } from "@/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // t 回显参数中的 mins，便于断言阅读时长数字
    t: (key: string, options?: Record<string, unknown>) =>
      `${key}:${options?.mins ?? ""}`,
    i18n: { language: "zh" },
  }),
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: () => ({
    data: [{ id: "feed-1", title: "测试源" }],
  }),
}));

function makeEntry(content?: string): Entry {
  return {
    id: "entry-1",
    feedId: "feed-1",
    title: "标题",
    url: "https://example.com/a",
    content,
    read: false,
    starred: false,
    muted: false,
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
  };
}

/** 从 "entry.min_read:<n>" 里取出数字 */
function parseMins(value: string | null): number | null {
  if (value === null) return null;
  const match = /entry\.min_read:(\d+)/.exec(value);
  return match ? Number(match[1]) : null;
}

const SHORT_CONTENT = "<p>修复了部分错误</p>";
const LONG_CONTENT = `<p>${"阅读".repeat(1000)}</p>`;

describe("useEntryMeta readingTime", () => {
  it("不传 readingContent 时退回 entry.content", () => {
    const { result } = renderHook(() => useEntryMeta(makeEntry(SHORT_CONTENT)));
    expect(parseMins(result.current.readingTime)).toBe(1);
  });

  it("传入更长的 readingContent 时数字更大", () => {
    const { result } = renderHook(() =>
      useEntryMeta(makeEntry(SHORT_CONTENT), LONG_CONTENT),
    );
    const mins = parseMins(result.current.readingTime);
    expect(mins).not.toBeNull();
    expect(mins as number).toBeGreaterThan(1);
  });

  it("readingContent 覆盖 entry.content（即使 entry.content 更长）", () => {
    const { result } = renderHook(() =>
      useEntryMeta(makeEntry(LONG_CONTENT), SHORT_CONTENT),
    );
    expect(parseMins(result.current.readingTime)).toBe(1);
  });

  it("无内容时 readingTime 为 null", () => {
    const { result } = renderHook(() => useEntryMeta(makeEntry(undefined)));
    expect(result.current.readingTime).toBeNull();
  });
});
