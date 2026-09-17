import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListBox } from "@heroui/react";
import { FeedItem } from "./FeedItem";
import { queryClient } from "@/lib/queryClient";
import { useFilterEditorStore } from "@/stores/filter-editor-store";
import type { Feed } from "@/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 第一栏订阅外观（用户 11-12）：默认只有名称；切成 name_and_site 才挂 @源站
const uiSettings: Record<string, unknown> = { sidebarFeedAppearance: "default" };
vi.mock("@/hooks/useUISettings", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useUISettings")>(
    "@/hooks/useUISettings",
  );
  return { ...actual, useUISettingKey: (key: string) => uiSettings[key] };
});

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
    uiSettings.sidebarFeedAppearance = "default";
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

  it("有主站地址时右键菜单出现「前往主站 / 复制主站地址」（用户 11-11）", () => {
    queryClient.setQueryData(["feeds"], [feed]);
    const opened: string[] = [];
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation((url: string | URL | undefined) => {
        opened.push(String(url));
        return null;
      });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <FeedItem
        feedId="feed-tw"
        name="Twitter @歸藏"
        feedUrl="https://rsshub.example.com/twitter/user/op7418?key=secret"
      />,
    );
    fireEvent.contextMenu(screen.getByText("Twitter @歸藏"));

    expect(screen.getByText("actions.open_site")).toBeTruthy();
    expect(screen.getByText("actions.copy_site_url")).toBeTruthy();

    // 点「复制主站地址」→ 写进剪贴板的必须是那个主页地址（菜单点完就收起，后面再开一次点另一项）
    fireEvent.click(screen.getByText("actions.copy_site_url"));
    expect(writeText).toHaveBeenCalledWith("https://x.com/op7418");

    fireEvent.contextMenu(screen.getByText("Twitter @歸藏"));
    fireEvent.click(screen.getByText("actions.open_site"));
    expect(opened).toEqual(["https://x.com/op7418"]);
    openSpy.mockRestore();
  });

  it("拿不到主站地址时这两项不出现（不给假地址）", () => {
    queryClient.setQueryData(["feeds"], [feed]);

    render(
      <FeedItem
        feedId="feed-unknown"
        name="有知有行"
        feedUrl="https://rsshub.example.com/youzhiyouxing/materials"
      />,
    );
    fireEvent.contextMenu(screen.getByText("有知有行"));

    expect(screen.queryByText("actions.open_site")).toBeNull();
    expect(screen.queryByText("actions.copy_site_url")).toBeNull();
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

  it("「名称 + @源站」外观：行里挂一条指向主页的链接（用户 11-12）", () => {
    uiSettings.sidebarFeedAppearance = "name_and_site";

    render(
      <FeedItem
        feedId="feed-tw"
        name="Twitter @歸藏"
        feedUrl="https://rsshub.example.com/twitter/user/op7418"
      />,
    );

    const link = screen.getByText("@x.com");
    expect(link.getAttribute("href")).toBe("https://x.com/op7418");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("ListBox 模式：渲染成 ListBox.Item，名称与 @源站 走 Label + Description（用户 11-12）", () => {
    uiSettings.sidebarFeedAppearance = "name_and_site";

    render(
      <ListBox aria-label="订阅">
        <FeedItem
          feedId="feed-tw"
          name="Twitter @歸藏"
          feedUrl="https://rsshub.example.com/twitter/user/op7418"
          asListBoxItem
        />
      </ListBox>,
    );

    const option = document.querySelector('[role="option"]');
    expect(option).not.toBeNull();
    // 两行：Label（名称）+ Description（@源站）—— 这正是 HeroUI 文档里那种排版
    expect(option?.querySelector('[data-slot="label"]')?.textContent).toBe("Twitter @歸藏");
    const desc = option?.querySelector('[data-slot="description"]');
    expect(desc?.textContent).toBe("@x.com");
    expect(desc?.querySelector("a")?.getAttribute("href")).toBe("https://x.com/op7418");
  });

  it("默认外观：行里没有 @源站 链接", () => {
    render(
      <FeedItem
        feedId="feed-tw"
        name="Twitter @歸藏"
        feedUrl="https://rsshub.example.com/twitter/user/op7418"
      />,
    );

    expect(screen.queryByText("@x.com")).toBeNull();
  });
});
