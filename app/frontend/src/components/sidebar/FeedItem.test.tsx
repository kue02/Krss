import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedItem } from "./FeedItem";
import { queryClient } from "@/lib/queryClient";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import type { Feed } from "@/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const feed: Feed = {
  id: "feed-1",
  title: "Example Feed",
  url: "https://example.com/feed.xml",
  type: "article",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("FeedItem 右键菜单", () => {
  afterEach(() => {
    cleanup();
    useFilterEditorStore.getState().close();
    queryClient.clear();
  });

  it("「为此订阅新建规则」按该订阅打开规则编辑器", () => {
    queryClient.setQueryData(["feeds"], [feed]);

    render(<FeedItem feedId={feed.id} name={feed.title} feedUrl={feed.url} />);

    fireEvent.contextMenu(screen.getByText(feed.title));
    fireEvent.click(screen.getByText("automation.rule_from_feed"));

    const state = useFilterEditorStore.getState();
    expect(state.open).toBe(true);
    expect(state.draft?.scopeType).toBe("feed");
    expect(state.draft?.scopeId).toBe(feed.id);
  });

  it("feeds 缓存里没有该订阅时按 props 兜底", () => {
    render(
      <FeedItem
        feedId="feed-uncached"
        name="Uncached Feed"
        feedUrl="https://example.com/other.xml"
      />,
    );

    fireEvent.contextMenu(screen.getByText("Uncached Feed"));
    fireEvent.click(screen.getByText("automation.rule_from_feed"));

    const state = useFilterEditorStore.getState();
    expect(state.open).toBe(true);
    expect(state.draft?.scopeType).toBe("feed");
    expect(state.draft?.scopeId).toBe("feed-uncached");
  });
});
