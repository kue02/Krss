import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ProxyOverrideManager } from "./ProxyOverrideManager";
import { ProxyEffectiveLine } from "./ProxyEffectiveLine";
import type { ProxySourceOverview } from "@/types/api";

const {
  mockFeedProxy,
  mockFolderProxy,
  mockTestNetworkProxy,
  mockSources,
  mockSourcesError,
} = vi.hoisted(() => ({
  mockFeedProxy: vi.fn(),
  mockFolderProxy: vi.fn(),
  mockTestNetworkProxy: vi.fn(),
  mockSources: vi.fn(),
  mockSourcesError: { value: false },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params && typeof params.name !== "undefined"
        ? `${key}:${params.name}`
        : params && typeof params.count !== "undefined"
          ? `${key}:${params.count}`
          : key,
  }),
}));

vi.mock("@/hooks/useProxySources", () => ({
  useProxySources: () => mockSources(),
  useUpdateFeedProxy: () => ({ mutateAsync: mockFeedProxy, isPending: false }),
  useUpdateFolderProxy: () => ({
    mutateAsync: mockFolderProxy,
    isPending: false,
  }),
}));

vi.mock("@/api", () => ({
  testNetworkProxy: (payload: unknown) => mockTestNetworkProxy(payload),
}));

// HeroUI Modal 走 portal，jsdom 里断言不了里面的内容 —— 与 EditFeedDialog.test 同款做法，换成普通 div。
// 注意 Modal 是「带子组件的函数」（Modal.Backdrop 等），所以这里也用 Object.assign 挂上去。
// vi.mock 的工厂会被提升到文件顶部 → 这里只能内联写，不能引用外部变量。
vi.mock("@heroui/react", () => ({
  Button: ({
    children,
    onPress,
    ...rest
  }: {
    children: ReactNode;
    onPress?: () => void;
  }) => (
    <button type="button" onClick={onPress} {...rest}>
      {children}
    </button>
  ),
  Modal: Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Backdrop: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Container: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Header: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Heading: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Body: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      CloseTrigger: () => null,
    },
  ),
}));

function buildOverview(): ProxySourceOverview {
  return {
    global: {
      enabled: true,
      type: "http",
      host: "127.0.0.1",
      port: 7890,
      username: "",
      password: "***",
    },
    folders: [
      {
        id: "f1",
        name: "技术",
        type: "article",
        feedCount: 1,
        override: { mode: "proxy" },
        effective: { mode: "proxy", source: "folder", sourceName: "技术" },
      },
    ],
    feeds: [
      {
        id: "s1",
        folderId: "f1",
        title: "GitHub Trending",
        type: "article",
        override: { mode: "inherit" },
        effective: { mode: "proxy", source: "folder", sourceName: "技术" },
      },
      {
        id: "s2",
        title: "少数派",
        type: "article",
        override: { mode: "direct" },
        effective: { mode: "direct", source: "feed", sourceName: "少数派" },
      },
    ],
    counts: { folders: 1, feeds: 1, proxiedFeeds: 1, globalEnabled: true },
  };
}

describe("ProxyEffectiveLine", () => {
  it("把生效结果与来源写清楚（验收口径那句）", () => {
    render(
      <ProxyEffectiveLine
        effective={{ mode: "proxy", source: "folder", sourceName: "技术" }}
      />,
    );
    expect(
      screen.getByText("proxy.result_proxy · proxy.from_folder:技术"),
    ).not.toBeNull();
  });

  it("选了走代理却没有可用地址时，写明实际直连", () => {
    render(
      <ProxyEffectiveLine
        effective={{ mode: "direct", source: "feed", missing: true }}
      />,
    );
    expect(
      screen.getByText("proxy.result_direct · proxy.from_feed"),
    ).not.toBeNull();
    expect(screen.getByText(/proxy.missing_config/)).not.toBeNull();
  });
});

describe("ProxyOverrideManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSourcesError.value = false;
    mockSources.mockReturnValue({ data: buildOverview(), isLoading: false });
    mockFeedProxy.mockResolvedValue({ feed: { id: "s1" }, effective: {} });
    mockFolderProxy.mockResolvedValue({ folder: { id: "f1" }, effective: {} });
    mockTestNetworkProxy.mockResolvedValue({ success: true, message: "ok" });
  });

  it("每个来源一行，行上直接显示生效结果", () => {
    render(<ProxyOverrideManager open onOpenChange={() => {}} />);

    // 文件夹行 + 两个订阅行
    expect(screen.getAllByText("proxy.folder_feed_count:1").length).toBe(1);
    expect(screen.getByText("GitHub Trending")).not.toBeNull();
    expect(screen.getByText("少数派")).not.toBeNull();

    // 行上的生效结果（文件夹行 + 继承文件夹的订阅行）
    expect(
      screen.getAllByText("proxy.result_proxy · proxy.from_folder:技术").length,
    ).toBe(2);
    // 自己选了直连的订阅行
    expect(
      screen.getByText("proxy.result_direct · proxy.from_feed"),
    ).not.toBeNull();
  });

  it("三态点一下就落库（文件夹走 PATCH /folders、订阅走 PATCH /feeds）", async () => {
    render(<ProxyOverrideManager open onOpenChange={() => {}} />);

    // 第二行的「走代理」= 订阅「少数派」（当前 direct）
    const proxyButtons = screen.getAllByRole("button", {
      name: "proxy.use_proxy",
    });
    const feedProxyButton = proxyButtons.at(-1);
    expect(feedProxyButton).toBeDefined();
    fireEvent.click(feedProxyButton as HTMLElement);

    await waitFor(() => {
      expect(mockFeedProxy).toHaveBeenCalledWith({
        id: "s2",
        override: { mode: "proxy" },
      });
    });

    // 第一行的「直连」= 文件夹「技术」
    const directButtons = screen.getAllByRole("button", {
      name: "proxy.direct",
    });
    const folderDirectButton = directButtons[0];
    expect(folderDirectButton).toBeDefined();
    fireEvent.click(folderDirectButton as HTMLElement);

    await waitFor(() => {
      expect(mockFolderProxy).toHaveBeenCalledWith({
        id: "f1",
        override: { mode: "direct" },
      });
    });
  });

  it("展开后可以按来源试连通性（带上 feedId / folderId）", async () => {
    render(<ProxyOverrideManager open onOpenChange={() => {}} />);

    // 展开「少数派」那一行的代理设置图标（第三行 = 第二个订阅）
    const gearButtons = screen.getAllByRole("button", {
      name: /proxy.feed_settings_aria/,
    });
    const feedSettingsButton = gearButtons.at(-1);
    expect(feedSettingsButton).toBeDefined();
    fireEvent.click(feedSettingsButton as HTMLElement);

    fireEvent.click(screen.getByRole("button", { name: "proxy.test_this" }));

    await waitFor(() => {
      expect(mockTestNetworkProxy).toHaveBeenCalledWith(
        expect.objectContaining({ feedId: "s2" }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ok")).not.toBeNull();
    });
  });

  it("文件夹可以收起（订阅行隐藏）再展开（订阅行回来）", () => {
    render(<ProxyOverrideManager open onOpenChange={() => {}} />);

    // 默认全展开：文件夹「技术」下面挂着 GitHub Trending
    expect(screen.getByText("GitHub Trending")).not.toBeNull();

    const toggle = screen.getByRole("button", {
      name: "proxy.folder_collapse:技术",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);

    // 收起后：订阅行没了，文件夹行还在（并且交代收起了几条）
    expect(screen.queryByText("GitHub Trending")).toBeNull();
    expect(screen.getByText("技术")).not.toBeNull();
    expect(screen.getByText(/proxy.collapsed_count:1/)).not.toBeNull();

    const expand = screen.getByRole("button", {
      name: "proxy.folder_expand:技术",
    });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);
    expect(screen.getByText("GitHub Trending")).not.toBeNull();
  });
});
