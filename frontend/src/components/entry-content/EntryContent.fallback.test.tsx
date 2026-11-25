import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "@/types/api";

const state = vi.hoisted(() => ({
  queryEntry: undefined as Entry | undefined,
  isError: false,
  fallbackEntry: undefined as Entry | undefined,
  markAsRead: vi.fn(),
  bodyNotice: undefined as string | undefined,
}));

const entry: Entry = {
  id: "entry-1",
  feedId: "feed-1",
  title: "Title",
  content: "<p>body</p>",
  url: null,
  read: false,
  starred: false,
  muted: false,
  publishedAt: "2024-01-01T09:00:00.000Z",
  createdAt: "2024-01-01T09:00:00.000Z",
  updatedAt: "2024-01-01T09:00:00.000Z",
} as unknown as Entry;

vi.mock("./EntryContentHeader", () => ({ EntryContentHeader: () => <div /> }));
vi.mock("./EntryContentBody", () => ({
  EntryContentBody: (props: { notice?: string }) => {
    state.bodyNotice = props.notice;
    return <div data-testid="body" />;
  },
}));
vi.mock("./EntryToc", () => ({ EntryToc: () => null }));
vi.mock("./ReadingProgressBar", () => ({ ReadingProgressBar: () => null }));
vi.mock("./OriginalSiteView", () => ({ OriginalSiteView: () => null }));
vi.mock("@/components/mobile/MobileEntryNav", () => ({ MobileEntryNav: () => null }));
vi.mock("@heroui/react", () => ({
  Button: (props: { children?: React.ReactNode; onPress?: () => void }) => (
    <button onClick={props.onPress}>{props.children}</button>
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/lib/entry-cache", () => ({
  findCachedListEntry: () => state.fallbackEntry,
}));
vi.mock("@/hooks/useEntries", () => ({
  useEntry: () => ({
    data: state.queryEntry,
    isLoading: false,
    isError: state.isError,
    refetch: vi.fn(),
  }),
  useMarkAsRead: () => ({ mutate: state.markAsRead }),
  useMarkAsStarred: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/useAISettings", () => ({ useAISettings: () => ({ data: {} }) }));
vi.mock("@/hooks/useGeneralSettings", () => ({ useGeneralSettings: () => ({ data: {} }) }));
vi.mock("@/hooks/useFeeds", () => ({ useFeeds: () => ({ data: [] }) }));
vi.mock("@/hooks/useEntryContentScroll", () => ({
  useEntryContentScroll: () => ({ scrollRef: { current: null }, isAtTop: true, scrollNode: null }),
}));
vi.mock("@/hooks/useScrollToTop", () => ({ useScrollToTop: () => {} }));
vi.mock("@/hooks/useReadability", () => ({
  useReadability: () => ({
    isReadableLoading: false,
    readableContent: undefined,
    readableError: null,
    isReadableActive: false,
    baseContent: "",
    handleToggleReadable: vi.fn(),
  }),
}));
vi.mock("@/hooks/useAISummary", () => ({
  useAISummary: () => ({ aiSummary: null, isLoadingSummary: false, summaryError: null, handleToggleSummary: vi.fn() }),
}));
vi.mock("@/hooks/useAITranslation", () => ({
  useAITranslation: () => ({
    isTranslating: false,
    hasTranslation: false,
    translationDisabled: false,
    displayTitle: undefined,
    translatedContentBlocks: null,
    combinedTranslatedContent: null,
    translationError: null,
    handleToggleTranslation: vi.fn(),
  }),
}));
vi.mock("@/stores/translation-store", () => ({
  useTranslationStore: () => undefined,
}));
vi.mock("@/components/entry-list/deferred-removal", () => ({
  deferUnreadRemovals: vi.fn(),
}));
vi.mock("@/lib/auto-translate", () => ({
  resolveEntryAutoTranslate: () => false,
}));

async function renderContent() {
  const { EntryContent } = await import("./EntryContent");
  render(<EntryContent entryId="entry-1" />);
}

beforeEach(() => {
  state.queryEntry = undefined;
  state.isError = false;
  state.fallbackEntry = undefined;
  state.markAsRead = vi.fn();
  state.bodyNotice = undefined;
});

afterEach(() => cleanup());

describe("EntryContent 详情失败降级", () => {
  it("详情失败但列表有缓存：渲染只读预览并提示，不触发自动标已读", async () => {
    state.isError = true;
    state.fallbackEntry = entry;
    await renderContent();

    expect(screen.getByTestId("body")).toBeTruthy();
    expect(state.bodyNotice).toBe("entry.content_from_cache");
    expect(state.markAsRead).not.toHaveBeenCalled();
  });

  it("详情失败且列表无缓存：显示加载失败与重试，不显示「选择一篇文章」", async () => {
    state.isError = true;
    await renderContent();
    expect(screen.getByText("entry.load_failed")).toBeTruthy();
    expect(screen.getByText("entry.retry")).toBeTruthy();
  });

  it("详情正常：不渲染缓存提示，并按真实详情自动标已读", async () => {
    state.queryEntry = entry;
    await renderContent();
    expect(state.bodyNotice).toBeUndefined();
    expect(state.markAsRead).toHaveBeenCalledWith({
      id: "entry-1",
      read: true,
      skipInvalidate: true,
    });
  });
});
