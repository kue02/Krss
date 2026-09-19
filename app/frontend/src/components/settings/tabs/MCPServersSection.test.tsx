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
  redetectMCPTransport: vi.fn(),
  listMCPServerTools: vi.fn(),
  inspectMCPServer: vi.fn(),
  createMCPFeed: vi.fn(),
  discoverMCPOAuth: vi.fn(),
  startMCPOAuth: vi.fn(),
  revokeMCPOAuth: vi.fn(),
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
  redetectMCPTransport: mocks.redetectMCPTransport,
  listMCPServerTools: mocks.listMCPServerTools,
  inspectMCPServer: mocks.inspectMCPServer,
  createMCPFeed: mocks.createMCPFeed,
  discoverMCPOAuth: mocks.discoverMCPOAuth,
  startMCPOAuth: mocks.startMCPOAuth,
  revokeMCPOAuth: mocks.revokeMCPOAuth,
}));

function server(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    id: "s1",
    name: "Fabric",
    transport: "auto",
    url: "https://mcp.fabric.so/mcp",
    authType: "none",
    enabled: true,
    isConnected: true,
    toolCount: 12,
    resourceCount: 3,
    purposes: ["feed"],
    useGlobalFetch: true,
    oauthAuthorized: false,
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

describe("MCP 服务段（16-6 硬布局）", () => {
  it("列表行：列头 + 图标/名称副行/状态/用途/操作；预设卡片整段没了", async () => {
    mocks.listMCPServers.mockResolvedValue([
      server({ id: "s1", name: "Fabric", purposes: ["feed"] }),
      server({
        id: "s2",
        name: "Notion",
        authType: "oauth",
        oauthAuthorized: false,
        isConnected: false,
        toolCount: 0,
        resourceCount: 0,
        purposes: ["ai"],
      }),
    ]);

    render(<MCPServersSection />);

    // 列头
    expect(await screen.findByText("ai_settings.mcp_col_name")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_col_status")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_col_purpose")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_col_actions")).toBeTruthy();
    // 行：名称 + 副行（主机 · 传输 · 能力计数）
    expect(screen.getByText("Fabric")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_status_connected")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_status_auth_needed")).toBeTruthy();
    // 用途是标记（两处都在）
    expect(screen.getByText("ai_settings.mcp_purpose_feed")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_purpose_ai")).toBeTruthy();
    // 预设卡片整段删掉：入口与文案都不该出现
    expect(screen.queryByText("ai_settings.mcp_presets")).toBeNull();
    expect(screen.queryByText("ai_settings.mcp_preset_fabric")).toBeNull();
    // 返工口径：「粘贴 JSON 新建」独立按钮没了，并入「新建连接」
    expect(screen.queryByText("ai_settings.mcp_paste_json")).toBeNull();
    expect(screen.getByText("ai_settings.mcp_add_connection")).toBeTruthy();
    // HeroUI Table：原生 table + 列头
    expect(
      document.querySelector("table") ?? screen.getByRole("table"),
    ).toBeTruthy();
    // 16-16 警戒区：八字水印在 DOM 里（纯背景，不挡操作）
    expect(document.body.textContent).toContain(
      "ai_settings.mcp_warn_watermark",
    );
  });

  it("粘贴 JSON → 识别结果卡 → 填入表单 → 保存（transport/headers/purposes 落位）", async () => {
    mocks.createMCPServer.mockResolvedValue(server({ id: "s3" }));

    render(<MCPServersSection />);
    await screen.findByText("ai_settings.mcp_empty");

    // 单页对话框：新建连接里自带粘贴 JSON 段（无 Tabs）
    fireEvent.click(screen.getByText("ai_settings.mcp_add_connection"));
    const editor = (await screen.findByLabelText(
      "ai_settings.mcp_paste_json_label",
    )) as HTMLTextAreaElement;
    expect(editor.tagName).toBe("TEXTAREA");
    fireEvent.change(
      editor,
      {
        target: {
          value: JSON.stringify({
            mcpServers: {
              "nas-mcp": {
                type: "sse",
                url: "http://192.0.2.1:8931/sse",
                headers: { Authorization: "Bearer sk-123" },
              },
            },
          }),
        },
      },
    );

    // 识别结果卡：名称/传输/地址/认证
    expect(await screen.findByText("ai_settings.mcp_recognized")).toBeTruthy();
    expect(screen.getByText("nas-mcp")).toBeTruthy();
    expect(screen.getByText("http://192.0.2.1:8931/sse")).toBeTruthy();

    // 填入表单 → 草稿落位（单页：失焦自动填，这里点按钮同样填）
    fireEvent.click(screen.getByText("ai_settings.mcp_fill_form"));
    const nameInput = (await screen.findByLabelText(
      "ai_settings.mcp_name",
    )) as HTMLInputElement;
    expect(nameInput.value).toBe("nas-mcp");

    fireEvent.click(screen.getByText("actions.save"));
    await waitFor(() => expect(mocks.createMCPServer).toHaveBeenCalledTimes(1));
    const payload = lastCallArg<Record<string, unknown>>(mocks.createMCPServer);
    expect(payload).toMatchObject({
      name: "nas-mcp",
      transport: "sse",
      url: "http://192.0.2.1:8931/sse",
      authType: "header",
      headers: { Authorization: "Bearer sk-123" },
      enabled: true,
      purposes: ["ai", "feed"],
      useGlobalFetch: true,
    });
    // 跟全局时不带那三个数字字段
    expect("fetchTimeoutSeconds" in payload).toBe(false);
  });

  it("失焦自动校验+格式化并反填（16-9 返工：不用点按钮）", async () => {
    render(<MCPServersSection />);
    await screen.findByText("ai_settings.mcp_empty");

    fireEvent.click(screen.getByText("ai_settings.mcp_add_connection"));
    const editor = (await screen.findByLabelText(
      "ai_settings.mcp_paste_json_label",
    )) as HTMLTextAreaElement;
    // 故意写成没格式化的单行
    fireEvent.change(editor, {
      target: {
        value:
          '{"mcpServers":{"nas-mcp":{"type":"sse","url":"http://192.0.2.1:8931/sse"}}}',
      },
    });
    fireEvent.blur(editor);

    // 失焦后：框内被格式化（换行了），上方名称框被反填
    await waitFor(() => expect(editor.value).toContain("\n"));
    const nameInput = (await screen.findByLabelText(
      "ai_settings.mcp_name",
    )) as HTMLInputElement;
    expect(nameInput.value).toBe("nas-mcp");
  });

  it("粘贴坏 JSON 给明确错误码，不发请求", async () => {
    render(<MCPServersSection />);
    await screen.findByText("ai_settings.mcp_empty");

    fireEvent.click(screen.getByText("ai_settings.mcp_add_connection"));
    const badEditor = (await screen.findByLabelText(
      "ai_settings.mcp_paste_json_label",
    )) as HTMLTextAreaElement;
    fireEvent.change(badEditor, { target: { value: "{oops" } });
    expect(
      await screen.findByText("ai_settings.mcp_parse_not_json"),
    ).toBeTruthy();
    expect(mocks.createMCPServer).not.toHaveBeenCalled();
  });

  it("名称为空 / 地址不合法时不发请求，并把校验提示显示出来", async () => {
    render(<MCPServersSection />);
    await screen.findByText("ai_settings.mcp_empty");

    fireEvent.click(screen.getByText("ai_settings.mcp_add_connection"));
    // 单页对话框：基础字段与粘贴 JSON 同页，直接保存看校验
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

    fireEvent.click(screen.getByLabelText("ai_settings.mcp_menu_edit"));
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

  it("测试失败走结构化失败块：人话标题 + 认证桶出口（去配 Header / 改用 OAuth）", async () => {
    mocks.listMCPServers.mockResolvedValue([server({ id: "s1" })]);
    mocks.testMCPServer.mockResolvedValue({
      connected: false,
      toolCount: 0,
      resourceCount: 0,
      error: "HTTP 401: unauthorized",
      failure: {
        bucket: "auth",
        code: "unauthorized",
        title: "需要授权（401）",
        suggestion: "这个服务要授权 —— 可以填 Header，或改用 OAuth 授权",
        raw: "401 Unauthorized",
      },
    });

    render(<MCPServersSection />);
    await screen.findByText("Fabric");

    fireEvent.click(screen.getByLabelText("ai_settings.mcp_test"));

    // 人话标题 + 建议 + 出口按钮（三处共用同一套）
    expect(await screen.findByText("需要授权（401）")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_exit_to_header")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_exit_to_oauth")).toBeTruthy();
    expect(mocks.testMCPServer).toHaveBeenCalledWith("s1");
  });

  it("库里的失败也走同一套组件（compact 可展开）", async () => {
    mocks.listMCPServers.mockResolvedValue([
      server({
        id: "s2",
        name: "老失败",
        isConnected: false,
        lastError: "连不上服务（连接被拒绝）",
        lastFailure: {
          bucket: "network",
          code: "refused",
          title: "连不上服务（连接被拒绝）",
          suggestion: "确认服务已启动",
          raw: "dial tcp: connect: connection refused",
        },
      }),
    ]);

    render(<MCPServersSection />);
    expect(await screen.findByText("连不上服务（连接被拒绝）")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_status_failed")).toBeTruthy();
  });

  it("「+ 新建 MCP 订阅」直接开建源向导（入口在 MCP 服务段里）", async () => {
    render(<MCPServersSection />);
    await screen.findByText("ai_settings.mcp_empty");

    fireEvent.click(screen.getByText("ai_settings.mcp_new_subscription"));

    // 向导第 1 屏：连接与取数（这一段没有连接，所以给的是空提示）
    expect(await screen.findByText("ai_settings.mcp_screen_1")).toBeTruthy();
    expect(
      screen.getByText("ai_settings.mcp_no_servers_for_feed"),
    ).toBeTruthy();
  });

  it("删除撞上「还有订阅在用」时，把后端 409 的原话显示出来", async () => {
    mocks.listMCPServers.mockResolvedValue([
      server({ id: "s1", name: "Fabric" }),
    ]);
    mocks.deleteMCPServer.mockRejectedValue(
      new ApiError("还有 2 条订阅在用这个连接，先删掉它们再删连接", 409),
    );

    render(<MCPServersSection />);
    await screen.findByText("Fabric");

    // 操作列的 ⋯ 菜单 → 删除
    fireEvent.click(screen.getByLabelText("ai_settings.mcp_col_actions"));
    fireEvent.click(await screen.findByText("ai_settings.mcp_menu_delete"));
    fireEvent.click(await screen.findByText("actions.delete"));

    expect(
      await screen.findByText("还有 2 条订阅在用这个连接，先删掉它们再删连接"),
    ).toBeTruthy();
    // 没删掉：列表还在
    expect(screen.getByText("Fabric")).toBeTruthy();
  });
});
