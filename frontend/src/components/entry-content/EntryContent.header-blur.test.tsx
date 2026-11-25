import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 46-x 接线测试：`headerBackgroundBlur` 必须原样透传给顶栏。
 *
 * 卡片档 pane 用 `overflow:clip` 裁圆角，带 backdrop-filter 的工具栏背景层会逃逸裁剪、
 * 盖住卡片圆角，所以卡片档必须关掉模糊；「原样」档靠 clip-path 裁剪，保留模糊。
 * 只测顶栏组件本身挡不住「接线写反/漏传」，这里把顶栏换成探针验转发。
 */
const captured: Array<{
  backgroundBlur?: boolean;
  backgroundTopRadius?: boolean;
}> = [];

vi.mock("./EntryContentHeader", () => ({
  EntryContentHeader: (props: {
    backgroundBlur?: boolean;
    backgroundTopRadius?: boolean;
  }) => {
    captured.push({
      backgroundBlur: props.backgroundBlur,
      backgroundTopRadius: props.backgroundTopRadius,
    });
    return <div data-testid="header-probe" />;
  },
}));
vi.mock("./EntryContentBody", () => ({ EntryContentBody: () => <div /> }));
vi.mock("./EntryToc", () => ({ EntryToc: () => null }));
vi.mock("./ReadingProgressBar", () => ({ ReadingProgressBar: () => null }));
vi.mock("./OriginalSiteView", () => ({ OriginalSiteView: () => null }));
vi.mock("@/components/mobile/MobileEntryNav", () => ({ MobileEntryNav: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/hooks/useEntries", () => ({
  useEntry: () => ({
    data: {
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
    },
    isLoading: false,
  }),
  useMarkAsRead: () => ({ mutate: vi.fn() }),
  useMarkAsStarred: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/useAISettings", () => ({ useAISettings: () => ({ data: {} }) }));
vi.mock("@/hooks/useGeneralSettings", () => ({
  useGeneralSettings: () => ({ data: {} }),
}));
vi.mock("@/hooks/useFeeds", () => ({ useFeeds: () => ({ data: [] }) }));
vi.mock("@/hooks/useEntryContentScroll", () => ({
  useEntryContentScroll: () => ({
    scrollRef: { current: null },
    isAtTop: true,
    scrollNode: null,
  }),
}));
vi.mock("@/hooks/useScrollToTop", () => ({ useScrollToTop: () => {} }));
vi.mock("@/hooks/useReadability", () => ({
  useReadability: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock("@/hooks/useAISummary", () => ({
  useAISummary: () => ({
    summary: null,
    isLoading: false,
    isLoadingSummary: false,
    error: null,
    usage: null,
    toggle: vi.fn(),
  }),
}));
vi.mock("@/hooks/useAITranslation", () => ({
  useAITranslation: () => ({
    isTranslating: false,
    hasTranslation: false,
    isDisabled: false,
    error: null,
    usage: null,
    toggle: vi.fn(),
  }),
}));
vi.mock("@/stores/translation-store", () => ({
  useTranslationStore: () => ({ translatedContent: null }),
}));
vi.mock("@/components/entry-list/deferred-removal", () => ({
  deferUnreadRemovals: vi.fn(),
}));
vi.mock("@/lib/auto-translate", () => ({
  resolveEntryAutoTranslate: () => false,
}));

afterEach(() => {
  cleanup();
  captured.length = 0;
});

async function renderContent(props: {
  embedded?: boolean;
  headerBackgroundBlur?: boolean;
  headerBackgroundRoundedTop?: boolean;
}) {
  const { EntryContent } = await import("./EntryContent");
  render(<EntryContent entryId="entry-1" {...props} />);
  const last = captured[captured.length - 1];
  if (!last) throw new Error("header not rendered");
  return last;
}

describe("EntryContent → 顶栏背景模糊接线", () => {
  it("embedded + headerBackgroundBlur=false（卡片档）→ 关模糊", async () => {
    expect((await renderContent({ embedded: true, headerBackgroundBlur: false })).backgroundBlur).toBe(false);
  });

  it("embedded + headerBackgroundBlur=true（原样档）→ 保留模糊", async () => {
    expect((await renderContent({ embedded: true, headerBackgroundBlur: true })).backgroundBlur).toBe(true);
  });

  it("非内嵌（第三栏）→ 保留模糊", async () => {
    expect((await renderContent({})).backgroundBlur).toBe(true);
  });

  it("embedded 未传值 → 默认保留模糊", async () => {
    expect((await renderContent({ embedded: true })).backgroundBlur).toBe(true);
  });
});

describe("EntryContent → 顶栏背景层顶部圆角接线", () => {
  it("embedded + headerBackgroundRoundedTop=true → 透传 backgroundTopRadius", async () => {
    expect(
      (await renderContent({ embedded: true, headerBackgroundRoundedTop: true }))
        .backgroundTopRadius,
    ).toBe(true);
  });

  it("embedded 未传值 → backgroundTopRadius 默认 false", async () => {
    expect((await renderContent({ embedded: true })).backgroundTopRadius).toBe(false);
  });
});
