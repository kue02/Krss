import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
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

/**
 * 31-2：文章 hover 档的行就是普通卡片行（EntryListItem），悬停靠容器事件委托认
 * `data-entry-id` —— 所以这个 mock 必须把行渲染出来（原来 mock 成 null）。
 */
vi.mock("./EntryListItem", () => ({
  EntryListItem: ({
    entry,
    onClick,
  }: {
    entry: Entry;
    onClick: (id: string) => void;
  }) => (
    <div
      data-entry-id={entry.id}
      data-testid={`row-${entry.id}`}
      onClick={() => onClick(entry.id)}
    >
      row {entry.id}
    </div>
  ),
}));

/* 浮块本体（跟随指针 + gsap 动画）在 NotificationTimelineHoverBody.test.tsx 里测；
 * 这里只关心「文章 hover 档把哪一条喂给了它」。 */
vi.mock("./NotificationBodyPreview", () => ({
  NotificationBodyPreview: ({
    entry,
    visible,
    interactive,
  }: {
    entry: Entry | null;
    visible: boolean;
    interactive?: boolean;
  }) => (
    <div
      data-testid="article-hover-body"
      data-visible={visible ? "true" : "false"}
      data-entry={entry?.id ?? ""}
      data-interactive={interactive === false ? "false" : "true"}
    />
  ),
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

describe("文章视图 hover 档（reader-transition 批新增；31-2 改成悬停正文）", () => {
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

  it("默认 list 档：不挂悬停委托、不渲染浮块", () => {
    const { container } = render(<EntryList {...baseProps} />);
    expect(
      container.querySelector("[data-article-body-hover]"),
    ).toBeNull();
    expect(screen.queryByTestId("article-hover-body")).toBeNull();
  });

  it("hover 档：行还是普通卡片行；悬停某行 → 浮块显示「这一条」；移出 250ms 才收", () => {
    vi.useFakeTimers();
    setUISetting("articleLayout", "hover");
    const { container } = render(<EntryList {...baseProps} />);

    // 行仍是卡片行（不再换成 hover-img 的图片行）
    expect(screen.getByTestId("row-1")).toBeTruthy();
    expect(screen.getByTestId("row-2")).toBeTruthy();
    expect(container.querySelector(".hover-img-project")).toBeNull();
    expect(
      container.querySelector('[data-article-body-hover="true"]'),
    ).not.toBeNull();

    const float = screen.getByTestId("article-hover-body");
    expect(float.getAttribute("data-visible")).toBe("false");
    // 33-1：文章档的浮块必须「不吃指针」，否则以指针为中心 ⇒ 指针永远在浮块里 ⇒ 卡住不切
    expect(float.getAttribute("data-interactive")).toBe("false");

    // 悬停第 2 行 → 浮块可见且是「2」这一条
    fireEvent.mouseOver(screen.getByTestId("row-2"), {
      clientX: 300,
      clientY: 200,
      relatedTarget: null,
    });
    expect(float.getAttribute("data-visible")).toBe("true");
    expect(float.getAttribute("data-entry")).toBe("2");

    // 移出列表（relatedTarget 不在任何行上）→ 250ms 内仍可见，之后才收
    fireEvent.mouseOut(screen.getByTestId("row-2"), { relatedTarget: null });
    expect(float.getAttribute("data-visible")).toBe("true");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(float.getAttribute("data-visible")).toBe("false");

    vi.useRealTimers();
  });

  it("hover 档：从一行移到另一行不闪烁（浮块持续可见、内容跟着换）", () => {
    setUISetting("articleLayout", "hover");
    render(<EntryList {...baseProps} />);
    const float = screen.getByTestId("article-hover-body");

    fireEvent.mouseOver(screen.getByTestId("row-1"), {
      clientX: 300,
      clientY: 200,
    });
    expect(float.getAttribute("data-entry")).toBe("1");

    // mouseout 的 relatedTarget 落在另一行上 ⇒ 不该触发延迟收
    fireEvent.mouseOut(screen.getByTestId("row-1"), {
      relatedTarget: screen.getByTestId("row-3"),
    });
    fireEvent.mouseOver(screen.getByTestId("row-3"), {
      clientX: 300,
      clientY: 460,
    });
    expect(float.getAttribute("data-visible")).toBe("true");
    expect(float.getAttribute("data-entry")).toBe("3");
  });

  it("hover 档：点击行照旧选中条目（用推进转场把正文推进右侧）", () => {
    setUISetting("articleLayout", "hover");
    const onSelectEntry = vi.fn();
    render(<EntryList {...baseProps} onSelectEntry={onSelectEntry} />);
    fireEvent.click(screen.getByTestId("row-2"));
    const calls = onSelectEntry.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]?.[0]).toBe("2");
  });

  it("hover 档不影响其它视图：picture 视图不受 articleLayout 左右", () => {
    setUISetting("articleLayout", "hover");
    const { container } = render(
      <EntryList {...baseProps} contentType="picture" />,
    );
    expect(container.querySelector("[data-article-body-hover]")).toBeNull();
    expect(screen.queryByTestId("article-hover-body")).toBeNull();
  });
});
