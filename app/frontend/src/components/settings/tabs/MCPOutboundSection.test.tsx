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
    async (payload: { enabled: boolean; writeEnabled: boolean }) =>
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

  it("生成 token 后展示明文一次 + 醒目提示 + 复制按钮，并把状态更新成「已有 token」", async () => {
    mocks.createMCPOutboundToken.mockResolvedValue({
      ...status({
        tokenSet: true,
        tokenPrefix: "krss_mcp_ab12",
        tokenCreatedAt: "2026-09-18T10:00:00Z",
      }),
      token: "krss_mcp_plaintext_only_once",
    });

    render(<MCPOutboundSection />);
    await screen.findByText("data_control.mcp_token_generate");

    fireEvent.click(screen.getByText("data_control.mcp_token_generate"));

    expect(await screen.findByText("krss_mcp_plaintext_only_once")).toBeTruthy();
    expect(
      screen.getByText("data_control.mcp_token_once_warning"),
    ).toBeTruthy();
    // 明文 token 与「配置示例」各有一个复制按钮
    expect(screen.getAllByText("data_control.mcp_token_copy").length).toBeGreaterThanOrEqual(1);

    // 状态更新：前缀与生成时间出现、「还没生成」消失、重新生成/撤销入口出现
    expect(screen.getByText("krss_mcp_ab12")).toBeTruthy();
    expect(screen.getByText("2026-09-18T10:00:00Z")).toBeTruthy();
    expect(screen.queryByText("data_control.mcp_token_not_set")).toBeNull();
    expect(screen.getByText("data_control.mcp_token_regenerate")).toBeTruthy();
    expect(screen.getByText("data_control.mcp_token_revoke")).toBeTruthy();
  });

  it("开关即时落库：启用时把当前 writeEnabled 一起发出去", async () => {
    render(<MCPOutboundSection />);
    await screen.findByText("/mcp");

    fireEvent.click(screen.getByLabelText("data_control.mcp_enable"));

    await waitFor(() =>
      expect(mocks.updateMCPOutbound).toHaveBeenCalledWith({
        enabled: true,
        writeEnabled: false,
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

  it("客户端配置示例用占位符，绝不带真实 token", async () => {
    mocks.createMCPOutboundToken.mockResolvedValue({
      ...status({ tokenSet: true }),
      token: "krss_mcp_plaintext_only_once",
    });

    render(<MCPOutboundSection />);
    await screen.findByText("/mcp");

    expect(screen.getByText(/Bearer <token>/)).toBeTruthy();
    expect(screen.getByText(/mcpServers/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      "krss_mcp_plaintext_only_once",
    );
  });
});
