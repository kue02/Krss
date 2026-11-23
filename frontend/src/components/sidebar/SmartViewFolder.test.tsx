import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SmartViewFolder, resolveMatchedFeeds } from "./SmartViewFolder";
import type { FilterRule } from "@/types/filters";
import type { Feed } from "@/types/api";

const { getViewMatchedFeedsMock } = vi.hoisted(() => ({
  getViewMatchedFeedsMock: vi.fn(),
}));

vi.mock("@/api", () => ({
  getViewMatchedFeeds: getViewMatchedFeedsMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 单测里 FeedItem 被替换成普通 div，HeroUI ListBox 的集合只认 ListBox.Item 子元素会渲染不出来；
// 这里把外观设成非 name_and_site 档，走普通 FeedItem 分支即可覆盖展开/动态列表逻辑。
// 「第一栏订阅外观 = 名称+源站」的 ListBox 分支由浏览器实测（docs/dev/shots/smartviews-child-style.png）覆盖。
vi.mock("@/hooks/useUISettings", () => ({
  useUISettingKey: () => "name",
}));

// 只测智能文件夹本身的展开/动态列表逻辑，FeedItem 的渲染另有专门测试
vi.mock("./FeedItem", () => ({
  FeedItem: ({ name, unreadCount }: { name: string; unreadCount?: number }) => (
    <div data-testid="matched-feed" data-count={unreadCount ?? 0}>
      {name}
    </div>
  ),
}));

function makeView(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: "view-1",
    name: "AI 周报",
    enabled: true,
    position: 0,
    kind: "view",
    scopeType: "all",
    conditions: [],
    actions: {},
    matchCount: 0,
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    ...overrides,
  };
}

function renderFolder(
  view: FilterRule,
  opts: { feeds?: Feed[]; count?: number; onSelectView?: () => void } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onSelectView = opts.onSelectView ?? vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(
    <SmartViewFolder
      view={view}
      count={opts.count ?? 0}
      isActive={false}
      feeds={opts.feeds ?? []}
      folders={[]}
      isFeedSelected={() => false}
      onSelectView={onSelectView}
      onSelectFeed={vi.fn()}
      onRefreshView={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />,
    { wrapper },
  );
  return { onSelectView };
}

/** 行内唯一 button 就是 chevron（展开/收起开关） */
function clickChevron() {
  fireEvent.click(screen.getByRole("button"));
}

beforeEach(() => {
  getViewMatchedFeedsMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SmartViewFolder", () => {
  it("折叠时不请求；展开后才按 view.id 拉取并渲染动态匹配的订阅名", async () => {
    getViewMatchedFeedsMock.mockResolvedValue({
      feeds: [{ feedId: "1", feedTitle: "少数派", count: 3 }],
    });
    const { onSelectView } = renderFolder(makeView({ id: "view-expand" }));

    // 折叠态：enabled=false，不应触发请求
    expect(getViewMatchedFeedsMock).not.toHaveBeenCalled();

    clickChevron();

    // 展开后渲染匹配订阅名与角标
    const item = await screen.findByTestId("matched-feed");
    expect(item.textContent).toBe("少数派");
    expect(item.getAttribute("data-count")).toBe("3");
    expect(getViewMatchedFeedsMock).toHaveBeenCalledWith("view-expand", undefined);
    // chevron 只负责展开，不应顺带选中视图
    expect(onSelectView).not.toHaveBeenCalled();
  });

  it("当前无匹配订阅时显示空态文案（内容消失的源不再出现）", async () => {
    getViewMatchedFeedsMock.mockResolvedValue({ feeds: [] });
    renderFolder(makeView({ id: "view-empty" }));

    clickChevron();

    expect(await screen.findByText("sidebar.view_no_matches")).toBeTruthy();
    expect(screen.queryByTestId("matched-feed")).toBeNull();
  });

  it("展开的多源按顺序渲染，数量随后端返回而变", async () => {
    getViewMatchedFeedsMock.mockResolvedValue({
      feeds: [
        { feedId: "1", feedTitle: "源甲", count: 2 },
        { feedId: "2", feedTitle: "源乙", count: 0 },
      ],
    });
    renderFolder(makeView({ id: "view-multi" }));

    clickChevron();

    const items = await screen.findAllByTestId("matched-feed");
    expect(items.map((el) => el.textContent)).toEqual(["源甲", "源乙"]);
  });
});

describe("resolveMatchedFeeds", () => {
  it("优先用本地 Feed 元数据（标题/地址/内容类型），缺失时退回后端 feedTitle", () => {
    const feeds: Feed[] = [
      {
        id: "1",
        title: "本地标题",
        url: "https://a/feed",
        type: "article",
        createdAt: "2026-11-23T00:00:00Z",
        updatedAt: "2026-11-23T00:00:00Z",
      },
    ];
    const resolved = resolveMatchedFeeds(
      [
        { feedId: "1", feedTitle: "后端标题", count: 5 },
        { feedId: "2", feedTitle: "仅后端", count: 0 },
      ],
      feeds,
    );

    expect(resolved[0]).toMatchObject({
      feedId: "1",
      name: "本地标题",
      feedUrl: "https://a/feed",
      contentType: "article",
      count: 5,
    });
    expect(resolved[1]).toMatchObject({ feedId: "2", name: "仅后端", count: 0 });
  });
});
