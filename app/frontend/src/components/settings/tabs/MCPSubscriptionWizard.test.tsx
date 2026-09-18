import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MCPSubscriptionWizard } from "./MCPSubscriptionWizard";
import type {
  MCPInspectRequest,
  MCPInspectResult,
  MCPServer,
} from "@/types/mcp";

const mocks = vi.hoisted(() => ({
  listMCPServerTools: vi.fn(),
  inspectMCPServer: vi.fn(),
  createMCPFeed: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      const extra = Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",");
      return `${key}(${extra})`;
    },
  }),
}));

vi.mock("@/hooks/useFolders", () => ({ useFolders: () => ({ data: [] }) }));

vi.mock("@/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.status = status;
    }
  },
  listMCPServerTools: mocks.listMCPServerTools,
  inspectMCPServer: mocks.inspectMCPServer,
  createMCPFeed: mocks.createMCPFeed,
}));

function server(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    id: "s1",
    name: "本机 Krss",
    transport: "streamable-http",
    url: "http://127.0.0.1:8080/mcp",
    authType: "none",
    enabled: true,
    isConnected: true,
    toolCount: 3,
    resourceCount: 1,
    purposes: ["feed"],
    useGlobalFetch: true,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

const SUGGESTION: MCPInspectResult = {
  tier: "structured",
  mapping: { listPath: "data.items", title: "name", url: "link", id: "id" },
  keyLevel: "key",
  notes: ["按常见字段名自动预填"],
  preview: [],
  total: 3,
};

const PREVIEW: MCPInspectResult = {
  ...SUGGESTION,
  preview: [
    { title: "第一条", url: "https://example.com/1", key: "1", keyLevel: "key" },
    { title: "第二条", url: "https://example.com/2", key: "2", keyLevel: "key" },
  ],
};

function buttonFor(label: string): HTMLButtonElement {
  const el = screen.getByText(label).closest("button");
  expect(el).toBeTruthy();
  return el as HTMLButtonElement;
}

/** 走完选连接 → 选工具 → 映射，停在「预览」这一步（设计前提：前三步不涉及预览门禁） */
async function gotoPreviewStep() {
  // ① 连接已由 presetServerId 选好
  fireEvent.click(buttonFor("ai_settings.mcp_next"));
  // ② 工具清单回来并默认选上第一个
  await waitFor(() =>
    expect(mocks.listMCPServerTools).toHaveBeenCalledWith("s1"),
  );
  fireEvent.click(buttonFor("ai_settings.mcp_next"));
  // ③ 映射被自动预填
  await waitFor(() =>
    expect(
      (screen.getByLabelText("ai_settings.mcp_mapping_title") as HTMLInputElement)
        .value,
    ).toBe("name"),
  );
  fireEvent.click(buttonFor("ai_settings.mcp_next"));
}

const previewCalls = () =>
  (mocks.inspectMCPServer.mock.calls as [string, MCPInspectRequest][]).filter(
    ([, payload]) => payload.mapping !== undefined,
  );

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMCPServerTools.mockResolvedValue({
    tools: [{ name: "search_notes", title: "搜索笔记" }],
    resources: [{ uri: "krss://unread", name: "未读" }],
  });
  mocks.inspectMCPServer.mockImplementation(
    async (_id: string, payload: MCPInspectRequest) =>
      payload.mapping ? PREVIEW : SUGGESTION,
  );
  mocks.createMCPFeed.mockResolvedValue({ id: "f1" });
});

describe("MCP 建源向导（强制预览前 5 条）", () => {
  it("没成功预览过就不能创建：预览那一步的「下一步」是禁用的，页面上也没有创建按钮", async () => {
    render(
      <MCPSubscriptionWizard
        open
        onOpenChange={vi.fn()}
        servers={[server()]}
        presetServerId="s1"
      />,
    );

    await gotoPreviewStep();

    expect(screen.queryByText("ai_settings.mcp_create")).toBeNull();
    expect(buttonFor("ai_settings.mcp_next").disabled).toBe(true);
    expect(buttonFor("ai_settings.mcp_preview").disabled).toBe(false);
    // 并且明确告诉用户为什么
    expect(screen.getByText("ai_settings.mcp_preview_required")).toBeTruthy();
    expect(mocks.createMCPFeed).not.toHaveBeenCalled();
  });

  it("预览出了数据之后才能走到最后一步并创建（带映射与推断出的去重键级别）", async () => {
    render(
      <MCPSubscriptionWizard
        open
        onOpenChange={vi.fn()}
        servers={[server()]}
        presetServerId="s1"
      />,
    );

    await gotoPreviewStep();
    fireEvent.click(buttonFor("ai_settings.mcp_preview"));

    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    expect(await screen.findByText("第一条")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_preview_total(count=3)")).toBeTruthy();

    await waitFor(() =>
      expect(buttonFor("ai_settings.mcp_next").disabled).toBe(false),
    );
    fireEvent.click(buttonFor("ai_settings.mcp_next"));

    const create = buttonFor("ai_settings.mcp_create");
    expect(create.disabled).toBe(false);
    // 预览里带的映射/去重键级别原样进 mcpConfig
    expect(previewCalls()[0]![1].mapping).toEqual({
      listPath: "data.items",
      title: "name",
      url: "link",
      id: "id",
    });

    fireEvent.click(create);

    await waitFor(() => expect(mocks.createMCPFeed).toHaveBeenCalledTimes(1));
    const payload = mocks.createMCPFeed.mock.calls.at(-1)![0] as {
      title: string;
      mcpConfig: Record<string, unknown>;
    };
    expect(payload.title).toBe("MCP · 本机 Krss / search_notes");
    expect(payload.mcpConfig).toEqual({
      serverId: "s1",
      kind: "tool",
      toolName: "search_notes",
      limit: 5,
      mapping: {
        listPath: "data.items",
        title: "name",
        url: "link",
        id: "id",
      },
      tier: "structured",
      keyLevel: "key",
    });
  });

  it("预览失败（error 非空）时原样显示原因，门禁仍然关着", async () => {
    mocks.inspectMCPServer.mockImplementation(
      async (_id: string, payload: MCPInspectRequest) =>
        payload.mapping
          ? {
              ...SUGGESTION,
              preview: [],
              total: 0,
              error: "映射没命中任何条目：data.items 是空的",
            }
          : SUGGESTION,
    );

    render(
      <MCPSubscriptionWizard
        open
        onOpenChange={vi.fn()}
        servers={[server()]}
        presetServerId="s1"
      />,
    );

    await gotoPreviewStep();
    fireEvent.click(buttonFor("ai_settings.mcp_preview"));

    expect(
      await screen.findByText("映射没命中任何条目：data.items 是空的"),
    ).toBeTruthy();
    expect(buttonFor("ai_settings.mcp_next").disabled).toBe(true);
    expect(screen.getByText("ai_settings.mcp_preview_required")).toBeTruthy();
  });

  it("预览之后改了映射 → 门禁重新关上，再次预览会带上改过的新映射", async () => {
    render(
      <MCPSubscriptionWizard
        open
        onOpenChange={vi.fn()}
        servers={[server()]}
        presetServerId="s1"
      />,
    );

    await gotoPreviewStep();
    fireEvent.click(buttonFor("ai_settings.mcp_preview"));
    await waitFor(() =>
      expect(buttonFor("ai_settings.mcp_next").disabled).toBe(false),
    );

    // 回到映射那一步改标题字段
    fireEvent.click(buttonFor("ai_settings.mcp_prev"));
    const titleField = screen.getByLabelText(
      "ai_settings.mcp_mapping_title",
    ) as HTMLInputElement;
    fireEvent.change(titleField, { target: { value: "headline" } });
    fireEvent.click(buttonFor("ai_settings.mcp_next"));

    // 指纹变了：先前的预览不再算数
    expect(buttonFor("ai_settings.mcp_next").disabled).toBe(true);
    expect(screen.getByText("ai_settings.mcp_preview_required")).toBeTruthy();

    fireEvent.click(buttonFor("ai_settings.mcp_preview"));
    await waitFor(() => expect(previewCalls()).toHaveLength(2));
    expect(previewCalls()[1]![1].mapping).toEqual({
      listPath: "data.items",
      title: "headline",
      url: "link",
      id: "id",
    });

    await waitFor(() =>
      expect(buttonFor("ai_settings.mcp_next").disabled).toBe(false),
    );
  });

  it("选资源时请求里不带工具名与条数（两者是两条互斥的路）", async () => {
    render(
      <MCPSubscriptionWizard
        open
        onOpenChange={vi.fn()}
        servers={[server()]}
        presetServerId="s1"
      />,
    );

    fireEvent.click(buttonFor("ai_settings.mcp_next"));
    await waitFor(() =>
      expect(mocks.listMCPServerTools).toHaveBeenCalledWith("s1"),
    );

    // 切到「资源」
    fireEvent.click(screen.getByText("ai_settings.mcp_kind_resource"));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("ai_settings.mcp_resource") as HTMLElement)
          .textContent,
      ).toContain("未读"),
    );

    fireEvent.click(buttonFor("ai_settings.mcp_next"));
    await waitFor(() => expect(mocks.inspectMCPServer).toHaveBeenCalled());
    const [, payload] = mocks.inspectMCPServer.mock.calls.at(-1) as [
      string,
      MCPInspectRequest,
    ];
    expect(payload.kind).toBe("resource");
    expect(payload.resourceUri).toBe("krss://unread");
    expect(payload.toolName).toBeUndefined();
    expect(payload.limit).toBeUndefined();
  });
});
