/**
 * 56-28：插件视图接入视图切换器。
 *
 * 四例覆盖派工书写死的四条：
 *   ① 切换器里「内置视图 + 插件视图」并列，插件那个分组按 plugin 排序；
 *   ② 声明式视图把 `query` 翻译成条目接口的参数（真的这么请求了）；
 *   ③ 自定义视图挂 `SandboxFrame`，外面有视图壳（名字 + 徽标 + 退出）；
 *   ④ 地址栏是不认识的 `?view=x:y` → 回落「文章」，不白屏、不崩。
 *
 * 打桩只打「跨进程那一层」：条目接口、插件清单接口、沙箱 iframe、条目行组件
 * （条目行里有一堆自己的查询，与本棒要验的参数映射无关）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { ContentTypeSwitcher } from "@/components/sidebar/ContentTypeSwitcher";
import { PluginViewPane, PluginViewOutlet } from "./PluginViewPane";
import { usePluginViewRoute } from "./usePluginViewRoute";
import { resolvePluginViewFromParam } from "./usePluginViews";
import { resolvePluginViewLayout } from "./view-plan";
import type { PluginView } from "./types";

const mocks = vi.hoisted(() => ({
  fetchPluginViews: vi.fn(),
  listEntries: vi.fn(),
  searchEntries: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/plugins/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/plugins/api")>()),
  fetchPluginViews: mocks.fetchPluginViews,
}));

vi.mock("@/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api")>()),
  listEntries: mocks.listEntries,
  searchEntries: mocks.searchEntries,
}));

/** 沙箱 iframe：本棒只关心「交给 SandboxFrame 的是哪个插件 / 哪个入口 / 哪个视图」 */
vi.mock("./SandboxFrame", () => ({
  SandboxFrame: (props: {
    pluginId: string;
    page?: string;
    title: string;
    view?: { id: string; title?: string };
  }) => (
    <div
      data-testid="sandbox-frame"
      data-plugin-id={props.pluginId}
      data-page={props.page ?? ""}
      data-title={props.title}
      data-view-id={props.view?.id ?? ""}
    />
  ),
}));

vi.mock("@/hooks/useFeeds", () => ({
  useFeeds: () => ({ data: [] }),
}));

vi.mock("@/components/entry-list/EntryListItem", () => ({
  EntryListItem: ({ entry }: { entry: { id: string; title: string } }) => (
    <div data-testid="entry-row">{entry.title}</div>
  ),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const counts = { article: 3, picture: 2, notification: 1, social: 4 };
const builtinTypes = ["article", "picture", "notification", "social"] as const;

/** 两个插件视图：一个声明式（alpha）、一个自定义（zeta）——故意乱序传入，验排序 */
const twoViews: PluginView[] = [
  {
    plugin: "zeta",
    id: "radar",
    label: "雷达",
    icon: "mail",
    kind: "custom",
    entry: "index.html",
  },
  {
    plugin: "alpha",
    id: "picks",
    label: "精选",
    icon: "star",
    kind: "declarative",
    layout: "list",
    query: { unread: true, starred: true, types: ["article"], feedIds: [7] },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchPluginViews.mockResolvedValue([]);
  mocks.listEntries.mockResolvedValue({ entries: [], hasMore: false });
  mocks.searchEntries.mockResolvedValue({ entries: [], hasMore: false });
});

afterEach(() => {
  cleanup();
});

describe("56-28 插件视图", () => {
  it("① 切换器里内置视图在前、插件视图在后，插件按 plugin 排序", () => {
    render(
      <ContentTypeSwitcher
        contentType="article"
        counts={counts}
        onSelect={() => undefined}
        visibleContentTypes={[...builtinTypes]}
        pluginViews={twoViews}
        activePluginView={null}
        onSelectPluginView={() => undefined}
      />,
    );

    const builtin = screen.getByTestId("view-switcher-builtin");
    const pluginGroup = screen.getByTestId("view-switcher-plugin");

    // 内置四个都在（文章/图片/通知/社交），且整组排在插件组之前
    expect(within(builtin).getAllByRole("button")).toHaveLength(4);
    expect(
      builtin.compareDocumentPosition(pluginGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // 两个插件视图都出现，且按 plugin 排序（传入顺序是 zeta、alpha）
    const rows = within(pluginGroup).getAllByTestId(
      "view-switcher-plugin-item",
    );
    expect(rows.map((row) => row.getAttribute("data-plugin"))).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("精选"),
      expect.stringContaining("雷达"),
    ]);
  });

  it("② 声明式视图把 query 翻成条目接口参数（真的是这么请求的）", async () => {
    mocks.listEntries.mockResolvedValue({
      entries: [
        {
          id: "1",
          feedId: "7",
          title: "一条精选",
          url: "https://example.com/1",
          read: false,
          starred: true,
          muted: false,
          createdAt: "2026-10-27T00:00:00Z",
          updatedAt: "2026-10-27T00:00:00Z",
        },
      ],
      hasMore: false,
    });

    render(
      <PluginViewPane view={twoViews[1]!} onExit={() => undefined} />,
      { wrapper },
    );

    await waitFor(() => expect(mocks.listEntries).toHaveBeenCalled());
    expect(mocks.listEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        feedId: "7",
        contentType: "article",
        unreadOnly: true,
        starredOnly: true,
      }),
    );
    // 取回来的条目用现有行组件画出来了
    await waitFor(() =>
      expect(screen.getAllByTestId("entry-row")).toHaveLength(1),
    );

    // layout 映射：认得的三种照做，认不出的按 list（插件写错一个词不该打不开视图）
    expect(resolvePluginViewLayout("timeline")).toBe("timeline");
    expect(resolvePluginViewLayout("grid")).toBe("grid");
    expect(resolvePluginViewLayout("framework-of-the-day")).toBe("list");
    expect(resolvePluginViewLayout(undefined)).toBe("list");
  });

  it("③ 自定义视图挂 SandboxFrame，外面有视图壳（名字 + 徽标 + 退出）", async () => {
    const onExit = vi.fn();
    render(<PluginViewPane view={twoViews[0]!} onExit={onExit} />, {
      wrapper,
    });

    const frame = screen.getByTestId("sandbox-frame");
    expect(frame.getAttribute("data-plugin-id")).toBe("zeta");
    expect(frame.getAttribute("data-page")).toBe("index.html");
    expect(frame.getAttribute("data-view-id")).toBe("radar");

    // 视图壳：随时能切走
    expect(screen.getByText("雷达")).toBeTruthy();
    expect(screen.getByText("plugins.plugin_view_badge")).toBeTruthy();
    fireEvent.click(screen.getByText("plugins.plugin_view_exit"));
    expect(onExit).toHaveBeenCalledTimes(1);
    // 自定义视图不该顺带请求条目
    expect(mocks.listEntries).not.toHaveBeenCalled();
  });

  it("④ 未知 ?view=x:y → 回落「文章」，且地址栏里的旧值被摘掉", async () => {
    const memory = memoryLocation({
      path: "/all?type=article&view=x:y",
      record: true,
    });

    const { result } = renderHook(() => usePluginViewRoute(), {
      wrapper: ({ children }) => (
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Router hook={memory.hook}>{children}</Router>
        </QueryClientProvider>
      ),
    });

    await waitFor(() => expect(result.current.resolution.status).toBe("none"));
    // 停用 / 卸载插件后地址栏里的旧 id 不能再挂着（否则刷新永远回不到列表）
    await waitFor(() =>
      expect(memory.history?.at(-1)).toBe("/all?type=article"),
    );

    // 解析器本身把「认不出的 key」与「压根没有 view 参数」分得开：
    // 前者是 unknown（要摘参数），后者是 none（内置视图，什么都不用做）
    expect(resolvePluginViewFromParam([], "x:y")).toEqual({
      status: "unknown",
      raw: "x:y",
    });
    expect(resolvePluginViewFromParam([], "")).toEqual({ status: "none" });
    expect(resolvePluginViewFromParam(undefined, "x:y")).toEqual({
      status: "loading",
    });

    // 认不出的视图交给内置「文章」列表，不是一块白屏
    render(
      <PluginViewOutlet
        resolution={{ status: "unknown", raw: "x:y" }}
        fallback={<div data-testid="builtin-article">文章</div>}
        onExit={() => undefined}
      />,
      { wrapper },
    );
    expect(screen.getByTestId("builtin-article")).toBeTruthy();
  });
});
