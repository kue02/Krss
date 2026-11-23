import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArticleRowsList } from "./ArticleRowsList";
import type { Entry, Feed } from "@/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useFeedMenuActions", () => ({
  useFeedMenuActions: () => ({
    folders: [],
    onRefresh: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onMoveToFolder: vi.fn(),
    onChangeType: vi.fn(),
  }),
}));

vi.mock("@/hooks/useEntries", () => ({
  useMarkAsRead: () => ({ mutate: vi.fn() }),
  useMarkAsStarred: () => ({ mutate: vi.fn() }),
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

describe("ArticleRowsList（文章「列表」布局 = rows）", () => {
  it("渲染紧凑行：标题 + 来源名 + 元信息，且无悬停浮层大图", () => {
    const { container } = render(
      <ArticleRowsList
        items={[
          {
            entry: makeEntry({
              id: "e1",
              title: "第一篇标题",
              publishedAt: "2026-11-20T00:00:00Z",
            }),
            feed: makeFeed({ id: "f1", title: "来源甲" }),
          },
        ]}
      />,
    );

    expect(screen.getByTestId("article-rows-list")).toBeTruthy();
    expect(screen.getByText("第一篇标题")).toBeTruthy();
    expect(screen.getByText("来源甲")).toBeTruthy();

    // rows 布局不带图片悬停行 / 浮层大图
    expect(container.querySelector(".krss-hover-img")).toBeNull();
    expect(container.querySelector(".hover-img-thumbnail-wrapper")).toBeNull();
  });

  it("点击行回调 onSelectEntry(entry.id)，选中行带 data-selected", () => {
    const onSelectEntry = vi.fn();
    render(
      <ArticleRowsList
        items={[
          { entry: makeEntry({ id: "e1", title: "已选中" }), feed: makeFeed({}) },
          { entry: makeEntry({ id: "e2", title: "未选中" }), feed: makeFeed({}) },
        ]}
        onSelectEntry={onSelectEntry}
        selectedEntryId="e1"
      />,
    );

    const selectedRow = document.querySelector('[data-entry-id="e1"]');
    const otherRow = document.querySelector('[data-entry-id="e2"]');
    expect(selectedRow?.getAttribute("data-selected")).toBe("true");
    expect(otherRow?.getAttribute("data-selected")).toBeNull();

    fireEvent.click(otherRow as Element);
    expect(onSelectEntry).toHaveBeenCalledWith("e2");
  });
});
