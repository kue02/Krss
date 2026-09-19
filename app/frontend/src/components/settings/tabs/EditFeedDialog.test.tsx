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
});
