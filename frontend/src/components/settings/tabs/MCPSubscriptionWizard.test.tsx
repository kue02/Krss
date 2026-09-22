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
  listMCPServers: vi.fn(),
  listMCPServerTools: vi.fn(),
  inspectMCPServer: vi.fn(),
  createMCPFeed: vi.fn(),
  updateMCPFeed: vi.fn(),
  suggestMCPMapping: vi.fn(),
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
  listMCPServers: mocks.listMCPServers,
  listMCPServerTools: mocks.listMCPServerTools,
  inspectMCPServer: mocks.inspectMCPServer,
  createMCPFeed: mocks.createMCPFeed,
  updateMCPFeed: mocks.updateMCPFeed,
  suggestMCPMapping: mocks.suggestMCPMapping,
}));

function server(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    id: "s1",
    name: "本机 Krss",
    transport: "auto",
    url: "http://127.0.0.1:8080/mcp",
    authType: "none",
    enabled: true,
    isConnected: true,
    toolCount: 3,
    resourceCount: 1,
    purposes: ["feed"],
    useGlobalFetch: true,
    oauthAuthorized: false,
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
    {
      title: "第一条",
      url: "https://example.com/1",
      key: "1",
      keyLevel: "key",
    },
    {
      title: "第二条",
      url: "https://example.com/2",
      key: "2",
      keyLevel: "key",
    },
  ],
};

function buttonFor(label: string): HTMLButtonElement {
  const candidates = screen.getAllByText(label);
  for (const el of candidates) {
    const button = el.closest("button");
    if (button) return button as HTMLButtonElement;
  }
  expect.unreachable(`找不到按钮：${label}`);
}

function renderWizard() {
  return render(
    <MCPSubscriptionWizard
      open
      onOpenChange={() => {}}
      servers={[server()]}
      presetServerId="s1"
    />,
  );
}

/** 走完第 1 屏（连接已由 presetServerId 选好，工具默认选第一个），停在第 2 屏 */
async function gotoScreen2() {
  fireEvent.click(buttonFor("ai_settings.mcp_next"));
  await waitFor(() =>
    expect(mocks.listMCPServerTools).toHaveBeenCalledWith("s1"),
  );
  fireEvent.click(buttonFor("ai_settings.mcp_next"));
  // 第 2 屏自动预填映射
  await waitFor(() =>
    expect(
      (
        screen.getByLabelText(
          "ai_settings.mcp_mapping_title",
        ) as HTMLInputElement
      ).value,
    ).toBe("name"),
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMCPServerTools.mockResolvedValue({
    tools: [{ name: "search_notes", title: "搜索笔记" }],
    resources: [{ uri: "notes://today", name: "今天的笔记" }],
  });
  mocks.inspectMCPServer.mockResolvedValue(SUGGESTION);
  mocks.createMCPFeed.mockResolvedValue({ id: "f1" });
});

describe("MCP 建源向导（3 屏）", () => {
  it("第 1 屏：连接与取数（工具下拉 + 参数编辑器 + 分页默认一页）", async () => {
    renderWizard();
    expect(await screen.findByText("ai_settings.mcp_screen_1")).toBeTruthy();
    // prompts 不列，只有提示
    expect(screen.getByText("ai_settings.mcp_prompts_note")).toBeTruthy();
    // 分页默认一页
    expect(screen.getByText("ai_settings.mcp_page_single")).toBeTruthy();
  });

  it("第 2 屏自动预填映射；没预览过下一步是灰的（门禁）", async () => {
    renderWizard();
    await gotoScreen2();

    expect(screen.getByText("ai_settings.mcp_screen_2")).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "ai_settings.mcp_mapping_title",
        ) as HTMLInputElement
      ).value,
    ).toBe("name");

    // 没预览过：第 2 屏的「下一步」必须禁用（门禁卡住，不是跳过去再灰创建）
    const next = buttonFor("ai_settings.mcp_next");
    expect(
      next.hasAttribute("disabled") || next.getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });

  it("预览成功且参数没变 → 第 3 屏可以创建；改了映射必须重新预览", async () => {
    mocks.inspectMCPServer.mockResolvedValue(PREVIEW);
    renderWizard();
    await gotoScreen2();

    fireEvent.click(buttonFor("ai_settings.mcp_preview"));
    await waitFor(() =>
      expect(screen.getByText("第一条")).toBeTruthy(),
    );
    // 去重键级别显示（映射区与预览表各一处）
    expect(
      screen.getAllByText(
        "ai_settings.mcp_key_level(level=ai_settings.mcp_key_level_key)",
      ).length,
    ).toBeGreaterThanOrEqual(2);

    fireEvent.click(buttonFor("ai_settings.mcp_next"));
    const create = buttonFor("ai_settings.mcp_create");
    expect(
      create.hasAttribute("disabled") || create.getAttribute("aria-disabled") === "true",
    ).toBe(false);

    // 回到第 2 屏改映射 → 下一步重新变灰（门禁：必须重新预览）
    fireEvent.click(buttonFor("ai_settings.mcp_prev"));
    const titleInput = screen.getByLabelText(
      "ai_settings.mcp_mapping_title",
    ) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "headline" } });
    const nextAgain = buttonFor("ai_settings.mcp_next");
    expect(
      nextAgain.hasAttribute("disabled") ||
        nextAgain.getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });

  it("创建时把分页配置带进 mcpConfig（追历史 + 双上限）", async () => {
    mocks.inspectMCPServer.mockResolvedValue(PREVIEW);
    renderWizard();

    // 第 1 屏：等工具清单回来再切追历史（分页控件在清单回来后才渲染）
    await waitFor(() =>
      expect(mocks.listMCPServerTools).toHaveBeenCalledWith("s1"),
    );
    fireEvent.click(screen.getByText("ai_settings.mcp_page_history"));
    await gotoScreen2AfterHistory();
    async function gotoScreen2AfterHistory() {
      fireEvent.click(buttonFor("ai_settings.mcp_next"));
      fireEvent.click(buttonFor("ai_settings.mcp_next"));
      await waitFor(() =>
        expect(
          (
            screen.getByLabelText(
              "ai_settings.mcp_mapping_title",
            ) as HTMLInputElement
          ).value,
        ).toBe("name"),
      );
    }

    fireEvent.click(buttonFor("ai_settings.mcp_preview"));
    await waitFor(() => expect(screen.getByText("第一条")).toBeTruthy());
    fireEvent.click(buttonFor("ai_settings.mcp_next"));
    fireEvent.click(buttonFor("ai_settings.mcp_create"));

    await waitFor(() => expect(mocks.createMCPFeed).toHaveBeenCalledTimes(1));
    const payload = mocks.createMCPFeed.mock.calls.at(0)?.[0] as {
      mcpConfig: { pagination?: { mode: string; maxPages: number; maxItems: number } };
    };
    expect(payload?.mcpConfig.pagination).toEqual({
      mode: "history",
      maxPages: 3,
      maxItems: 200,
    });
  });

  it("有 nextCursor 时出「拉更多」，点后追加下一页（不碰主门禁）", async () => {
    mocks.inspectMCPServer.mockResolvedValue({
      ...PREVIEW,
      nextCursor: "p2",
      cursorParam: "cursor",
    });
    renderWizard();
    await gotoScreen2();

    fireEvent.click(buttonFor("ai_settings.mcp_preview"));
    await waitFor(() => expect(screen.getByText("第一条")).toBeTruthy());
    expect(screen.getByText("ai_settings.mcp_load_more")).toBeTruthy();

    mocks.inspectMCPServer.mockResolvedValue({
      ...PREVIEW,
      preview: [
        { title: "第三条", url: "https://example.com/3", key: "3", keyLevel: "key" },
      ],
    });
    fireEvent.click(buttonFor("ai_settings.mcp_load_more"));
    await waitFor(() => expect(screen.getByText("第三条")).toBeTruthy());
    // 拉更多的请求把游标塞进了 arguments
    const lastCall = mocks.inspectMCPServer.mock.calls.at(-1) as [
      string,
      MCPInspectRequest,
    ];
    expect(lastCall[1].arguments).toMatchObject({ cursor: "p2" });
  });

  it("第 4 档黄条：AI 猜一次映射 → 用这个映射填入 → 仍须预览", async () => {
    mocks.inspectMCPServer.mockResolvedValue({
      ...SUGGESTION,
      tier: "text",
      mapping: {},
    });
    mocks.suggestMCPMapping.mockResolvedValue({
      mapping: { title: "sections.1", content: "sections" },
      model: "fake-model",
      estimatedTokens: 400,
      textUsed: 1200,
    });
    renderWizard();
    // 第 4 档没有可预填的映射：直接进第 2 屏（标题空着等 AI 或手填）
    fireEvent.click(buttonFor("ai_settings.mcp_next"));
    await waitFor(() =>
      expect(mocks.listMCPServerTools).toHaveBeenCalledWith("s1"),
    );
    fireEvent.click(buttonFor("ai_settings.mcp_next"));
    await waitFor(() =>
      expect(screen.getByText("ai_settings.mcp_screen_2")).toBeTruthy(),
    );

    // 黄条 + 猜按钮
    expect(screen.getByText("ai_settings.mcp_text_tier_hint")).toBeTruthy();
    fireEvent.click(buttonFor("ai_settings.mcp_ai_suggest"));
    await waitFor(() =>
      expect(mocks.suggestMCPMapping).toHaveBeenCalledTimes(1),
    );
    // 建议展示（模型 + token），点应用才填入
    expect(screen.getByText(/ai_settings\.mcp_ai_suggested/)).toBeTruthy();
    expect(
      (screen.getByLabelText("ai_settings.mcp_mapping_title") as HTMLInputElement)
        .value,
    ).toBe("");
    fireEvent.click(buttonFor("ai_settings.mcp_ai_apply"));
    expect(
      (screen.getByLabelText("ai_settings.mcp_mapping_title") as HTMLInputElement)
        .value,
    ).toBe("sections.1");
  });

  it("预览失败（preview 为 null）不白屏，走共用失败块", async () => {
    mocks.inspectMCPServer.mockResolvedValue({
      ...SUGGESTION,
      preview: null,
      total: 0,
      error: "HTTP 502",
      failure: {
        bucket: "upstream",
        code: "bad_gateway",
        title: "上游网关错误（502）",
        suggestion: "稍后重试",
        raw: "502",
      },
    });
    renderWizard();
    await gotoScreen2();

    fireEvent.click(buttonFor("ai_settings.mcp_preview"));
    // 失败块出来，页面没白（第 2 屏标题还在）
    expect(await screen.findByText("上游网关错误（502）")).toBeTruthy();
    expect(screen.getByText("ai_settings.mcp_screen_2")).toBeTruthy();
  });

  it("预览失败走共用失败块（人话标题），不是一句 error 原文", async () => {
    mocks.inspectMCPServer.mockResolvedValue({
      ...SUGGESTION,
      error: "HTTP 401",
      failure: {
        bucket: "auth",
        code: "unauthorized",
        title: "需要授权（401）",
        suggestion: "填 Header 或走 OAuth",
        raw: "401",
      },
    });
    renderWizard();
    await gotoScreen2();

    fireEvent.click(buttonFor("ai_settings.mcp_preview"));
    expect(await screen.findByText("需要授权（401）")).toBeTruthy();
  });
});

describe("MCP 订阅编辑（16-14：向导编辑模式）", () => {
  const EDIT_FEED = {
    id: "f9",
    folderId: "folder-1",
    title: "旧标题",
    url: "mcp://1/tool/search_notes",
    type: "article",
    sourceType: "mcp",
    mcpConfig: {
      serverId: "s1",
      kind: "tool",
      toolName: "search_notes",
      arguments: { q: "AI" },
      limit: 5,
      mapping: { listPath: "data.items", title: "headline", url: "link", id: "id" },
    },
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
  } as const;

  it("打开即按 feed.mcpConfig 回填：标题用编辑态标题，保存走更新接口", async () => {
    mocks.inspectMCPServer.mockResolvedValue(PREVIEW);
    mocks.updateMCPFeed.mockResolvedValue({ id: "f9" });

    render(
      <MCPSubscriptionWizard
        open
        onOpenChange={() => {}}
        servers={[server()]}
        editFeed={{ ...EDIT_FEED }}
      />,
    );

    // 标题是编辑态标题，不是新建
    expect(
      await screen.findByText("ai_settings.mcp_edit_subscription"),
    ).toBeTruthy();

    // 第 1 屏直接能下一步（连接+工具已回填）
    fireEvent.click(buttonFor("ai_settings.mcp_next"));
    await waitFor(() =>
      expect(mocks.listMCPServerTools).toHaveBeenCalledWith("s1"),
    );
    fireEvent.click(buttonFor("ai_settings.mcp_next"));

    // 第 2 屏映射已回填旧值（不是自动推断的新值 name）
    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "ai_settings.mcp_mapping_title",
          ) as HTMLInputElement
        ).value,
      ).toBe("headline"),
    );

    // 预览门禁照样卡：回填不算预览过，必须重新预览
    fireEvent.click(buttonFor("ai_settings.mcp_preview"));
    await waitFor(() => expect(screen.getByText("第一条")).toBeTruthy());

    fireEvent.click(buttonFor("ai_settings.mcp_next"));
    // 第 3 屏标题回填旧标题
    await waitFor(() =>
      expect(
        (screen.getByLabelText("ai_settings.mcp_feed_title") as HTMLInputElement)
          .value,
      ).toBe("旧标题"),
    );

    fireEvent.click(buttonFor("actions.save"));
    await waitFor(() =>
      expect(mocks.updateMCPFeed).toHaveBeenCalledTimes(1),
    );
    const [id, payload] = mocks.updateMCPFeed.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe("f9");
    expect(payload).toMatchObject({
      title: "旧标题",
      folderId: "folder-1",
      serverId: "s1",
      kind: "tool",
      toolName: "search_notes",
    });
    expect(mocks.createMCPFeed).not.toHaveBeenCalled();
  });
});
