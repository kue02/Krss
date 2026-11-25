import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntryListItem } from "./EntryListItem";
import { extractContentMedia } from "@/lib/extract-content-media";
import { getEntryImages } from "@/lib/extract-images";
import { stripHtml } from "@/lib/html-utils";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import type { Entry, Feed } from "@/types/api";

// 部分 mock：保留真实实现，只把 extractContentMedia 换成可断言的 spy。
// 用来验证「article 视图不再无条件解析正文 HTML」（社交视图仍会调用）。
vi.mock("@/lib/extract-content-media", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/extract-content-media")>();
  return { ...actual, extractContentMedia: vi.fn(actual.extractContentMedia) };
});

// 第四十三批：缩略图不再解析正文找首图。部分 mock extract-images，只把
// getEntryImages（EntryListItem 直接调用、内部才会解析正文找图）换成可断言的 spy。
vi.mock("@/lib/extract-images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extract-images")>();
  return { ...actual, getEntryImages: vi.fn(actual.getEntryImages) };
});

/** 还原图片代理 URL 里的原始地址（`/api/proxy/image/<base64url>`）。 */
function decodeProxiedImageSrc(src: string): string {
  const match = src.match(/\/api\/proxy\/image\/([^?]+)/);
  const encoded = match?.[1];
  if (!encoded) return src;
  let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString("utf8");
}

// 社交视图会渲染 SocialMediaGallery，其 loadFromDB 走 IndexedDB；jsdom 没有
// indexedDB，打桩掉这层（本用例只关心「是否调用 extractContentMedia」）。
vi.mock("@/lib/image-dimensions-db", () => ({
  getDimensionsBatch: vi.fn(() => Promise.resolve(new Map())),
  saveDimension: vi.fn(() => Promise.resolve()),
}));

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

/**
 * 56-13：订阅右键菜单末尾挂了插件插槽（内部要 react-query 的 Provider）。
 * 这个用例集不关心插件 —— 按「这个挂点没有贡献」打桩，插槽不渲染、菜单项数不变。
 */
vi.mock("@/plugins/useContributions", () => ({
  useContributions: () => [],
}));

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

// 卡 B：订阅组行为（`useFeedMenuActions`）走 stub ——
// 这里只验证「条目菜单里出现订阅组 / 无 feed 时不渲染」，行为本身由共享组件的单测覆盖。
// 注：必须 mock，否则 hook 顶层的 useQueryClient 在无 Provider 的测试里直接抛错。
const { feedMenuActions } = vi.hoisted(() => ({
  feedMenuActions: {
    onRefresh: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onMoveToFolder: vi.fn(),
    onChangeType: vi.fn(),
  },
}));

vi.mock("@/hooks/useFeedMenuActions", () => ({
  useFeedMenuActions: () => ({ ...feedMenuActions, folders: [] }),
}));

// 社交视图的 inView 门控：默认 true（jsdom 无 IntersectionObserver 时真实
// useInView 也返回 true），离屏用例里把 inViewState.value 置 false。
// 传一个可写的 ref 对象，模拟 useInView 返回的 { ref, inView }。
const { inViewState } = vi.hoisted(() => ({ inViewState: { value: true } }));

vi.mock("@/hooks/useInView", () => ({
  useInView: () => ({ ref: { current: null }, inView: inViewState.value }),
}));

// partial mock：保留真实 stripHtml，仅换成可断言的 spy，用来验证「离屏不解析正文」。
vi.mock("@/lib/html-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/html-utils")>();
  return { ...actual, stripHtml: vi.fn(actual.stripHtml) };
});

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
    inViewState.value = true;
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

    // 24-7：源名走 MarqueeText（默认截断、悬浮跑马灯），时间 ml-auto 贴右缘
    const feedTitle = screen.getByText(feed.title);
    const publishedAt = screen.getByText("3 hours ago");

    expect(feedTitle.className).toContain("whitespace-nowrap");
    const marqueeBox = feedTitle.parentElement;
    expect(marqueeBox?.className).toContain("overflow-hidden");
    expect(marqueeBox?.className).toContain("flex-1");
    expect(publishedAt.className).toContain("ml-auto");
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

    it("离屏时只渲染轻量占位：不解析正文、不挂图片画廊", () => {
      inViewState.value = false;
      vi.mocked(stripHtml).mockClear();
      vi.mocked(extractContentMedia).mockClear();
      vi.mocked(getEntryImages).mockClear();

      const { container } = render(
        <EntryListItem
          entry={{
            ...socialEntry,
            content: '<p>离屏正文不该解析</p><img src="https://example.com/x.jpg">',
          }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
          data-entry-id="entry-1"
          social
        />,
      );

      const placeholder = container.querySelector<HTMLElement>(
        "[data-entry-placeholder]",
      );
      expect(placeholder).not.toBeNull();
      // 保留观测 / 测试需要的身份属性与最小高度，避免回滚时列表塌陷
      expect(placeholder?.getAttribute("data-entry-id")).toBe("entry-1");
      expect(placeholder?.getAttribute("data-entry-card")).toBe("");
      expect(placeholder?.style.minHeight).toBe("600px");

      // 离屏：一句正文都不解析，也不挂图片画廊
      expect(vi.mocked(stripHtml)).not.toHaveBeenCalled();
      expect(vi.mocked(extractContentMedia)).not.toHaveBeenCalled();
      expect(vi.mocked(getEntryImages)).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-slot="social-media-gallery"]'),
      ).toBeNull();
      // 占位卡不渲染标题 / 正文 / 图片
      expect(container.textContent).toBe("");
      expect(container.querySelector("img")).toBeNull();
    });

    it("进入视口后恢复正常：解析正文并挂图片画廊", () => {
      inViewState.value = true;
      vi.mocked(stripHtml).mockClear();
      vi.mocked(extractContentMedia).mockClear();

      const { container } = render(
        <EntryListItem
          entry={{
            ...socialEntry,
            content: '<p>进入视口的正文</p><img src="https://example.com/x.jpg">',
          }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
          social
        />,
      );

      expect(container.querySelector("[data-entry-placeholder]")).toBeNull();
      expect(vi.mocked(stripHtml)).toHaveBeenCalled();
      expect(vi.mocked(extractContentMedia)).toHaveBeenCalled();
      expect(screen.getByText(/进入视口的正文/)).toBeTruthy();
      expect(
        container.querySelector('[data-slot="social-media-gallery"]'),
      ).not.toBeNull();
    });

    it("没有 IntersectionObserver 时回退为直接显示真实内容（不空列表）", () => {
      // 模拟 useInView 在无 IO 环境下的返回：首帧 inView=true
      inViewState.value = true;
      vi.mocked(extractContentMedia).mockClear();

      const { container } = render(
        <EntryListItem
          entry={{
            ...socialEntry,
            content: '<p>无 IO 也要显示</p>',
          }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
          social
        />,
      );

      expect(container.querySelector("[data-entry-placeholder]")).toBeNull();
      expect(screen.getByText(/无 IO 也要显示/)).toBeTruthy();
    });

    it("虚拟分支传 deferSocialOffscreen={false}：即使离屏也渲染真实内容（裁剪交给虚拟容器）", () => {
      inViewState.value = false;
      vi.mocked(stripHtml).mockClear();
      vi.mocked(extractContentMedia).mockClear();

      const { container } = render(
        <EntryListItem
          entry={{
            ...socialEntry,
            content: '<p>虚拟容器里该显示</p><img src="https://example.com/x.jpg">',
          }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
          social
          deferSocialOffscreen={false}
        />,
      );

      // 不再降级为固定 600px 占位（虚拟容器已只挂可视行）
      expect(container.querySelector("[data-entry-placeholder]")).toBeNull();
      expect(vi.mocked(stripHtml)).toHaveBeenCalled();
      expect(vi.mocked(extractContentMedia)).toHaveBeenCalled();
      expect(screen.getByText(/虚拟容器里该显示/)).toBeTruthy();
    });

    it("只有社交视图才解析正文图片：文章视图不调用 extractContentMedia", () => {
      vi.mocked(extractContentMedia).mockClear();

      // article 视图（默认 social=false）：不应触碰 DOMParser
      const article = render(
        <EntryListItem
          entry={entry}
          feed={feed}
          isSelected={false}
          onClick={() => {}}
        />,
      );
      expect(vi.mocked(extractContentMedia)).not.toHaveBeenCalled();
      article.unmount();

      // 社交视图：仍然正常解析
      render(
        <EntryListItem
          entry={{
            ...socialEntry,
            content: '<p><img src="https://example.com/x.jpg"></p>',
          }}
          feed={feed}
          isSelected={false}
          onClick={() => {}}
          social
        />,
      );
      expect(vi.mocked(extractContentMedia)).toHaveBeenCalled();
    });

    it("已有 thumbnailUrl 时直接用代理缩略图，不解析正文找首图", () => {
      vi.mocked(getEntryImages).mockClear();

      const { container } = render(
        <EntryListItem
          entry={{
            ...entry,
            thumbnailUrl: "https://example.com/cover.png",
            content:
              '<p>body</p><img src="https://example.com/body-only.jpg">',
          }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );

      // 有 thumbnailUrl → 不解析正文
      expect(getEntryImages).not.toHaveBeenCalled();
      const image = container.querySelector<HTMLImageElement>(
        "img[loading='lazy']",
      );
      expect(image).not.toBeNull();
      // 渲染的是 thumbnailUrl 那张，不是正文首图
      const decoded = decodeProxiedImageSrc(image?.src ?? "");
      expect(decoded).toContain("example.com/cover.png");
      expect(decoded).not.toContain("body-only.jpg");
    });

    it("没有 thumbnailUrl 时退回正文首图（仍解析正文）", () => {
      vi.mocked(getEntryImages).mockClear();

      const { container } = render(
        <EntryListItem
          entry={{
            ...entry,
            thumbnailUrl: undefined,
            content: '<p>body</p><img src="https://example.com/body-only.jpg">',
          }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );

      expect(getEntryImages).toHaveBeenCalled();
      const image = container.querySelector<HTMLImageElement>(
        "img[loading='lazy']",
      );
      expect(decodeProxiedImageSrc(image?.src ?? "")).toContain(
        "example.com/body-only.jpg",
      );
    });

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

    it("正文里的链接只开链接、不连带选中条目（47-2 回归）", () => {
      const onClick = vi.fn();
      render(
        <EntryListItem
          entry={{
            ...socialEntry,
            // Telegram / RSSHub 的正文普遍长这样：链接外面还套着 span 一类的壳
            content:
              '<p>看这个 <a href="https://example.com/x" target="_blank"><span>链接</span></a></p>',
          }}
          feed={feed}
          isSelected={false}
          onClick={onClick}
          social
        />,
      );

      fireEvent.click(screen.getByText("链接"));
      expect(onClick).not.toHaveBeenCalled();

      // 对照：点正文文字本身仍然要能选中条目（卡片的主点击区没被一起挡掉）
      fireEvent.click(screen.getByText(/看这个/));
      expect(onClick).toHaveBeenCalledWith("entry-1");
    });

    it("星标条目在社交视图来源行也显示星标徽标（与文章视图同一套样式）", () => {
      const { container } = render(
        <EntryListItem
          entry={{ ...socialEntry, starred: true }}
          feed={feed}
          isSelected={false}
          onClick={() => {}}
          social
        />,
      );
      const badge = container.querySelector("[data-entry-starred-badge]");
      expect(badge).not.toBeNull();
      expect(badge?.getAttribute("class")).toContain("text-amber-500");
      expect(badge?.getAttribute("class")).not.toContain("fill-amber-500");
      expect(badge?.getAttribute("class")).toContain("size-3.5");
      expect(badge?.getAttribute("aria-hidden")).toBe("true");
    });
  });

  describe("已读 / 未读的标题样式 + 星标徽标", () => {
    // 与 Web 端一致：字重恒为 font-semibold，只用颜色区分读态（改字重会改换行 → 卡片高度跳动）。
    // 注：jsdom 里没有 Tailwind 的 CSS，量不到 computed style，所以断言类名。
    it("未读/已读标题都是 font-semibold，只有文字颜色不同", () => {
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
      expect(unreadClass).not.toContain("font-normal");
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
      expect(readClass).not.toContain("font-normal");
      expect(readClass).toContain("text-muted-foreground");
    });

    it("星标条目在来源行显示星标徽标，未星标不显示", () => {
      const starred = render(
        <EntryListItem
          entry={{ ...entry, starred: true }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      expect(
        starred.container.querySelector("[data-entry-starred-badge]"),
      ).not.toBeNull();
      starred.unmount();

      const plain = render(
        <EntryListItem
          entry={{ ...entry, starred: false }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      expect(
        plain.container.querySelector("[data-entry-starred-badge]"),
      ).toBeNull();
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

  describe("移动端长按不触发系统文字选择", () => {
    it("普通卡片与社交卡片的根节点都带 data-entry-card 标记", () => {
      const normal = render(
        <EntryListItem
          entry={entry}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );
      expect(
        normal.container.querySelector("[data-entry-card]"),
      ).not.toBeNull();
      normal.unmount();

      const social = render(
        <EntryListItem
          entry={{ ...entry, url: "https://x.com/op7418/status/2100033975758856654" }}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
          social
        />,
      );
      expect(
        social.container.querySelector("[data-entry-card]"),
      ).not.toBeNull();
    });

    it("index.css 只在移动端禁用卡片选择，正文阅读区规则不被牵入", () => {
      const css = readFileSync("src/index.css", "utf8");
      const start = css.indexOf("@media (max-width: 767px)");
      expect(start).toBeGreaterThanOrEqual(0);

      const block = css.slice(start, css.indexOf("\n}", start) + 2);
      expect(block).toContain("[data-entry-card]");
      expect(block).toContain("user-select: none");
      expect(block).toContain("-webkit-user-select: none");
      expect(block).toContain("-webkit-touch-callout: none");
      // 只禁卡片：不能把整个列表/正文区一起禁掉
      expect(block).not.toContain(".entry-content");
      expect(block).not.toContain("[data-entry-list]");
    });
  });

  describe("条目菜单里的订阅组（卡 B）", () => {
    beforeEach(() => {
      for (const fn of Object.values(feedMenuActions)) fn.mockClear();
    });

    it("有 feed 时菜单里出现订阅组（标题 + 订阅项）", () => {
      render(
        <EntryListItem
          entry={entry}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );

      fireEvent.contextMenu(screen.getByText("Entry title"));

      // 订阅组标题行（t mock 直接返回 key）
      expect(screen.getByText("entry.feed_menu_group")).toBeTruthy();
      // 订阅项与第一栏同一套 key：刷新 / 新建规则 / 删除
      expect(screen.getByText("actions.refresh")).toBeTruthy();
      expect(screen.getByText("automation.rule_from_feed")).toBeTruthy();
      expect(screen.getByText("actions.delete")).toBeTruthy();
    });

    it("订阅组的操作调的是传入的同一份行为（点刷新 → feedActions.onRefresh(feed.id)）", () => {
      render(
        <EntryListItem
          entry={entry}
          feed={feed}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );

      fireEvent.contextMenu(screen.getByText("Entry title"));
      fireEvent.click(screen.getByText("actions.refresh"));

      expect(feedMenuActions.onRefresh).toHaveBeenCalledWith(feed.id);
    });

    it("feed 有主站地址时订阅组里出现「前往主站 / 复制主站地址」", () => {
      render(
        <EntryListItem
          entry={entry}
          feed={{ ...feed, siteUrl: "https://example.com" }}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );

      fireEvent.contextMenu(screen.getByText("Entry title"));

      expect(screen.getByText("actions.open_site")).toBeTruthy();
      expect(screen.getByText("actions.copy_site_url")).toBeTruthy();
    });

    it("siteUrl 拿不到时那两项隐藏（siteUrl 为空 + 纯 feed 文件地址反解不出主站）", () => {
      render(
        <EntryListItem
          entry={entry}
          feed={{ ...feed, siteUrl: undefined }}
          isSelected={false}
          onClick={vi.fn()}
        />,
      );

      fireEvent.contextMenu(screen.getByText("Entry title"));

      // 订阅组本身在，但主站两项不在
      expect(screen.getByText("entry.feed_menu_group")).toBeTruthy();
      expect(screen.queryByText("actions.open_site")).toBeNull();
      expect(screen.queryByText("actions.copy_site_url")).toBeNull();
    });

    it("没有 feed 时不渲染订阅组也不崩", () => {
      render(
        <EntryListItem entry={entry} isSelected={false} onClick={vi.fn()} />,
      );

      fireEvent.contextMenu(screen.getByText("Entry title"));

      // 条目自己的项还在，订阅组不在
      expect(screen.getByText("automation.rule_from_entry")).toBeTruthy();
      expect(screen.queryByText("entry.feed_menu_group")).toBeNull();
    });
  });
});
