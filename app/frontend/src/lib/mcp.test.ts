import { describe, it, expect } from "vitest";
import {
  buildInspectRequest,
  buildMCPClientConfigExample,
  buildMCPFeedConfig,
  buildMCPServerPayload,
  buildOAuthCallbackURL,
  defaultMCPFeedTitle,
  detectTransport,
  emptyMCPServerDraft,
  emptyMappingDraft,
  feedSelectableServers,
  formatMCPJSON,
  isMCPPreviewReady,
  MAPPING_FIELD_ORDER,
  mappingDraftFromMapping,
  mappingFromDraft,
  MCP_DEFAULT_MAX_ITEMS,
  MCP_DEFAULT_MAX_PAGES,
  MCP_MASK,
  MCP_MIN_REFRESH_INTERVAL_MINUTES,
  mcpDraftFromServer,
  mcpFailureBucketLabelKey,
  mcpFailureExits,
  mcpInspectSignature,
  mcpKeyLevelLabelKey,
  mcpTierLabelKey,
  minifyMCPJSON,
  parseMCPJSON,
  tokenizeJSON,
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
    transport: "auto",
    url: "http://127.0.0.1:8080/mcp",
    authType: "none",
    enabled: true,
    isConnected: true,
    toolCount: 4,
    resourceCount: 2,
    purposes: ["feed"],
    useGlobalFetch: true,
    oauthAuthorized: false,
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

describe("MCP 连接表单校验（validateMCPServerDraft）", () => {
  it("名称与地址都对时不报错", () => {
    expect(validateMCPServerDraft(draft())).toEqual([]);
  });

  it("新建默认走自动识别（auto），三种传输都不拦", () => {
    expect(emptyMCPServerDraft().transport).toBe("auto");
    for (const transport of ["auto", "streamable-http", "sse"] as const) {
      expect(validateMCPServerDraft(draft({ transport }))).toEqual([]);
    }
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

  it("OAuth 时带 client_id，secret 为空就不发（别把空串当成「改」）", () => {
    const payload = buildMCPServerPayload(
      draft({ authType: "oauth", oauthClientId: " cid ", oauthClientSecret: "" }),
    );
    expect(payload.oauthClientId).toBe("cid");
    expect("oauthClientSecret" in payload).toBe(false);
  });

  it("名称与地址去首尾空格", () => {
    const payload = buildMCPServerPayload(
      draft({ name: "  本机  ", url: "  http://127.0.0.1:8080/mcp  " }),
    );
    expect(payload.name).toBe("本机");
    expect(payload.url).toBe("http://127.0.0.1:8080/mcp");
  });
});

describe("粘贴 JSON 建档（parseMCPJSON，三种形状）", () => {
  it("① mcpServers 包（含多条，一次可建多个）", () => {
    const result = parseMCPJSON(
      JSON.stringify({
        mcpServers: {
          "nas-mcp": {
            type: "sse",
            url: "http://192.0.2.1:8931/sse",
            headers: { Authorization: "Bearer sk-123" },
          },
          fabric: { url: "https://mcp.fabric.so/mcp" },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]).toMatchObject({
      name: "nas-mcp",
      transport: "sse",
      url: "http://192.0.2.1:8931/sse",
      headers: { Authorization: "Bearer sk-123" },
    });
    expect(result.servers[0]?.detectedFrom).toContain("sse");
    // 没 type 的走自动识别
    expect(result.servers[1]?.transport).toBe("auto");
    expect(result.servers[1]?.name).toBe("fabric");
  });

  it("② 单条 {type,url,headers}", () => {
    const result = parseMCPJSON(
      JSON.stringify({
        type: "http",
        url: "https://mcp.notion.com/mcp",
        headers: {},
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.transport).toBe("streamable-http");
    // 名称从 url 派生（主机名）
    expect(result.servers[0]?.name).toBe("mcp.notion.com");
  });

  it("③ 只有 url：字符串与 {url} 都认，按后缀识别 SSE", () => {
    const fromString = parseMCPJSON('"http://192.0.2.1:8931/sse"');
    expect(fromString.ok).toBe(true);
    if (!fromString.ok) return;
    expect(fromString.servers[0]?.transport).toBe("sse");
    expect(fromString.servers[0]?.detectedFrom).toContain("/sse");

    const fromObject = parseMCPJSON(
      JSON.stringify({ url: "https://example.com/mcp" }),
    );
    expect(fromObject.ok).toBe(true);
    if (!fromObject.ok) return;
    expect(fromObject.servers[0]?.transport).toBe("auto");
  });

  it("坏输入各自有明确错误码", () => {
    expect(parseMCPJSON("")).toEqual({ ok: false, error: "not_json" });
    expect(parseMCPJSON("{oops")).toEqual({ ok: false, error: "not_json" });
    expect(parseMCPJSON("[1,2]")).toEqual({ ok: false, error: "not_object" });
    expect(parseMCPJSON("{}")).toEqual({
      ok: false,
      error: "no_servers_found",
    });
    expect(parseMCPJSON(JSON.stringify({ mcpServers: {} }))).toEqual({
      ok: false,
      error: "no_servers_found",
    });
    // stdio 本地进程拒识（16-15）：单条直接报，整包 stdio 也报，混包跳过 stdio 条
    expect(
      parseMCPJSON(JSON.stringify({ command: "npx", args: ["-y", "x"] })),
    ).toEqual({ ok: false, error: "stdio_unsupported" });
    expect(
      parseMCPJSON(
        JSON.stringify({
          mcpServers: { local: { command: "npx", args: ["-y", "x"] } },
        }),
      ),
    ).toEqual({ ok: false, error: "stdio_unsupported" });
    const mixed = parseMCPJSON(
      JSON.stringify({
        mcpServers: {
          local: { command: "npx", args: ["-y", "x"] },
          remote: { url: "https://example.com/mcp" },
        },
      }),
    );
    expect(mixed.ok).toBe(true);
    if (!mixed.ok) return;
    expect(mixed.servers.map((server) => server.name)).toEqual(["remote"]);
    expect(parseMCPJSON(JSON.stringify({ url: "not a url" }))).toEqual({
      ok: false,
      error: "url_invalid",
    });
  });
});

describe("传输识别（detectTransport）", () => {
  it("type 优先，大小写与变体都认", () => {
    expect(detectTransport({ type: "SSE" }, "https://x/mcp").transport).toBe(
      "sse",
    );
    expect(
      detectTransport({ type: "streamable-http" }, "https://x/mcp").transport,
    ).toBe("streamable-http");
    expect(detectTransport({ type: "http" }, "https://x/mcp").transport).toBe(
      "streamable-http",
    );
  });

  it("未知 type 不硬猜，走 auto", () => {
    expect(detectTransport({ type: "websocket" }, "https://x/mcp").transport).toBe(
      "auto",
    );
  });
});

describe("失败出口（mcpFailureExits：桶决定按钮，三处共用）", () => {
  it("认证桶 → 去配 Header / 改用 OAuth", () => {
    expect(
      mcpFailureExits({ bucket: "auth", code: "unauthorized", title: "x" }),
    ).toEqual(["to_header", "to_oauth"]);
  });

  it("传输出错 → 切 SSE 重试 + 重新探测", () => {
    for (const code of ["sse_endpoint", "not_found", "empty", "not_mcp"]) {
      expect(mcpFailureExits({ bucket: "protocol", code, title: "x" })).toEqual(
        ["to_sse", "redetect"],
      );
    }
  });

  it("未知桶 → 重新探测；网络/上游桶没有出口按钮", () => {
    expect(mcpFailureExits({ bucket: "unknown", code: "x", title: "y" })).toEqual(
      ["redetect"],
    );
    expect(
      mcpFailureExits({ bucket: "network", code: "refused", title: "x" }),
    ).toEqual([]);
    expect(
      mcpFailureExits({ bucket: "upstream", code: "bad_gateway", title: "x" }),
    ).toEqual([]);
    expect(mcpFailureExits(null)).toEqual([]);
  });

  it("桶名 i18n 键有兜底", () => {
    expect(mcpFailureBucketLabelKey("auth")).toBe(
      "ai_settings.mcp_failure_auth",
    );
    expect(
      mcpFailureBucketLabelKey("whatever" as "auth"),
    ).toBe("ai_settings.mcp_failure_unknown");
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
    preview: [{ title: "第一条", key: "k1", keyLevel: "link" }],
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
    expect(request).toEqual({
      kind: "resource",
      resourceUri: "krss://unread",
    });
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

  it("mcpConfig 按 kind 分流，并带上推断出的档位、去重键级别与分页", () => {
    const config = buildMCPFeedConfig({
      serverId: "s1",
      kind: "tool",
      toolName: "search_notes",
      arguments: { q: "x" },
      limit: 5,
      mapping: { title: "name" },
      tier: "structured",
      keyLevel: "link",
      pagination: { mode: "history", maxPages: 3, maxItems: 200 },
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
      pagination: { mode: "history", maxPages: 3, maxItems: 200 },
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
    expect("pagination" in resourceConfig).toBe(false);
  });

  it("分页默认值是 3 页 / 200 条", () => {
    expect(MCP_DEFAULT_MAX_PAGES).toBe(3);
    expect(MCP_DEFAULT_MAX_ITEMS).toBe(200);
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

describe("JSON 高亮 tokenizer（tokenizeJSON）", () => {
  it("key 与 string 分得开（冒号是判据）", () => {
    const kinds = tokenizeJSON('{"a": "b"}').map((t) => t.kind);
    expect(kinds).toContain("key");
    expect(kinds).toContain("string");
    // 回合制：原样拼回去
    const text = '{"a": "b", "n": 12, "f": true, "z": null}';
    expect(tokenizeJSON(text).map((t) => t.text).join("")).toBe(text);
  });

  it("数字含小数与指数", () => {
    const numbers = tokenizeJSON("[1, -2.5, 1e10]").filter(
      (t) => t.kind === "number",
    );
    expect(numbers.map((t) => t.text)).toEqual(["1", "-2.5", "1e10"]);
  });

  it("转义引号不断串", () => {
    const tokens = tokenizeJSON('{"a": "x\\"y"}');
    expect(tokens.map((t) => t.text).join("")).toBe('{"a": "x\\"y"}');
    expect(tokens.some((t) => t.kind === "string")).toBe(true);
  });

  it("坏 JSON 不崩（只是部分没颜色）", () => {
    const tokens = tokenizeJSON("{oops,");
    expect(tokens.map((t) => t.text).join("")).toBe("{oops,");
  });
});

describe("JSON 格式化与压缩", () => {
  it("格式化展开两格，压缩压成一行", () => {
    expect(formatMCPJSON('{"a":1}')).toEqual({
      ok: true,
      text: '{\n  "a": 1\n}',
    });
    expect(minifyMCPJSON('{ "a" : 1 }')).toEqual({
      ok: true,
      text: '{"a":1}',
    });
  });

  it("坏 JSON 报错带原文信息", () => {
    const formatted = formatMCPJSON("{oops");
    expect(formatted.ok).toBe(false);
    if (!formatted.ok) expect(formatted.message.length).toBeGreaterThan(0);
  });
});

describe("出向客户端配置示例", () => {
  it("带 origin 时用真地址，token 一律是占位符", () => {
    const text = buildMCPClientConfigExample("http://192.0.2.5:8080");
    const parsed = JSON.parse(text) as {
      mcpServers: {
        krss: { type: string; url: string; headers: { Authorization: string } };
      };
    };
    expect(parsed.mcpServers.krss.url).toBe("http://192.0.2.5:8080/mcp");
    expect(parsed.mcpServers.krss.type).toBe("http");
    expect(parsed.mcpServers.krss.headers.Authorization).toBe(
      "Bearer <token>",
    );
    expect(text).not.toMatch(/krss_mcp_/);
  });

  it("SSE 写法 type 是 sse（HTTP 与 SSE 两种都给）", () => {
    const text = buildMCPClientConfigExample(
      "http://192.0.2.5:8080",
      "sse",
    );
    const parsed = JSON.parse(text) as {
      mcpServers: { krss: { type: string; url: string } };
    };
    expect(parsed.mcpServers.krss.type).toBe("sse");
    expect(parsed.mcpServers.krss.url).toBe("http://192.0.2.5:8080/mcp");
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

describe("OAuth 回调地址", () => {
  it("运行时取当前访问 origin（零配置、远程可用）", () => {
    expect(buildOAuthCallbackURL("http://localhost:5174")).toBe(
      "http://localhost:5174/api/mcp/oauth/callback",
    );
    expect(buildOAuthCallbackURL("https://reader.example.com/")).toBe(
      "https://reader.example.com/api/mcp/oauth/callback",
    );
  });
});
