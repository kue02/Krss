import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntryListItem } from "./EntryListItem";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import type { Entry, Feed } from "@/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "add_feed.hours_ago") return `${options?.count} hours ago`;
      if (key === "entry.untitled") return "Untitled";
      if (key === "entry.unknown_feed") return "Unknown feed";
      return key;
    },
  }),
}));

const { markAsRead, markAsStarred, unmuteMutate, exceptionMutate } = vi.hoisted(
  () => ({
    markAsRead: vi.fn(),
    markAsStarred: vi.fn(),
    unmuteMutate: vi.fn(),
    exceptionMutate: vi.fn(),
  }),
);

vi.mock("@/hooks/useEntries", () => ({
  useMarkAsRead: () => ({ mutate: markAsRead }),
  useMarkAsStarred: () => ({ mutate: markAsStarred }),
}));

vi.mock("@/hooks/useFilters", () => ({
  useUnmuteEntry: () => ({ mutate: unmuteMutate }),
  useCreateFilterException: () => ({ mutate: exceptionMutate, isPending: false }),
  // MutedBadge 用规则名做悬停说明；测试里给一条规则即可
  useFilters: () => ({
    data: [{ id: "rule-1", name: "静音推广" }],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/stores/translation-store", () => ({
  useTranslationStore: (
    selector: (state: { getTranslation: () => undefined }) => unknown,
  ) => selector({ getTranslation: () => undefined }),
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
  title: "GitHub File - TechnitiumSoftware/DnsServer",
  url: "https://example.com/feed.xml",
  siteUrl: "https://example.com",
  type: "article",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("EntryListItem", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps published time outside the truncated feed title", () => {
    render(
      <EntryListItem
        entry={entry}
        feed={feed}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    const feedTitle = screen.getByText(feed.title);
    const publishedAt = screen.getByText("3 hours ago");

    expect(feedTitle.className).toContain("truncate");
    expect(feedTitle.className).not.toContain("flex-1");
    expect(publishedAt.className).toContain("shrink-0");
    expect(publishedAt.className).toContain("whitespace-nowrap");
  });

  it("allows URL previews to wrap instead of clipping horizontally", () => {
    render(
      <EntryListItem
        entry={{
          ...entry,
          title: "重复下载:\nhttps://haloshell.halocloudnet.com/download",
          content:
            "<p>HaloCloud 通知频道（链接：https://haloshell.halocloudnet.com/download）</p>",
        }}
        feed={feed}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    const title = screen.getByText(/重复下载/);
    const summary = screen.getByText(/HaloCloud 通知频道/);

    expect(title.className).toContain("wrap-anywhere");
    expect(title.className).toContain("line-clamp-3");
    expect(summary.className).toContain("wrap-anywhere");
    // 摘要行数改由本地外观设置驱动（内联 -webkit-line-clamp），URL 预览多给一行
    expect(summary.getAttribute("style")).toContain("-webkit-line-clamp: 3");
  });

  it("列表图片设为「不显示」时不渲染缩略图", async () => {
    const { setUISetting } = await import("@/hooks/useUISettings");
    setUISetting("cardImageSize", "none");

    const { container } = render(
      <EntryListItem
        entry={{ ...entry, thumbnailUrl: "https://example.com/cover.png" }}
        feed={feed}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    expect(container.querySelector("img[loading='lazy']")).toBeNull();

    setUISetting("cardImageSize", "small");
  });

  it("大图档位时缩略图铺满卡片宽度", async () => {
    const { setUISetting } = await import("@/hooks/useUISettings");
    setUISetting("cardImageSize", "large");

    const { container } = render(
      <EntryListItem
        entry={{ ...entry, thumbnailUrl: "https://example.com/cover.png" }}
        feed={feed}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    const image = container.querySelector("img[loading='lazy']");
    expect(image?.parentElement?.className).toContain("w-full");

    setUISetting("cardImageSize", "small");
  });

  describe("社交媒体视图", () => {
    const socialEntry: Entry = {
      ...entry,
      url: "https://x.com/op7418/status/2100033975758856654",
    };

    it("条目用居中可读宽度（对齐 Folo），不是通栏", () => {
      const { container } = render(
        <EntryListItem
          entry={socialEntry}
          feed={feed}
          isSelected={false}
          onClick={() => {}}
          data-entry-id="entry-1"
          social
        />,
      );
      const row = container.querySelector("[data-entry-id]");
      expect(row?.className).toContain("max-w-[clamp(45ch,60vw,65ch)]");
      expect(row?.className).toContain("mx-auto");
    });

    it("从链接解析出 @handle 并链到作者主页", () => {
      render(
        <EntryListItem
          entry={socialEntry}
          feed={feed}
          isSelected={false}
          onClick={() => {}}
          social
        />,
      );
      const handle = screen.getByText("@op7418");
      expect(handle.getAttribute("href")).toBe("https://x.com/op7418");
      expect(handle.getAttribute("target")).toBe("_blank");
    });

    it("悬停操作条：切换星标/已读，且不触发打开文章", () => {
      const onClick = vi.fn();
      render(
        <EntryListItem
          entry={socialEntry}
          feed={feed}
          isSelected={false}
          onClick={onClick}
          social
        />,
      );

      fireEvent.click(screen.getByTitle("entry.add_to_starred"));
      expect(markAsStarred).toHaveBeenCalledWith({
        id: "entry-1",
        starred: true,
      });

      fireEvent.click(screen.getByTitle("entry.mark_read"));
      expect(markAsRead).toHaveBeenCalledWith({ id: "entry-1", read: true });

      expect(onClick).not.toHaveBeenCalled();
    });

    it("源名里已带同一 handle 时不重复显示", () => {
      render(
        <EntryListItem
          entry={socialEntry}
          feed={{ ...feed, title: "op7418" }}
          isSelected={false}
          onClick={() => {}}
          social
        />,
      );
      expect(screen.queryByText("@op7418")).toBeNull();
    });
  });

  describe("已读 / 未读的样式不改变布局（BUG-2 回归）", () => {
    // 原来读态把标题从 font-semibold 切成 font-medium：字重一变，同一条标题的换行数就可能变
    // （1 行 ↔ 2 行），卡片高度跟着变 —— 滚动时「标记已读」会让整个列表跳一下。
    // 对齐 Nextflux 的 ArticleCard：字体恒为 semibold，只用颜色区分读态。
    // 注：jsdom 里没有 Tailwind 的 CSS，量 computed style 拿不到字重，所以断言类名。
    it("未读与已读的标题类名都是 font-semibold，只有文字颜色类不同", () => {
      const unread = render(
        <EntryListItem
          entry={{ ...entry, read: false }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      const unreadClass = screen.getByText(entry.title!).className;
      expect(unreadClass).toContain("font-semibold");
      expect(unreadClass).not.toContain("font-medium");
      expect(unreadClass).toContain("text-foreground");
      unread.unmount();

      render(
        <EntryListItem
          entry={{ ...entry, read: true }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      const readClass = screen.getByText(entry.title!).className;
      expect(readClass).toContain("font-semibold");
      expect(readClass).not.toContain("font-medium");
      expect(readClass).toContain("text-muted-foreground");
    });
  });

  describe("过滤规则入口", () => {
    beforeEach(() => {
      useFilterEditorStore.getState().close();
      unmuteMutate.mockClear();
    });

    it("被静音的条目在元信息行显示「已静音」细标签", () => {
      render(
        <EntryListItem
          entry={{ ...entry, muted: true }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );

      const badge = screen.getByText("automation.muted_badge");
      // 细标签而不是大卡片：小字号 + muted-foreground + 小圆角
      expect(badge.className).toContain("text-[10px]");
      expect(badge.className).toContain("text-muted-foreground");
      expect(badge.className).toContain("rounded-[3px]");
      expect(badge.className).not.toContain("rounded-full");
    });

    it("未被静音的条目不显示标签", () => {
      render(
        <EntryListItem
          entry={entry}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );

      expect(screen.queryByText("automation.muted_badge")).toBeNull();
    });

    it("右键菜单：「按此条新建规则」打开编辑器并按该条预填", () => {
      render(
        <EntryListItem
          entry={entry}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );

      fireEvent.contextMenu(screen.getByText("Entry title"));
      expect(screen.queryByText("automation.unmute_entry")).toBeNull();

      fireEvent.click(screen.getByText("automation.rule_from_entry"));

      const state = useFilterEditorStore.getState();
      expect(state.open).toBe(true);
      expect(state.draft?.scopeType).toBe("feed");
      expect(state.draft?.scopeId).toBe(entry.feedId);
    });

    it("右键菜单：静音条目多一条「取消静音」并调用 unmute", () => {
      render(
        <EntryListItem
          entry={{ ...entry, muted: true, filterId: "rule-1" }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );

      fireEvent.contextMenu(screen.getByText("Entry title"));
      fireEvent.click(screen.getByText("automation.unmute_entry"));

      // 取消静音后会弹一条提示，所以第二个参数是 onSuccess 回调
      expect(unmuteMutate).toHaveBeenCalledWith(
        entry.id,
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      // 取消静音不该顺带打开规则编辑器
      expect(useFilterEditorStore.getState().open).toBe(false);
    });

    it("右键菜单不会触发卡片点击（不打开文章）", () => {
      const onClick = vi.fn();
      render(
        <EntryListItem
          entry={entry}
          feed={feed}
          isSelected={false}
          onClick={onClick}
        />,
      );

      fireEvent.contextMenu(screen.getByText("Entry title"));
      expect(onClick).not.toHaveBeenCalled();
    });

    it("社交媒体视图同样显示「已静音」标签", () => {
      render(
        <EntryListItem
          entry={{
            ...entry,
            muted: true,
            url: "https://x.com/op7418/status/2100033975758856654",
          }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
          social
        />,
      );

      expect(screen.getByText("automation.muted_badge")).toBeTruthy();
    });
  });
});
