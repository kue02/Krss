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

  it("E：移动端段头堆叠 + 整表 544px 横滑（只动结构，样式原样）", async () => {
    // 草图 mcp-mobile-v1 v1：段头 max-sm:flex-col 上下堆叠；
    // 整表定宽 544px 装进 overflow-x-auto（桌面 sm:w-full 一行不动）；
    // 16-22 收口成果不动：variant=secondary + .mcp-table-root 定制块仍提供框/veil。
    mocks.listMCPServers.mockResolvedValue([server({ id: "s1" })]);
    const { container } = render(<MCPServersSection />);
    await screen.findByText("Fabric");
    expect(container.querySelector(".max-sm\\:flex-col")).toBeTruthy();
    const scroller = container.querySelector(".overflow-x-auto");
    expect(scroller).toBeTruthy();
    // w-[544px] 长在 Table.Root 的 div（data-slot=table）上，不是 table 元素本身
    const root = scroller?.querySelector('[data-slot="table"]');
    expect(root?.className).toContain("w-[544px]");
    expect(root?.className).toContain("sm:w-full");
    expect(root?.className).toContain("mcp-table-root");
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

  it("16-23：表格逐项抄 :5200（Chip 锚点类、图标按钮 28、用途列零内边距、失败卡无缩进）", async () => {
    mocks.listMCPServers.mockResolvedValue([
      server({ id: "s1", purposes: ["ai", "feed"] }),
    ]);
    render(<MCPServersSection />);
    await screen.findByText("Fabric");

    // Chip：状态 + 用途都走锚点类，外观值不进 TSX（未分层 HeroUI 恒胜，写了白给）
    const chips = document.querySelectorAll(".mcp-table-root .mcp-chip");
    expect(chips.length).toBe(3); // 状态 1 + 用途 2
    expect(chips[0]!.className).toContain("mcp-chip--ok");
    expect(chips[1]!.className).toContain("mcp-chip"); // 用途：中性底
    chips.forEach((chip) => {
      expect(chip.className).not.toContain("bg-");
      expect(chip.className).not.toContain("text-");
    });

    // 图标按钮 3 颗（测试 / 编辑 / 更多），同样只有锚点类
    const iconBtns = document.querySelectorAll(".mcp-table-root .mcp-icon-btn");
    expect(iconBtns.length).toBe(3);

    // 用途列零内边距锚点：92px 全给内容，两枚 chip 并排不换行
    expect(document.querySelector(".mcp-col-purpose")).toBeTruthy();

    // 名称 13px/500、副行 11px 且不再是等宽字体
    const name = screen.getByText("Fabric");
    expect(name.className).toContain("text-[13px]");
    expect(name.className).toContain("font-medium");
    const sub = name.nextElementSibling as HTMLElement | null;
    expect(sub?.className).toContain("mt-0.5");
    expect(sub?.className).toContain("text-[11px]");
    expect(sub?.className ?? "").not.toContain("font-mono");
  });

  it("16-23：失败卡走 row 形态（red-50 底 / red-200 框 / 无 34px 缩进）", async () => {
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
    await screen.findByText("连不上服务（连接被拒绝）");

    // 失败行是表里的通栏单元格，锚点类给内边距（对齐 :5200 的 12px，不是旧的 34px 缩进）
    const cell = document.querySelector(".mcp-row-detail");
    expect(cell).toBeTruthy();
    expect(cell!.className).toContain("table__cell");
    expect(document.querySelector(".pl-\\[34px\\]")).toBeNull();

    // 卡片颜色照 :5200（red 色板，而不是 destructive token）
    const card = cell!.firstElementChild as HTMLElement;
    expect(card.className).toContain("bg-red-50");
    expect(card.className).toContain("border-red-200");
  });

  it("16-17/16-18/16-19：警戒底走 CSS 类＋段头 h30＋表格 frameless", async () => {
    mocks.listMCPServers.mockResolvedValue([server({ id: "s1" })]);
    render(<MCPServersSection />);
    await screen.findByText("Fabric");

    // 16-17：斜纹底走 .mcp-warn-zone（纯 CSS），不再用会被编成非法
    // 背景色的 gradient 任意值写法（注意：注释里别出现方括号包裹的类名字样，
    // Tailwind 内容扫描会把它当类名编一条永远用不上的死规则进 dist）
    const warnZone = document.querySelector(".mcp-warn-zone");
    expect(warnZone).toBeTruthy();
    expect(warnZone!.className).not.toContain("repeating-linear-gradient");

    // 16-18：段头两按钮 h30（草图 .btn），标题与按钮同行顶部对齐由布局类保证
    const addBtn = screen.getByText("ai_settings.mcp_add_connection");
    const subBtn = screen.getByText("ai_settings.mcp_new_subscription");
    expect(addBtn.className).toContain("h-[30px]");
    expect(subBtn.className).toContain("h-[30px]");

    // 16-19 最终态（按 HeroUI 文档 BEM 口径）：TSX 只留 secondary 原生逻辑 +
    // mcp-table-root 定制类；框/罩/去线全在 index.css 定制块里，不在工具类里
    const tableRoot = document.querySelector(".table-root");
    expect(tableRoot?.className).toContain("table-root--secondary");
    expect(tableRoot?.className).not.toContain("table-root--primary");
    expect(tableRoot?.className).toContain("mcp-table-root");
    expect(tableRoot?.className).toContain("mt-3");
    // 外观类不许回 TSX（未分层恒胜，写了白给）：root 上除了布局类只有一个定制类
    expect(tableRoot?.className ?? "").not.toContain("rounded");
    expect(tableRoot?.className ?? "").not.toContain("border");
    // thead 不叠任何底色类；table 同时挂 mcp-table + table__content（定制块的选择器锚点）
    expect(document.querySelector("thead")?.className ?? "").not.toContain(
      "bg-",
    );
    const table = document.querySelector("table");
    expect(table?.className).toContain("mcp-table");
    expect(table?.className).toContain("table__content");
  });
});
