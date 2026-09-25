import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import type { Entry } from "@/types/api";
import { entryListScrollPositions } from "./scroll-key";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useEntries", () => ({
  useEntriesInfinite: vi.fn(),
  useUnreadCounts: vi.fn(() => ({ data: undefined })),
  useMarkManyAsRead: vi.fn(() => ({ mutate: vi.fn() })),
  useRemoveFromUnreadList: vi.fn(() => vi.fn()),
  useMarkAsRead: vi.fn(() => ({ mutate: vi.fn() })),
  useMarkAsStarred: vi.fn(() => ({ mutate: vi.fn() })),
}));

vi.mock("@/hooks/useRefreshStatus", () => ({
  useRefreshStatus: () => undefined,
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/hooks/useFolders", () => ({
  useFolders: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/hooks/useAISettings", () => ({
  useAISettings: vi.fn(),
}));

vi.mock("@/hooks/useGeneralSettings", () => ({
  useGeneralSettings: vi.fn(() => ({ data: { markReadOnScroll: false } })),
}));

vi.mock("@/hooks/useSelection", () => ({
  selectionToParams: vi.fn(() => ({})),
}));

vi.mock("@/lib/html-utils", () => ({
  stripHtml: (html: string) => html,
}));

vi.mock("@/lib/language-detect-async", () => ({
  needsTranslation: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/services/translation-service", () => ({
  translateArticlesBatch: vi.fn(() => Promise.resolve()),
  cancelAllBatchTranslations: vi.fn(),
}));

vi.mock("@/stores/translation-store", () => ({
  translationActions: { get: vi.fn(() => undefined), isDisabled: () => false },
}));

// list 档的普通卡片行（EntryListItem）很重，这里只关心「hover 档渲染了谁」——
// 卡片行 mock 成空壳：默认档不断言它的内部，只断言 hover 列表没出现。
vi.mock("./EntryListItem", () => ({
  EntryListItem: () => null,
}));

import { EntryList } from "./EntryList";
import { setUISetting } from "@/hooks/useUISettings";
import { useEntriesInfinite } from "@/hooks/useEntries";
import { useAISettings } from "@/hooks/useAISettings";

function makeEntry(id: string): Entry {
  return {
    id,
    feedId: "feed-1",
    title: `Title ${id}`,
    content: `<p>Content for entry ${id}</p><img src="https://example.com/${id}.jpg" />`,
    read: false,
    starred: false,
    muted: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

const allEntries = ["1", "2", "3"].map(makeEntry);

describe("文章视图 hover 档（reader-transition 批新增）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    entryListScrollPositions.clear();
    setUISetting("articleLayout", "list");
    vi.mocked(useEntriesInfinite).mockReturnValue({
      data: { pages: [{ entries: allEntries, hasMore: false }] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(useAISettings).mockReturnValue({
      data: { autoTranslate: false, summaryLanguage: "zh-CN" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  afterEach(() => {
    cleanup();
    setUISetting("articleLayout", "list");
  });

  const baseProps = {
    selection: { type: "all" as const },
    selectedEntryId: null as string | null,
    onSelectEntry: vi.fn(),
    onMarkAllRead: vi.fn(),
    unreadOnly: false,
    onToggleUnreadOnly: vi.fn(),
    contentType: "article" as const,
  };

  it("默认 list 档：渲染普通卡片行，不出现 hover 列表", () => {
    render(<EntryList {...baseProps} />);
    expect(screen.queryByTestId("hover-entry-list")).toBeNull();
  });

  it("切到 hover 档：列表是悬浮大图形态（hover-img 行），点击行选中条目", () => {
    setUISetting("articleLayout", "hover");
    const onSelectEntry = vi.fn();
    render(<EntryList {...baseProps} onSelectEntry={onSelectEntry} />);

    const list = screen.getByTestId("hover-entry-list");
    expect(list).not.toBeNull();
    const rows = list.querySelectorAll(".hover-img-project");
    expect(rows.length).toBe(3);
    // 行上同步了 data-entry-id（HoverImg 原件没有，适配层补的）
    const firstRow = rows[0];
    const secondRow = rows[1];
    expect(firstRow?.getAttribute("data-entry-id")).toBe("1");

    fireEvent.click(secondRow?.querySelector("h2") ?? secondRow as Element);
    expect(onSelectEntry).toHaveBeenCalledWith("2");
  });

  it("hover 档不影响其它视图：picture 视图不受 articleLayout 左右", () => {
    setUISetting("articleLayout", "hover");
    render(<EntryList {...baseProps} contentType="picture" />);
    expect(screen.queryByTestId("hover-entry-list")).toBeNull();
  });
});
