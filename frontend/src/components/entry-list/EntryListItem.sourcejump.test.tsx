import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryListItem } from "./EntryListItem";
import type { Entry, Feed } from "@/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === "entry.view_feed" ? `查看订阅 ${options?.name}` : key,
  }),
}));

vi.mock("@/hooks/useEntries", () => ({
  useMarkAsRead: () => ({ mutate: vi.fn() }),
  useMarkAsStarred: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/hooks/useFilters", () => ({
  useUnmuteEntry: () => ({ mutate: vi.fn() }),
  useCreateFilterException: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useFilters: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/stores/translation-store", () => ({
  useTranslationStore: (
    selector: (state: { getTranslation: () => undefined }) => unknown,
  ) => selector({ getTranslation: () => undefined }),
}));

vi.mock("@/hooks/useFeedMenuActions", () => ({
  useFeedMenuActions: () => ({
    onRefresh: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onMoveToFolder: vi.fn(),
    onChangeType: vi.fn(),
    folders: [],
  }),
}));

const entry: Entry = {
  id: "entry-1",
  feedId: "feed-1",
  title: "Entry title",
  content: "<p>Entry summary</p>",
  read: false,
  starred: false,
  muted: false,
  publishedAt: "2024-01-01T09:00:00.000Z",
  createdAt: "2024-01-01T09:00:00.000Z",
  updatedAt: "2024-01-01T09:00:00.000Z",
};

const feed: Feed = {
  id: "feed-1",
  title: "少数派",
  url: "https://sspai.com/feed",
  siteUrl: "https://sspai.com",
  type: "article",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

/**
 * 52-4（用户第 4 条）：点条目的**订阅源名称** → 第一栏选中该订阅（走 selectFeed 那条路），
 * 而不是「选中这条条目」。所以断言两件事：
 * ① 回调收到 feed.id；② 卡片根那个「选中条目」的 onClick **没被触发**（stopPropagation 生效）。
 */
describe("EntryListItem 来源行点击（52-4）", () => {
  it("传了回调：点源名 = 跳订阅，且不连带选中条目", () => {
    const onSelectFeed = vi.fn();
    const onClickEntry = vi.fn();
    render(
      <EntryListItem
        entry={entry}
        feed={feed}
        isSelected={false}
        onClick={onClickEntry}
        onSelectFeedFromEntry={onSelectFeed}
      />,
    );

    // 图标与源名挂的是同一份 props ⇒ 两个同名 title；点其一即可
    const sources = screen.getAllByTitle(`查看订阅 ${feed.title}`);
    const source = sources.at(0);
    if (!source) throw new Error("来源行没挂上跳转 props");
    fireEvent.click(source);

    expect(onSelectFeed).toHaveBeenCalledWith("feed-1");
    expect(onClickEntry).not.toHaveBeenCalled();
  });

  it("图标与源名共用一份跳转（两处 title 相同）", () => {
    const onSelectFeed = vi.fn();
    render(
      <EntryListItem
        entry={entry}
        feed={feed}
        isSelected={false}
        onClick={vi.fn()}
        onSelectFeedFromEntry={onSelectFeed}
      />,
    );

    // 文章卡片：img 与 MarqueeText 各挂一份 → 两个同名 title
    expect(screen.queryAllByTitle(`查看订阅 ${feed.title}`).length).toBeGreaterThanOrEqual(2);
  });

  it("没传回调：来源行保持原样，不可点也不报错", () => {
    const onClickEntry = vi.fn();
    render(
      <EntryListItem
        entry={entry}
        feed={feed}
        isSelected={false}
        onClick={onClickEntry}
      />,
    );

    expect(screen.queryAllByTitle(`查看订阅 ${feed.title}`).length).toBe(0);
    // 卡片本身照旧：点条目 = 选中条目
    fireEvent.click(screen.getByText("Entry title"));
    expect(onClickEntry).toHaveBeenCalledWith("entry-1");
  });
});
