import { describe, it, expect } from "vitest";
import {
  applyPresetToDraft,
  buildInspectRequest,
  buildMCPClientConfigExample,
  buildMCPFeedConfig,
  buildMCPServerPayload,
  defaultMCPFeedTitle,
  emptyMCPServerDraft,
  emptyMappingDraft,
  feedSelectableServers,
  isMCPPreviewReady,
  MAPPING_FIELD_ORDER,
  mappingDraftFromMapping,
  mappingFromDraft,
  MCP_MASK,
  MCP_MIN_REFRESH_INTERVAL_MINUTES,
  MCP_SERVER_PRESETS,
  MCP_SUPPORTED_TRANSPORTS,
  mcpDraftFromServer,
  mcpInspectSignature,
  mcpKeyLevelLabelKey,
  mcpTierLabelKey,
  validateMCPServerDraft,
  type MCPServerDraft,
} from "./mcp";
import type { MCPEntryMapping, MCPServer } from "@/types/mcp";

function draft(overrides: Partial<MCPServerDraft> = {}): MCPServerDraft {
  return {
    ...emptyMCPServerDraft(),
    name: "本机 Krss",
    url: "http://127.0.0.1:8080/mcp",
    purposes: ["feed"],
    ...overrides,
  };
}

function server(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    id: "s1",
    name: "本机 Krss",
    transport: "streamable-http",
    url: "http://127.0.0.1:8080/mcp",
    authType: "none",
    enabled: true,
    isConnected: true,
    toolCount: 4,
    resourceCount: 2,
    purposes: ["feed"],
    useGlobalFetch: true,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

describe("MCP 连接表单校验（validateMCPServerDraft）", () => {
  it("名称与地址都对时不报错", () => {
    expect(validateMCPServerDraft(draft())).toEqual([]);
  });

  it("第一版拒绝 SSE 传输", () => {
    expect(MCP_SUPPORTED_TRANSPORTS).toEqual(["streamable-http"]);
    expect(validateMCPServerDraft(draft({ transport: "sse" }))).toContain(
      "transport_unsupported",
    );
  });

  it("地址必须以 http:// 或 https:// 开头", () => {
    expect(validateMCPServerDraft(draft({ url: "127.0.0.1:8080/mcp" }))).toContain(
      "url_invalid",
    );
    expect(
      validateMCPServerDraft(draft({ url: "ftp://example.com/mcp" })),
    ).toContain("url_invalid");
    expect(
      validateMCPServerDraft(draft({ url: "https://example.com/mcp" })),
    ).not.toContain("url_invalid");
  });

  it("至少要选一个用途（不然这份连接两边都用不上）", () => {
    expect(validateMCPServerDraft(draft({ purposes: [] }))).toContain(
      "purposes_required",
    );
  });

  it("Header 认证下键与值都要填", () => {
    const incomplete = draft({
      authType: "header",
      headers: [{ key: "Authorization", value: "" }],
    });
    expect(validateMCPServerDraft(incomplete)).toContain("headers_incomplete");

    const complete = draft({
      authType: "header",
      headers: [{ key: "Authorization", value: "Bearer x" }],
    });
    expect(validateMCPServerDraft(complete)).not.toContain(
      "headers_incomplete",
    );
  });

  it("单独配时刷新间隔下限 15 分钟（14 拒绝、15 通过）", () => {
    expect(MCP_MIN_REFRESH_INTERVAL_MINUTES).toBe(15);
    expect(
      validateMCPServerDraft(
        draft({ useGlobalFetch: false, refreshIntervalMinutes: 14 }),
      ),
    ).toContain("interval_too_small");
    expect(
      validateMCPServerDraft(
        draft({ useGlobalFetch: false, refreshIntervalMinutes: 15 }),
      ),
    ).not.toContain("interval_too_small");
  });

  it("单独配时超时/并发必须为正", () => {
    const errors = validateMCPServerDraft(
      draft({
        useGlobalFetch: false,
        fetchTimeoutSeconds: 0,
        fetchConcurrency: 0,
      }),
    );
    expect(errors).toContain("timeout_invalid");
    expect(errors).toContain("concurrency_invalid");
  });

  it("跟全局时不校验那三个数字字段（它们本来就不生效）", () => {
    expect(
      validateMCPServerDraft(
        draft({
          useGlobalFetch: true,
          refreshIntervalMinutes: 0,
          fetchTimeoutSeconds: 0,
          fetchConcurrency: 0,
        }),
      ),
    ).toEqual([]);
  });
});

describe("MCP 连接请求体（buildMCPServerPayload）", () => {
  it("跟全局时省掉三个数字字段（发了会被当成「单独配」）", () => {
    const payload = buildMCPServerPayload(draft());
    expect(payload.useGlobalFetch).toBe(true);
    expect("fetchTimeoutSeconds" in payload).toBe(false);
    expect("fetchConcurrency" in payload).toBe(false);
    expect("refreshIntervalMinutes" in payload).toBe(false);
  });

  it("单独配时带上三个数字字段", () => {
    const payload = buildMCPServerPayload(
      draft({
        useGlobalFetch: false,
        refreshIntervalMinutes: 30,
        fetchTimeoutSeconds: 20,
        fetchConcurrency: 3,
      }),
    );
    expect(payload.fetchTimeoutSeconds).toBe(20);
    expect(payload.fetchConcurrency).toBe(3);
    expect(payload.refreshIntervalMinutes).toBe(30);
  });

  it("编辑时掩码值原样回传（后端据此判断「这项没改」）", () => {
    const editing = mcpDraftFromServer(
      server({
        authType: "header",
        headers: { Authorization: MCP_MASK },
      }),
    );
    expect(editing.headers).toEqual([
      { key: "Authorization", value: MCP_MASK },
    ]);
    expect(buildMCPServerPayload(editing).headers).toEqual({
      Authorization: MCP_MASK,
    });
  });

  it("无认证时不把 header 草稿带出去", () => {
    const payload = buildMCPServerPayload(
      draft({
        authType: "none",
        headers: [{ key: "X-Token", value: "abc" }],
      }),
    );
    expect(payload.headers).toEqual({});
  });

  it("名称与地址去首尾空格", () => {
    const payload = buildMCPServerPayload(
      draft({ name: "  本机  ", url: "  http://127.0.0.1:8080/mcp  " }),
    );
    expect(payload.name).toBe("本机");
    expect(payload.url).toBe("http://127.0.0.1:8080/mcp");
  });
});

describe("预设卡片", () => {
  it("每张卡片的名称键与地址都可用、id 不重复", () => {
    const ids = new Set(MCP_SERVER_PRESETS.map((preset) => preset.id));
    expect(ids.size).toBe(MCP_SERVER_PRESETS.length);
    for (const preset of MCP_SERVER_PRESETS) {
      expect(preset.nameKey.startsWith("ai_settings.mcp_")).toBe(true);
      expect(preset.url).toMatch(/^https?:\/\//);
    }
  });

  it("点预设只填名称与地址，其余保持用户已选的东西", () => {
    const base = draft({ purposes: ["ai"], enabled: false, useGlobalFetch: false });
    const preset = MCP_SERVER_PRESETS[0]!;
    const next = applyPresetToDraft(base, preset, "本机 Krss");
    expect(next.name).toBe("本机 Krss");
    expect(next.url).toBe(preset.url);
    expect(next.transport).toBe("streamable-http");
    // 其余不动
    expect(next.purposes).toEqual(["ai"]);
    expect(next.enabled).toBe(false);
    expect(next.useGlobalFetch).toBe(false);
  });
});

describe("建源向导的可选连接（feedSelectableServers）", () => {
  it("只要「启用 + 用途含 feed 或没标用途」", () => {
    const list = feedSelectableServers([
      server({ id: "ok", purposes: ["feed"] }),
      server({ id: "both", purposes: ["ai", "feed"] }),
      server({ id: "unmarked", purposes: [] }),
      server({ id: "ai-only", purposes: ["ai"] }),
      server({ id: "disabled", purposes: ["feed"], enabled: false }),
    ]);
    expect(list.map((item) => item.id)).toEqual(["ok", "both", "unmarked"]);
  });
});

describe("预览门禁（isMCPPreviewReady / mcpInspectSignature）", () => {
  const ready = {
    tier: "structured" as const,
    mapping: { title: "name" },
    keyLevel: "link" as const,
    notes: [],
    preview: [
      { title: "第一条", key: "k1", keyLevel: "link" },
    ],
    total: 3,
  };

  it("没预览过不能创建", () => {
    expect(
      isMCPPreviewReady({
        result: null,
        previewSignature: null,
        currentSignature: "a",
      }),
    ).toBe(false);
  });

  it("预览带回 error 时不能创建（失败也是 200，必须判 error）", () => {
    expect(
      isMCPPreviewReady({
        result: { ...ready, error: "映射没命中任何条目" },
        previewSignature: "a",
        currentSignature: "a",
      }),
    ).toBe(false);
  });

  it("一条数据都没出来时不能创建", () => {
    expect(
      isMCPPreviewReady({
        result: { ...ready, preview: [], total: 0 },
        previewSignature: "a",
        currentSignature: "a",
      }),
    ).toBe(false);
  });

  it("预览成功且参数没变才能创建", () => {
    expect(
      isMCPPreviewReady({
        result: ready,
        previewSignature: "a",
        currentSignature: "a",
      }),
    ).toBe(true);
  });

  it("改了映射之后指纹变了 → 必须重新预览", () => {
    const base = buildInspectRequest({
      kind: "tool",
      toolName: "search_notes",
      limit: 5,
      mapping: { title: "name" },
    });
    const changed = buildInspectRequest({
      kind: "tool",
      toolName: "search_notes",
      limit: 5,
      mapping: { title: "headline" },
    });
    expect(mcpInspectSignature(base)).not.toBe(mcpInspectSignature(changed));

    // 用旧预览的指纹去配新参数 —— 门禁必须关着
    expect(
      isMCPPreviewReady({
        result: ready,
        previewSignature: mcpInspectSignature(base),
        currentSignature: mcpInspectSignature(changed),
      }),
    ).toBe(false);
  });

  it("参数顺序不同但内容一致时指纹相同（不会误判成改了）", () => {
    const a = buildInspectRequest({
      kind: "tool",
      toolName: "t",
      arguments: { q: "x", limit: 3 },
      limit: 5,
      mapping: { title: "name", url: "link" },
    });
    const b = buildInspectRequest({
      kind: "tool",
      toolName: "t",
      arguments: { q: "x", limit: 3 },
      limit: 5,
      mapping: { title: "name", url: "link" },
    });
    expect(mcpInspectSignature(a)).toBe(mcpInspectSignature(b));
  });
});

describe("映射草稿转换", () => {
  const mapping: MCPEntryMapping = {
    listPath: "data.items",
    title: "name",
    url: "link",
    id: "id",
  };

  it("后端映射 → 表单草稿（八个字段都落位）", () => {
    const draftMapping = mappingDraftFromMapping(mapping);
    expect(draftMapping.listPath).toBe("data.items");
    expect(draftMapping.title).toBe("name");
    expect(draftMapping.url).toBe("link");
    expect(draftMapping.author).toBe("");
    expect(Object.keys(draftMapping).sort()).toEqual(
      [...MAPPING_FIELD_ORDER].sort(),
    );
  });

  it("表单草稿 → 请求体（空字段直接丢掉，别送空路径）", () => {
    const draftMapping = emptyMappingDraft();
    draftMapping.listPath = " data.items ";
    draftMapping.title = "name";
    draftMapping.url = "   ";
    expect(mappingFromDraft(draftMapping)).toEqual({
      listPath: "data.items",
      title: "name",
    });
  });
});

describe("inspect 请求与建源配置", () => {
  it("选资源时不带工具名与条数", () => {
    const request = buildInspectRequest({
      kind: "resource",
      toolName: "should_be_ignored",
      resourceUri: "krss://unread",
      limit: 5,
    });
    expect(request).toEqual({ kind: "resource", resourceUri: "krss://unread" });
  });

  it("工具请求带上参数与条数", () => {
    const request = buildInspectRequest({
      kind: "tool",
      toolName: "search_notes",
      arguments: { q: "postgres" },
      limit: 5,
    });
    expect(request).toEqual({
      kind: "tool",
      toolName: "search_notes",
      arguments: { q: "postgres" },
      limit: 5,
    });
  });

  it("mcpConfig 按 kind 分流，并带上推断出的档位与去重键级别", () => {
    const config = buildMCPFeedConfig({
      serverId: "s1",
      kind: "tool",
      toolName: "search_notes",
      arguments: { q: "x" },
      limit: 5,
      mapping: { title: "name" },
      tier: "structured",
      keyLevel: "link",
    });
    expect(config).toEqual({
      serverId: "s1",
      kind: "tool",
      toolName: "search_notes",
      arguments: { q: "x" },
      limit: 5,
      mapping: { title: "name" },
      tier: "structured",
      keyLevel: "link",
    });

    const resourceConfig = buildMCPFeedConfig({
      serverId: "s1",
      kind: "resource",
      resourceUri: "krss://unread",
      mapping: { title: "name" },
    });
    expect(resourceConfig).toEqual({
      serverId: "s1",
      kind: "resource",
      resourceUri: "krss://unread",
      mapping: { title: "name" },
    });
  });

  it("默认订阅标题带上连接名与工具名", () => {
    expect(defaultMCPFeedTitle("本机 Krss", "tool", "search_notes")).toBe(
      "MCP · 本机 Krss / search_notes",
    );
    expect(defaultMCPFeedTitle("", "resource", "krss://unread")).toBe(
      "MCP · MCP / krss://unread",
    );
  });

  it("去重键与档位的文案键有兜底（后端加了新档也不会显示空白）", () => {
    expect(mcpKeyLevelLabelKey("key")).toBe("ai_settings.mcp_key_level_key");
    expect(mcpKeyLevelLabelKey("link")).toBe("ai_settings.mcp_key_level_link");
    expect(mcpKeyLevelLabelKey("title+time")).toBe(
      "ai_settings.mcp_key_level_title_time",
    );
    expect(mcpKeyLevelLabelKey("brand-new")).toBe(
      "ai_settings.mcp_key_level_unknown",
    );
    expect(mcpTierLabelKey("text")).toBe("ai_settings.mcp_tier_text");
    expect(mcpTierLabelKey("nope")).toBe("ai_settings.mcp_tier_unknown");
  });
});

describe("出向客户端配置示例", () => {
  it("带 origin 时用真地址，token 一律是占位符", () => {
    const text = buildMCPClientConfigExample("http://192.0.2.5:8080");
    const parsed = JSON.parse(text) as {
      mcpServers: { krss: { url: string; headers: { Authorization: string } } };
    };
    expect(parsed.mcpServers.krss.url).toBe("http://192.0.2.5:8080/mcp");
    expect(parsed.mcpServers.krss.headers.Authorization).toBe("Bearer <token>");
    expect(text).not.toMatch(/krss_mcp_/);
  });

  it("拿不到 origin 时退回 <host>:<port> 占位", () => {
    const text = buildMCPClientConfigExample("");
    expect(text).toContain("http://<host>:<port>/mcp");
    expect(text).toContain("<token>");
  });

  it("origin 末尾多余的斜杠不会拼出双斜杠", () => {
    const text = buildMCPClientConfigExample("http://localhost:8082///");
    expect(text).toContain("http://localhost:8082/mcp");
    expect(text).not.toContain("8082//mcp");
  });
});
