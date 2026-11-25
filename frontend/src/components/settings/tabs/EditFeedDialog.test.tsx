import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { EditFeedDialog } from "./EditFeedDialog";
import type { Feed } from "@/types/api";

const { mockMutateAsync, mockOnOpenChange, mockUseUpdateFeed } = vi.hoisted(
  () => ({
    mockMutateAsync: vi.fn(),
    mockOnOpenChange: vi.fn(),
    mockUseUpdateFeed: vi.fn(),
  }),
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (
        params &&
        typeof params.count !== "undefined" &&
        typeof params.max !== "undefined"
      ) {
        return `${params.count} / ${params.max}`;
      }
      if (params && typeof params.max !== "undefined") {
        return `${key}:${params.max}`;
      }
      return key;
    },
  }),
}));

vi.mock("@/hooks/useFeeds", () => ({
  useUpdateFeed: mockUseUpdateFeed,
  useUpdateFeedAI: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// 16-14：编辑页里挂了向导（用 folders + queryClient），测试里桩掉
vi.mock("@/hooks/useFolders", () => ({ useFolders: () => ({ data: [] }) }));

// 16-14：编辑页里挂了向导（保存后让 feeds 失效），测试里只桩 useQueryClient，其余透传
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

// 14 批：弹窗里新增了代理覆盖（三态 + 生效结果）——这些用例只关心标题/提示词/AI 三态，
// 所以把代理那两个 hook 换成不连后端的桩。
const { mockUpdateFeedProxy } = vi.hoisted(() => ({
  mockUpdateFeedProxy: vi.fn(),
}));

vi.mock("@/hooks/useProxySources", () => ({
  useProxySources: () => ({ data: undefined }),
  useUpdateFeedProxy: () => ({
    mutateAsync: mockUpdateFeedProxy,
    isPending: false,
  }),
}));

// 改地址用到的几个接口：只覆盖这四个，其余 @/api 导出透传（向导等模块还要真实导出）
const { mockUpdateFeedUrl, mockGetFeedMergePreview, mockMergeFeed, mockRefreshFeeds } =
  vi.hoisted(() => ({
    mockUpdateFeedUrl: vi.fn(),
    mockGetFeedMergePreview: vi.fn(),
    mockMergeFeed: vi.fn(),
    mockRefreshFeeds: vi.fn(),
  }));

vi.mock("@/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api")>();
  return {
    ...actual,
    updateFeedUrl: mockUpdateFeedUrl,
    getFeedMergePreview: mockGetFeedMergePreview,
    mergeFeed: mockMergeFeed,
    refreshFeeds: mockRefreshFeeds,
  };
});

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogHeader: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function buildFeed(overrides: Partial<Feed> = {}): Feed {
  return {
    id: "feed-1",
    title: "Feed Title",
    url: "https://example.com/feed.xml",
    folderId: "folder-1",
    type: "article",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("EditFeedDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockResolvedValue(undefined);
    mockUseUpdateFeed.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    });
    // 代理覆盖的 PATCH：回显里带实际生效结果（弹窗保存时要读它）
    mockUpdateFeedProxy.mockResolvedValue({
      feed: { id: "feed-1" },
      effective: { mode: "direct", source: "global" },
    });
    // 改地址相关接口默认桩：无撞车
    mockUpdateFeedUrl.mockResolvedValue(undefined);
    mockMergeFeed.mockResolvedValue({
      targetId: "feed-2",
      movedEntries: 1,
      dedupedEntries: 0,
    });
    mockRefreshFeeds.mockResolvedValue(undefined);
    mockGetFeedMergePreview.mockResolvedValue({
      source: { id: "feed-1", title: "Feed Title", entries: 1, starred: 0 },
      target: null,
    });
  });

  it("会带上代理三态，并在保存后回显生效结果", async () => {
    render(
      <EditFeedDialog
        feed={buildFeed({ proxyMode: "direct" })}
        open
        onOpenChange={mockOnOpenChange}
      />,
    );

    // 三态初始档位跟着 feed.proxyMode 走（direct → 选中「直连」那一档）
    const directButton = screen.getByRole("button", { name: "proxy.direct" });
    expect(directButton.className).toContain("bg-item-active");

    // 切成「走代理」再保存：PATCH 收到的 mode 必须是 proxy
    fireEvent.click(screen.getByRole("button", { name: "proxy.use_proxy" }));
    fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

    await waitFor(() => {
      expect(mockUpdateFeedProxy).toHaveBeenCalledWith({
        id: "feed-1",
        override: { mode: "proxy" },
      });
    });
    // 服务端回显的生效结果直接显示在行上
    await waitFor(() => {
      expect(
        screen.getByText("proxy.result_direct · proxy.from_global"),
      ).not.toBeNull();
    });
  });

  it("会回填 feed 标题和摘要自定义提示词", () => {
    render(
      <EditFeedDialog
        feed={buildFeed({ summaryPromptReminder: "关注核心结论" })}
        open
        onOpenChange={mockOnOpenChange}
      />,
    );

    expect(screen.getByLabelText("feeds.feed_title")).toHaveProperty(
      "value",
      "Feed Title",
    );
    expect(
      screen.getByLabelText("feeds.summary_prompt_reminder"),
    ).toHaveProperty("value", "关注核心结论");
  });

  it("保存时会提交摘要自定义提示词", async () => {
    render(
      <EditFeedDialog
        feed={buildFeed({ summaryPromptReminder: "旧提示" })}
        open
        onOpenChange={mockOnOpenChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("feeds.feed_title"), {
      target: { value: "新标题" },
    });
    fireEvent.change(screen.getByLabelText("feeds.summary_prompt_reminder"), {
      target: { value: "优先概括关键数据" },
    });
    fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        id: "feed-1",
        title: "新标题",
        folderId: "folder-1",
        summaryPromptReminder: "优先概括关键数据",
      });
    });
    expect(mockOnOpenChange).toHaveBeenCalledWith(false);
  });

  it("超出长度限制时会禁用保存", () => {
    render(
      <EditFeedDialog
        feed={buildFeed()}
        open
        onOpenChange={mockOnOpenChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("feeds.summary_prompt_reminder"), {
      target: { value: "a".repeat(2001) },
    });

    expect(
      screen.getByText("feeds.summary_prompt_reminder_too_long:2000"),
    ).not.toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "actions.save",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("MCP 订阅多一块取数配置入口；RSS 订阅没有（16-14）", () => {
    const { rerender } = render(
      <EditFeedDialog
        feed={buildFeed({
          sourceType: "mcp",
          mcpConfig: {
            serverId: "s1",
            kind: "tool",
            toolName: "search",
            mapping: {},
          },
        })}
        open
        onOpenChange={mockOnOpenChange}
      />,
    );

    expect(screen.getByText("feeds.mcp_config_title")).toBeTruthy();
    expect(screen.getByText("feeds.mcp_config_edit")).toBeTruthy();

    rerender(
      <EditFeedDialog
        feed={buildFeed()}
        open
        onOpenChange={mockOnOpenChange}
      />,
    );
    expect(screen.queryByText("feeds.mcp_config_title")).toBeNull();
  });

  it("改订阅地址：保存时 PATCH 新地址并立即用新地址刷新一次", async () => {
    render(
      <EditFeedDialog feed={buildFeed()} open onOpenChange={mockOnOpenChange} />,
    );

    fireEvent.change(screen.getByLabelText("feeds.feed_url"), {
      target: { value: "https://new.example.com/rss" },
    });
    fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

    await waitFor(() => {
      expect(mockGetFeedMergePreview).toHaveBeenCalledWith(
        "feed-1",
        "https://new.example.com/rss",
      );
    });
    await waitFor(() => {
      expect(mockUpdateFeedUrl).toHaveBeenCalledWith(
        "feed-1",
        "https://new.example.com/rss",
      );
    });
    expect(mockRefreshFeeds).toHaveBeenCalledWith(["feed-1"], true);
    expect(mockOnOpenChange).toHaveBeenCalledWith(false);
  });

  it("地址未改动时不调用改地址接口", async () => {
    render(
      <EditFeedDialog feed={buildFeed()} open onOpenChange={mockOnOpenChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalled();
    });
    expect(mockGetFeedMergePreview).not.toHaveBeenCalled();
    expect(mockUpdateFeedUrl).not.toHaveBeenCalled();
    expect(mockRefreshFeeds).not.toHaveBeenCalled();
  });

  it("地址不合法时不提交，并提示地址无效", async () => {
    render(
      <EditFeedDialog feed={buildFeed()} open onOpenChange={mockOnOpenChange} />,
    );

    fireEvent.change(screen.getByLabelText("feeds.feed_url"), {
      target: { value: "not-a-url" },
    });
    fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

    await waitFor(() => {
      expect(screen.getByText("feeds.url_invalid")).toBeTruthy();
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockUpdateFeedUrl).not.toHaveBeenCalled();
  });

  it("地址撞到别的订阅：显示内联确认合并，确认后合并过去", async () => {
    mockGetFeedMergePreview.mockResolvedValueOnce({
      source: { id: "feed-1", title: "Feed Title", entries: 3, starred: 1 },
      target: { id: "feed-2", title: "Other Feed", entries: 5, starred: 2 },
    });

    render(
      <EditFeedDialog feed={buildFeed()} open onOpenChange={mockOnOpenChange} />,
    );

    fireEvent.change(screen.getByLabelText("feeds.feed_url"), {
      target: { value: "https://taken.example.com/rss" },
    });
    fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

    await waitFor(() => {
      expect(screen.getByText("feeds.url_conflict_title")).toBeTruthy();
    });
    // 撞车时还没写库
    expect(mockUpdateFeedUrl).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "feeds.url_merge_confirm" }),
    );

    await waitFor(() => {
      expect(mockMergeFeed).toHaveBeenCalledWith("feed-1", "feed-2");
    });
    expect(mockOnOpenChange).toHaveBeenCalledWith(false);
  });
});
