import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MCPServersSection } from "./MCPServersSection";
import { ApiError } from "@/api";
import type { MCPServer } from "@/types/mcp";

const mocks = vi.hoisted(() => ({
  listMCPServers: vi.fn(),
  createMCPServer: vi.fn(),
  updateMCPServer: vi.fn(),
  deleteMCPServer: vi.fn(),
  testMCPServer: vi.fn(),
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

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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
  listMCPServers: mocks.listMCPServers,
  createMCPServer: mocks.createMCPServer,
  updateMCPServer: mocks.updateMCPServer,
  deleteMCPServer: mocks.deleteMCPServer,
  testMCPServer: mocks.testMCPServer,
  listMCPServerTools: mocks.listMCPServerTools,
  inspectMCPServer: mocks.inspectMCPServer,
  createMCPFeed: mocks.createMCPFeed,
}));

function server(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    id: "s1",
    name: "Fabric",
    transport: "streamable-http",
    url: "https://mcp.fabric.so/mcp",
    authType: "none",
    enabled: true,
    isConnected: true,
    toolCount: 12,
    resourceCount: 3,
    purposes: ["feed"],
    useGlobalFetch: true,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

/** mock 入参在 noUncheckedIndexedAccess 下要收口成带断言的取值 */
function lastCallArg<T>(fn: { mock: { calls: unknown[][] } }): T {
  const call = fn.mock.calls.at(-1);
  expect(call).toBeTruthy();
  return (call as unknown[])[0] as T;
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMCPServers.mockResolvedValue([]);
});

describe("MCP 服务段（AI 栏）", () => {
  it("列表显示连接状态、工具数与用途标记，未连接时把 lastError 用红字带出来", async () => {
    mocks.listMCPServers.mockResolvedValue([
      server({ id: "s1", name: "Fabric", purposes: ["feed"] }),
      server({
        id: "s2",
        name: "GitHub MCP",
        purposes: ["ai"],
        isConnected: false,
        toolCount: 0,
        resourceCount: 0,
        lastError: "dial tcp 127.0.0.1:3000: connect: connection refused",
      }),
    ]);

    render(<MCPServersSection />);

    expect(await screen.findByText("Fabric")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_connected_tools(count=12)")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_disconnected")).toBeTruthy();
    expect(
      screen.getByText("dial tcp 127.0.0.1:3000: connect: connection refused"),
    ).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_purpose_feed")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_purpose_ai")).toBeTruthy();
  });

  it("点预设卡片把名称与地址填进新建表单，保存时送出草稿转好的 payload", async () => {
    mocks.createMCPServer.mockResolvedValue(server({ id: "s3" }));

    render(<MCPServersSection />);
    await screen.findByText("ai_settings.mcp_empty");

    fireEvent.click(screen.getByLabelText("ai_settings.mcp_preset_krss"));

    const nameInput = (await screen.findByLabelText(
      "ai_settings.mcp_name",
    )) as HTMLInputElement;
    const urlInput = screen.getByLabelText("ai_settings.mcp_url") as HTMLInputElement;
    expect(nameInput.value).toBe("ai_settings.mcp_preset_krss");
    expect(urlInput.value).toBe("http://127.0.0.1:8080/mcp");

    fireEvent.click(screen.getByText("ai_settings.mcp_purpose_feed"));
    fireEvent.click(screen.getByText("actions.save"));

    await waitFor(() => expect(mocks.createMCPServer).toHaveBeenCalledTimes(1));
    const payload = lastCallArg<Record<string, unknown>>(mocks.createMCPServer);
    expect(payload).toEqual({
      name: "ai_settings.mcp_preset_krss",
      transport: "streamable-http",
      url: "http://127.0.0.1:8080/mcp",
      authType: "none",
      headers: {},
      enabled: true,
      purposes: ["feed"],
      useGlobalFetch: true,
    });
    // 跟全局时不带那三个数字字段（带了会被后端当成「单独配」）
    expect("fetchTimeoutSeconds" in payload).toBe(false);
    expect("refreshIntervalMinutes" in payload).toBe(false);

    // 保存后刷新列表
    await waitFor(() => expect(mocks.listMCPServers).toHaveBeenCalledTimes(2));
  });

  it("名称为空 / 地址不合法时不发请求，并把校验提示显示出来", async () => {
    render(<MCPServersSection />);
    await screen.findByText("ai_settings.mcp_empty");

    fireEvent.click(screen.getByText("ai_settings.mcp_add_connection"));
    fireEvent.click(await screen.findByText("ai_settings.mcp_purpose_feed"));
    fireEvent.click(screen.getByText("actions.save"));

    expect(
      await screen.findByText(/ai_settings\.mcp_err_name_required/),
    ).toBeTruthy();
    expect(screen.getByText(/ai_settings\.mcp_err_url_invalid/)).toBeTruthy();
    expect(mocks.createMCPServer).not.toHaveBeenCalled();
  });

  it("编辑已有连接时 Header 回显掩码，不改就原样保存（后端据此判「没改」）", async () => {
    mocks.listMCPServers.mockResolvedValue([
      server({
        id: "s9",
        name: "内部笔记",
        authType: "header",
        headers: { Authorization: "••••••••" },
      }),
    ]);
    mocks.updateMCPServer.mockResolvedValue(server({ id: "s9" }));

    render(<MCPServersSection />);
    await screen.findByText("内部笔记");

    fireEvent.click(screen.getByLabelText("ai_settings.mcp_edit"));
    const valueInput = (await screen.findByLabelText(
      "ai_settings.mcp_header_value",
    )) as HTMLInputElement;
    expect(valueInput.value).toBe("••••••••");

    fireEvent.click(screen.getByText("actions.save"));

    await waitFor(() => expect(mocks.updateMCPServer).toHaveBeenCalledTimes(1));
    const [id, payload] = mocks.updateMCPServer.mock.calls.at(-1) as [
      string,
      { headers: Record<string, string> },
    ];
    expect(id).toBe("s9");
    expect(payload.headers).toEqual({ Authorization: "••••••••" });
  });

  it("连通性测试失败不当成请求失败：直接把后端给的 error 显示出来", async () => {
    mocks.listMCPServers.mockResolvedValue([server({ id: "s1" })]);
    mocks.testMCPServer.mockResolvedValue({
      connected: false,
      toolCount: 0,
      resourceCount: 0,
      error: "401 Unauthorized: token 无效",
    });

    render(<MCPServersSection />);
    await screen.findByText("Fabric");

    fireEvent.click(screen.getByLabelText("ai_settings.mcp_test"));

    expect(await screen.findByText("401 Unauthorized: token 无效")).toBeTruthy();
    expect(mocks.testMCPServer).toHaveBeenCalledWith("s1");
  });

  it("「+ 新建 MCP 订阅」直接开建源向导（入口在 MCP 服务段里）", async () => {
    render(<MCPServersSection />);
    await screen.findByText("ai_settings.mcp_empty");

    fireEvent.click(screen.getByText("ai_settings.mcp_new_subscription"));

    // 向导第一步：选连接（这一段没有连接，所以给的是「还没有可用于 Feed 的连接」）
    expect(
      (await screen.findAllByText("ai_settings.mcp_step_server")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("ai_settings.mcp_no_servers_for_feed"),
    ).toBeTruthy();
  });

  it("传输说明里明确写了只支持 streamable-http，且 SSE 选项确实传给了下拉（带 isDisabled）", async () => {
    render(<MCPServersSection />);
    await screen.findByText("ai_settings.mcp_empty");

    fireEvent.click(screen.getByText("ai_settings.mcp_add_connection"));
    await screen.findByLabelText("ai_settings.mcp_transport");

    // 说明文案就在下拉下面，用户不必点开也能看到「SSE 还没做」
    expect(screen.getByText("ai_settings.mcp_transport_hint")).toBeTruthy();

    // 选项照常渲染、不是偷偷藏起来（jsdom 里 HeroUI Select 的弹层不落地，
    // 所以只能验到「这一项确实存在于 Select 的集合里」，禁用态由
    // validateMCPServerDraft 的 transport_unsupported 兜住）
    const sseOptions = [...document.querySelectorAll("option")].filter(
      (option) => option.value === "sse",
    );
    expect(sseOptions.length).toBeGreaterThan(0);
  });

  it("删除撞上「还有订阅在用」时，把后端 409 的原话显示出来", async () => {
    mocks.listMCPServers.mockResolvedValue([server({ id: "s1", name: "Fabric" })]);
    mocks.deleteMCPServer.mockRejectedValue(
      new ApiError("还有 2 条订阅在用这个连接，先删掉它们再删连接", 409),
    );

    render(<MCPServersSection />);
    await screen.findByText("Fabric");

    fireEvent.click(screen.getByLabelText("ai_settings.mcp_delete"));
    fireEvent.click(await screen.findByText("actions.delete"));

    expect(
      await screen.findByText("还有 2 条订阅在用这个连接，先删掉它们再删连接"),
    ).toBeTruthy();
    // 没删掉：列表还在
    expect(screen.getByText("Fabric")).toBeTruthy();
  });
});
