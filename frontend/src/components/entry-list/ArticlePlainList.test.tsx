import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArticlePlainListRow } from "./ArticlePlainList";
import type { Entry, Feed } from "@/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useFeedMenuActions", () => ({
  useFeedMenuActions: () => ({ folders: [] }),
}));

const quickActionMocks = vi.hoisted(() => ({
  read: vi.fn(),
  star: vi.fn(),
}));

vi.mock("@/hooks/useEntries", () => ({
  useMarkAsRead: () => ({ mutate: quickActionMocks.read }),
  useMarkAsStarred: () => ({ mutate: quickActionMocks.star }),
}));

vi.mock("@/hooks/useFilters", () => ({
  useUnmuteEntry: () => ({ mutate: vi.fn() }),
  useCreateFilterException: () => ({ mutate: vi.fn(), isPending: false }),
  useFilters: () => ({ data: [], isLoading: false, isError: false }),
}));

vi.mock("@/plugins/useContributions", () => ({
  useContributions: () => [],
}));

vi.mock("@/plugins/useInvokePluginAction", () => ({
  useInvokePluginAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

function makeEntry(overrides: Partial<Entry>): Entry {
  return {
    id: "e1",
    feedId: "f1",
    read: false,
    starred: false,
    muted: false,
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    ...overrides,
  } as Entry;
}

function makeFeed(overrides: Partial<Feed>): Feed {
  return {
    id: "f1",
    title: "示例来源",
    ...overrides,
  } as Feed;
}

describe("ArticlePlainListRow（文章「Inoreader列表」= inoreader）", () => {
  it("渲染来源图标 + 加粗标题 + 右侧来源·时间，且没有缩略图与摘要", () => {
    const { container } = render(
      <ArticlePlainListRow
        entry={makeEntry({
          id: "e1",
          title: "第一篇标题",
          content: "<p>这是一段正文摘要，不该出现在列表里</p>",
          thumbnailUrl: "https://example.com/t.jpg",
          publishedAt: "2026-11-20T00:00:00Z",
        })}
        feed={makeFeed({ id: "f1", title: "来源甲", iconPath: "a.png" })}
      />,
    );

    expect(screen.getByText("第一篇标题")).toBeTruthy();
    expect(screen.getByText(/来源甲/)).toBeTruthy();
    // 唯一的 <img> 是 16px 的来源小图标，不是 64×64 缩略图
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("data-slot")).toBe("feed-avatar");
    expect(container.querySelector(".size-16")).toBeNull();
    expect(container.querySelector(".hover-img-thumbnail-wrapper")).toBeNull();
    expect(container.querySelector(".krss-hover-img")).toBeNull();
    expect(screen.queryByText(/这是一段正文摘要/)).toBeNull();
  });

  it("点击行回调 onSelectEntry(entry.id)，选中行带 data-selected", () => {
    const onSelectEntry = vi.fn();
    const { container } = render(
      <>
        <ArticlePlainListRow
          entry={makeEntry({ id: "e1", title: "已选中" })}
          feed={makeFeed({})}
          onSelectEntry={onSelectEntry}
          selectedEntryId="e1"
        />
        <ArticlePlainListRow
          entry={makeEntry({ id: "e2", title: "未选中" })}
          feed={makeFeed({})}
          onSelectEntry={onSelectEntry}
          selectedEntryId="e1"
        />
      </>,
    );

    const selectedRow = container.querySelector('[data-entry-id="e1"]');
    const otherRow = container.querySelector('[data-entry-id="e2"]');
    expect(selectedRow?.getAttribute("data-selected")).toBe("true");
    expect(otherRow?.getAttribute("data-selected")).toBeNull();

    fireEvent.click(otherRow as Element);
    expect(onSelectEntry).toHaveBeenCalledWith("e2");
  });

  it("未读标记沿用全站样式，显示在行首（圆点/角标挂在来源图标左上角）", () => {
    const { container } = render(
      <>
        <ArticlePlainListRow
          entry={makeEntry({ id: "u1", title: "未读条目", read: false })}
          feed={makeFeed({})}
        />
        <ArticlePlainListRow
          entry={makeEntry({ id: "r1", title: "已读条目", read: true })}
          feed={makeFeed({})}
        />
      </>,
    );
    // 默认「未读标记」= 圆点档，只在未读行出现
    expect(container.querySelectorAll('[data-unread-marker="dot"]')).toHaveLength(1);
    const unreadRow = container.querySelector('[data-entry-id="u1"]');
    // 快捷动作在最左，未读点仍然挂在来源图标处（不是行尾）
    expect(unreadRow?.firstElementChild?.getAttribute("data-testid")).toBe(
      "row-quick-actions",
    );
    expect(
      unreadRow?.querySelector('[data-unread-marker="dot"]'),
    ).toBeTruthy();
  });

  it("行首提供已读/未读与星标按钮，点击只改状态、不触发打开正文", () => {
    quickActionMocks.read.mockClear();
    quickActionMocks.star.mockClear();
    const onSelectEntry = vi.fn();
    render(
      <ArticlePlainListRow
        entry={makeEntry({ id: "q1", title: "快捷动作", read: false })}
        feed={makeFeed({})}
        onSelectEntry={onSelectEntry}
      />,
    );
    fireEvent.click(screen.getByTestId("row-read-toggle"));
    expect(quickActionMocks.read).toHaveBeenCalledWith({ id: "q1", read: true });
    fireEvent.click(screen.getByTestId("row-star-toggle"));
    expect(quickActionMocks.star).toHaveBeenCalledWith({
      id: "q1",
      starred: true,
    });
    expect(onSelectEntry).not.toHaveBeenCalled();
  });

  it("右键弹出条目菜单（复用 EntryContextMenuContent，含星标项）", () => {
    render(
      <ArticlePlainListRow
        entry={makeEntry({ id: "e1", title: "右键我" })}
        feed={makeFeed({})}
      />,
    );
    fireEvent.contextMenu(screen.getByText("右键我"));
    expect(screen.getByText("entry.star")).toBeTruthy();
    expect(screen.getByText("automation.exception_entry")).toBeTruthy();
  });
});
