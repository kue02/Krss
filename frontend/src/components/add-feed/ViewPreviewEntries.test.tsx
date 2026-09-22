import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ViewPreviewEntries } from "./ViewPreviewEntries";
import type { FeedPreview, FeedPreviewEntry } from "@/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/entry-list/EntryListItem", () => ({
  EntryListItem: ({ entry, social }: { entry: { id: string }; social?: boolean }) => (
    <div
      data-testid="entry-card"
      data-id={entry.id}
      data-social={String(Boolean(social))}
    />
  ),
}));

vi.mock("@/components/picture-masonry/PictureItem", () => ({
  PictureItem: ({ entry }: { entry: { id: string } }) => (
    <div data-testid="picture-item" data-id={entry.id} />
  ),
}));

function makeFeed(entries: FeedPreviewEntry[]): FeedPreview {
  return { url: "https://example.com/feed.xml", title: "示例源", entries };
}

const textEntries: FeedPreviewEntry[] = [
  { title: "一", content: "<p>a</p>" },
  { title: "二", content: "<p>b</p>" },
  { title: "三", content: "<p>c</p>" },
  { title: "四", content: "<p>d</p>" },
];

describe("ViewPreviewEntries 试看", () => {
  it("文章视图：用真实卡片渲染前 4 条", () => {
    render(
      <ViewPreviewEntries
        type="article"
        feed={makeFeed([...textEntries, ...textEntries])}
      />,
    );

    const cards = screen.getAllByTestId("entry-card");
    expect(cards).toHaveLength(4);
    expect(cards[0]?.dataset.social).toBe("false");
  });

  it("社交媒体视图：走社交形态的卡片", () => {
    render(<ViewPreviewEntries type="social" feed={makeFeed(textEntries)} />);

    expect(screen.getAllByTestId("entry-card")[0]?.dataset.social).toBe("true");
  });

  it("图片视图：只画有图的条目，无图的跳过", () => {
    render(
      <ViewPreviewEntries
        type="picture"
        feed={makeFeed([
          { title: "有图", thumbnailUrl: "https://example.com/a.png" },
          { title: "没图" },
          { title: "有图2", thumbnailUrl: "https://example.com/b.png" },
        ])}
      />,
    );

    expect(screen.getAllByTestId("picture-item")).toHaveLength(2);
  });

  it("图片视图：前几条都没有图时给出提示而不是空白框", () => {
    render(<ViewPreviewEntries type="picture" feed={makeFeed(textEntries)} />);

    expect(screen.queryAllByTestId("picture-item")).toHaveLength(0);
    expect(screen.getByText("add_feed.view_preview_no_image")).toBeTruthy();
  });

  it("源没有条目时给出提示", () => {
    render(<ViewPreviewEntries type="article" feed={makeFeed([])} />);

    expect(screen.getByText("add_feed.view_preview_empty")).toBeTruthy();
  });
});
