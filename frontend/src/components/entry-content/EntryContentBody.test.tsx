import { render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntryContentBody } from "./EntryContentBody";
import { useEntryMeta } from "@/hooks/useEntryMeta";
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
  useEntryMeta: vi.fn(() => ({
    feedTitle: null,
    publishedLong: null,
    publishedShort: null,
    readingTime: null,
  })),
}));

beforeEach(() => {
  vi.mocked(useEntryMeta).mockReturnValue({
    feedTitle: null,
    publishedLong: null,
    publishedShort: null,
    readingTime: null,
  });
});

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


// 56-32：正文装饰取数改成 react-query，渲染必须有 Provider（装饰拉不到就当没有，不影响这些断言）。
function render(ui: React.ReactElement) {
  return rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  );
}

/** 取 article 的 class token（精确到单个类，避免 `md:pb-20` 命中 `pb-20` 子串） */
function articleTokens(container: HTMLElement): string[] {
  const article = container.querySelector("article");
  expect(article).not.toBeNull();
  return article?.className.split(/\s+/) ?? [];
}

describe("EntryContentBody", () => {
  // 移动端正文末尾留白：10rem + 安全区，md（768px）起回到 80px
  it("keeps a 10rem + safe-area tail on the mobile article", () => {
    const { container } = render(
      <EntryContentBody
        entry={entry}
        scrollRef={vi.fn()}
        displayContent={entry.content}
      />,
    );

    const tokens = articleTokens(container);
    expect(tokens).toContain("pb-[calc(10rem+env(safe-area-inset-bottom))]");
    expect(tokens).toContain("md:pb-20");
    expect(tokens).not.toContain("pb-20");
    expect(tokens).not.toContain("md:pb-6");
  });

  // 留白必须落在滚动容器内部才会被算进 scrollHeight：article 直接挂在 viewport 下，
  // 且非 embedded 档 viewport 自己就是 overflow-y-auto 的滚动节点。
  it("keeps the article inside the scrolling viewport", () => {
    const { container } = render(
      <EntryContentBody
        entry={entry}
        scrollRef={vi.fn()}
        displayContent={entry.content}
      />,
    );

    const article = container.querySelector("article");
    const viewport = article?.parentElement;
    expect(viewport?.className).toContain("entry-content-viewport");
    expect(viewport?.className).toContain("overflow-y-auto");
  });

  // embedded（时间线展开 / 「向下合列」）移动端同样要 10rem 尾部留白，
  // md 起回到原来的紧凑 24px（桌面合列与时间线档）
  it("gives the embedded variant the same mobile tail and md:pb-6", () => {
    const { container } = render(
      <EntryContentBody
        entry={entry}
        embedded
        scrollRef={vi.fn()}
        displayContent={entry.content}
      />,
    );

    const tokens = articleTokens(container);
    expect(tokens).toContain("pb-[calc(10rem+env(safe-area-inset-bottom))]");
    expect(tokens).toContain("md:pb-6");
    expect(tokens).not.toContain("pb-6");
    expect(tokens).not.toContain("md:pb-20");
  });

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

  // 正文页头署名行：源名存在时渲染订阅源标题
  it("renders the source feed title in the byline when the feed is present", () => {
    render(
      <EntryContentBody
        entry={entry}
        scrollRef={vi.fn()}
        displayContent={entry.content}
      />,
    );

    // 默认 feed mock 的标题是「黄赟」，条目无作者，故只来自源名
    expect(screen.getByText("黄赟")).toBeTruthy();
  });

  // 正文页头署名行：阅读时长存在时渲染
  it("renders the reading time in the byline", () => {
    vi.mocked(useEntryMeta).mockReturnValue({
      feedTitle: null,
      publishedLong: null,
      publishedShort: null,
      readingTime: "3 分钟",
    });

    render(
      <EntryContentBody
        entry={entry}
        scrollRef={vi.fn()}
        displayContent={entry.content}
      />,
    );

    expect(screen.getByText("3 分钟")).toBeTruthy();
  });

  // 正文页头：不安全的 URL 时标题不应是链接
  it("does not render the title as a link when entry.url is unsafe", () => {
    const unsafeEntry: Entry = {
      ...entry,
      title: "不安全标题",
      url: "javascript:alert(1)",
    };

    render(
      <EntryContentBody
        entry={unsafeEntry}
        scrollRef={vi.fn()}
        displayContent={entry.content}
      />,
    );

    expect(screen.queryByRole("link", { name: "不安全标题" })).toBeNull();
    expect(screen.getByText("不安全标题")).toBeTruthy();
  });

  // RSSHub 的 YouTube 条目 content 常为空：正文空态要用 entry.url 兜底出播放器
  it("renders an embedded player for empty YouTube entries", () => {
    const youtubeEntry: Entry = {
      ...entry,
      title: "空正文 YouTube 条目",
      url: "https://www.youtube.com/watch?v=pCWXA6yZL0I",
      content: "",
    };

    const { container } = render(
      <EntryContentBody
        entry={youtubeEntry}
        scrollRef={vi.fn()}
        displayContent=""
      />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe(
      "https://www.youtube.com/embed/pCWXA6yZL0I?rel=0&modestbranding=1&playsinline=1",
    );
    expect(screen.queryByText("entry.no_content")).toBeNull();
  });

  // 空正文兜底只接受「被改写过」的播放器地址：bilibili 空间页这类原样 URL 仍显示空态
  it("keeps the empty state for a non-player bilibili article url", () => {
    const nonPlayer: Entry = {
      ...entry,
      title: "bilibili 空间页",
      url: "https://space.bilibili.com/123456",
      content: "",
    };

    const { container } = render(
      <EntryContentBody entry={nonPlayer} scrollRef={vi.fn()} displayContent="" />,
    );

    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText("entry.no_content")).toBeTruthy();
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