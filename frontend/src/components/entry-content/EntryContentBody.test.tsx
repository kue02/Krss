import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryContentBody } from "./EntryContentBody";
import type { Entry } from "@/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/useCodeHighlight", () => ({
  useCodeHighlight: vi.fn(),
}));

vi.mock("@/hooks/useEntryMeta", () => ({
  useEntryMeta: () => ({
    publishedLong: null,
    readingTime: null,
  }),
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: () => ({
    data: [
      { id: "feed-1", title: "黄赟", iconPath: "example-user.ico" },
    ],
  }),
}));

vi.mock("@/components/ui/article-content", () => ({
  ArticleContent: ({ content }: { content?: string }) => <div>{content}</div>,
}));

const entry: Entry = {
  id: "entry-1",
  feedId: "feed-1",
  title: "重复下载:\nhttps://haloshell.halocloudnet.com/download",
  url: "https://haloshell.halocloudnet.com/download",
  content: "<p>修复了部分错误</p>",
  read: false,
  starred: false,
  muted: false,
  createdAt: "2026-05-10T00:00:00.000Z",
  updatedAt: "2026-05-10T00:00:00.000Z",
};

describe("EntryContentBody", () => {
  it("allows long URL titles to wrap instead of clipping horizontally", () => {
    render(
      <EntryContentBody
        entry={entry}
        scrollRef={vi.fn()}
        displayContent={entry.content}
      />,
    );

    const titleLink = screen.getByRole("link", { name: /haloshell/ });
    const title = titleLink.closest("h1");

    expect(title?.className).toContain("wrap-anywhere");
    expect(titleLink.className).not.toContain("wrap-anywhere");
  });

  // 37-2：社交视图正文页不显示标题（社交条目的标题多半就是正文开头）
  it("hides the title and shows the feed avatar in the social header", () => {
    const socialEntry: Entry = {
      ...entry,
      author: "黄赟",
      url: "https://x.com/op7418/status/2100033975758856654",
    };

    const { container } = render(
      <EntryContentBody
        entry={socialEntry}
        isSocial
        scrollRef={vi.fn()}
        displayContent={entry.content}
      />,
    );

    expect(container.querySelector("h1")).toBeNull();
    const header = container.querySelector('[data-slot="social-entry-header"]');
    expect(header).not.toBeNull();

    const avatar = header?.querySelector('[data-slot="feed-avatar"]');
    expect(avatar?.getAttribute("src")).toBe("/icons/example-user.ico");
    // 作者名后面补 @handle（源名里没带 handle 时）
    expect(header?.textContent).toContain("黄赟");
    expect(screen.getByRole("link", { name: "@op7418" })).toBeTruthy();
  });
});