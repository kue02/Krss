import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MCPOutboundSection } from "./MCPOutboundSection";
import type { MCPOutboundStatus } from "@/types/mcp";

const mocks = vi.hoisted(() => ({
  getMCPOutbound: vi.fn(),
  updateMCPOutbound: vi.fn(),
  createMCPOutboundToken: vi.fn(),
  revokeMCPOutboundToken: vi.fn(),
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

vi.mock("@/api", () => ({
  getMCPOutbound: mocks.getMCPOutbound,
  updateMCPOutbound: mocks.updateMCPOutbound,
  createMCPOutboundToken: mocks.createMCPOutboundToken,
  revokeMCPOutboundToken: mocks.revokeMCPOutboundToken,
}));

function status(overrides: Partial<MCPOutboundStatus> = {}): MCPOutboundStatus {
  return {
    enabled: false,
    writeEnabled: false,
    tokenSet: false,
    endpoint: "/mcp",
    protocolVersion: "2025-06-18",
    toolCount: 4,
    resourceCount: 3,
    ...overrides,
  };
}

/** HeroUI 的 Switch（RAC）渲染成 `<input role="switch" type="checkbox">`，禁用就是原生 disabled */
function isSwitchDisabled(label: string): boolean {
  const el = screen.getByLabelText(label) as HTMLInputElement;
  return el.disabled === true || el.getAttribute("data-disabled") !== null;
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMCPOutbound.mockResolvedValue(status());
  mocks.updateMCPOutbound.mockImplementation(
    async (payload: { enabled: boolean; writeEnabled: boolean; baseUrl: string }) =>
      status(payload),
  );
});

describe("出向：Krss 作为 MCP 服务器（设置 → 数据控制）", () => {
  it("端点与协议版本只读展示，未生成 token 时给「生成长期 token」", async () => {
    render(<MCPOutboundSection />);

    expect(await screen.findByText("2025-06-18")).toBeTruthy();
    expect(screen.getByText("/mcp")).toBeTruthy();
    expect(
      screen.getByText("data_control.mcp_exposed_count(tools=4,resources=3)"),
    ).toBeTruthy();
    expect(screen.getByText("data_control.mcp_token_generate")).toBeTruthy();
    expect(screen.getByText("data_control.mcp_token_not_set")).toBeTruthy();
  });

  it("生成 Token 后明文常驻显示 + 可复制；时间本地化，不再显示 raw UTC", async () => {
    mocks.createMCPOutboundToken.mockResolvedValue({
      ...status({
        tokenSet: true,
        token: "krss_mcp_persistent_plaintext",
        tokenPrefix: "krss_mcp_ab12",
        tokenCreatedAt: "2026-09-18T10:00:00Z",
      }),
      token: "krss_mcp_persistent_plaintext",
    });

    render(<MCPOutboundSection />);
    await screen.findByText("data_control.mcp_token_generate");

    fireEvent.click(screen.getByText("data_control.mcp_token_generate"));

    // 明文常驻（不是一次性）：code 块 + 复制按钮，一次性警告没了
    expect(
      await screen.findByText("krss_mcp_persistent_plaintext"),
    ).toBeTruthy();
    expect(
      screen.queryByText("data_control.mcp_token_once_warning"),
    ).toBeNull();
    expect(
      screen.getAllByText("data_control.mcp_token_copy").length,
    ).toBeGreaterThanOrEqual(1);

    // 状态更新：前缀出现、raw UTC 不出现（本地化显示）、重新生成/撤销入口出现
    expect(screen.getByText("krss_mcp_ab12")).toBeTruthy();
    expect(screen.queryByText("2026-09-18T10:00:00Z")).toBeNull();
    expect(screen.queryByText("data_control.mcp_token_not_set")).toBeNull();
    expect(screen.getByText("data_control.mcp_token_regenerate")).toBeTruthy();
    expect(screen.getByText("data_control.mcp_token_revoke")).toBeTruthy();
  });

  it("存量哈希：明文不可回显，给重生成提示", async () => {
    mocks.getMCPOutbound.mockResolvedValue(
      status({
        tokenSet: true,
        tokenPrefix: "krss_mcp_ab12",
        tokenCreatedAt: "2026-09-18T10:00:00Z",
      }),
    );

    render(<MCPOutboundSection />);
    await screen.findByText("/mcp");

    expect(
      await screen.findByText("data_control.mcp_token_legacy_hint"),
    ).toBeTruthy();
    expect(screen.getByText("data_control.mcp_token_regenerate")).toBeTruthy();
  });

  it("开关即时落库：启用时把当前 writeEnabled 一起发出去", async () => {
    render(<MCPOutboundSection />);
    await screen.findByText("/mcp");

    fireEvent.click(screen.getByLabelText("data_control.mcp_enable"));

    await waitFor(() =>
      expect(mocks.updateMCPOutbound).toHaveBeenCalledWith({
        enabled: true,
        writeEnabled: false,
        baseUrl: "",
      }),
    );
  });

  it("未启用出向服务时「允许写操作」是禁用的（先启用再谈写）", async () => {
    render(<MCPOutboundSection />);
    await screen.findByText("/mcp");

    expect(isSwitchDisabled("data_control.mcp_allow_write")).toBe(true);

    fireEvent.click(screen.getByLabelText("data_control.mcp_enable"));
    await waitFor(() =>
      expect(isSwitchDisabled("data_control.mcp_allow_write")).toBe(false),
    );
  });

  it("客户端配置示例：没 Token 时占位符；有真 Token 直接填好（复制即用）", async () => {
    render(<MCPOutboundSection />);
    await screen.findByText("/mcp");

    // 还没 Token：示例里是占位符
    expect(screen.getByText(/Bearer <token>/)).toBeTruthy();
    expect(screen.getByText(/mcpServers/)).toBeTruthy();

    mocks.createMCPOutboundToken.mockResolvedValue({
      ...status({ tokenSet: true, token: "krss_mcp_real_token_in_example" }),
      token: "krss_mcp_real_token_in_example",
    });
    fireEvent.click(screen.getByText("data_control.mcp_token_generate"));

    // 有真 Token：示例里直接带真值，不用再手动换
    expect(
      await screen.findByText(/Bearer krss_mcp_real_token_in_example/),
    ).toBeTruthy();
    expect(screen.queryByText(/Bearer <token>/)).toBeNull();
  });

  it("对外访问地址：填了保存进库，示例用它拼地址", async () => {
    mocks.getMCPOutbound.mockResolvedValue(status());
    render(<MCPOutboundSection />);
    await screen.findByText("/mcp");

    const input = screen.getByLabelText(
      "data_control.mcp_base_url",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "http://192.0.2.1:8082/" },
    });
    fireEvent.click(screen.getByText("actions.save"));

    await waitFor(() =>
      expect(mocks.updateMCPOutbound).toHaveBeenCalledWith({
        enabled: false,
        writeEnabled: false,
        baseUrl: "http://192.0.2.1:8082/",
      }),
    );
  });

  it("对外访问地址：库里有值时示例优先用它，不用浏览器地址", async () => {
    mocks.getMCPOutbound.mockResolvedValue(
      status({ baseUrl: "http://192.0.2.1:8082" }),
    );
    render(<MCPOutboundSection />);
    await screen.findByText("/mcp");

    expect(document.body.textContent).toContain("http://192.0.2.1:8082/mcp");
    expect(document.body.textContent).not.toContain(
      `${window.location.host}/mcp`,
    );
  });
});
