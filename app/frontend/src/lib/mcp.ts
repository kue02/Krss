/**
 * MCP 功能的纯逻辑（无 React、无网络）——表单草稿、校验、请求体拼装、预设。
 *
 * 抽出来的原因有两个：① 这些规则要能被单测直接钉住（开关不受全局、间隔下限 15 分钟、
 * 映射改动后必须重新预览）；② 表单组件里只留渲染，别把判据散在 JSX 里。
 */
import type {
  MCPAuthType,
  MCPEntryMapping,
  MCPFeedConfig,
  MCPInspectRequest,
  MCPInspectResult,
  MCPKind,
  MCPKeyLevel,
  MCPServer,
  MCPServerWritePayload,
  MCPTransport,
} from "@/types/mcp";

/** Header 值的掩码串；PATCH 回它 = 「这一项没改」 */
export const MCP_MASK = "••••••••";

/** 单独配刷新间隔的下限（用户已拍板：15 分钟起，别把有次数限额的 MCP 刷爆） */
export const MCP_MIN_REFRESH_INTERVAL_MINUTES = 15;

/** 单独配时的默认值（新建连接默认跟全局，这三个只在切到「单独配」后露出） */
export const MCP_DEFAULT_TIMEOUT_SECONDS = 15;
export const MCP_DEFAULT_CONCURRENCY = 4;
export const MCP_DEFAULT_REFRESH_INTERVAL_MINUTES = 15;

/** 第一版支持的传输（sse 在界面上禁用并注明「第一版不支持」） */
export const MCP_SUPPORTED_TRANSPORTS: MCPTransport[] = ["streamable-http"];

/** 表单里的一行 Header（编辑已有连接时 value 是掩码串） */
export interface MCPHeaderDraft {
  key: string;
  value: string;
}

/** 连接表单的草稿。数字字段用 number，空输入落成 0 交给校验报错。 */
export interface MCPServerDraft {
  name: string;
  transport: MCPTransport;
  url: string;
  authType: MCPAuthType;
  headers: MCPHeaderDraft[];
  enabled: boolean;
  purposes: ("ai" | "feed")[];
  useGlobalFetch: boolean;
  fetchTimeoutSeconds: number;
  fetchConcurrency: number;
  refreshIntervalMinutes: number;
}

/** 校验错误码（组件翻成 `ai_settings.mcp_err_<code>`，这样判据能脱离 i18n 被单测） */
export type MCPDraftError =
  | "name_required"
  | "transport_unsupported"
  | "url_invalid"
  | "headers_incomplete"
  | "purposes_required"
  | "interval_too_small"
  | "timeout_invalid"
  | "concurrency_invalid";

/** MCP 客户端配置示例里的 token 占位符（真实 token 绝不进这段文本） */
export const MCP_TOKEN_PLACEHOLDER = "<token>";

/** 预设卡片：名字走 i18n，URL 是占位提示，点一下把两者填进新建表单 */
export interface MCPServerPreset {
  id: string;
  nameKey: string;
  hintKey: string;
  url: string;
}

export const MCP_SERVER_PRESETS: MCPServerPreset[] = [
  {
    id: "krss-local",
    nameKey: "ai_settings.mcp_preset_krss",
    hintKey: "ai_settings.mcp_preset_krss_hint",
    url: "http://127.0.0.1:8080/mcp",
  },
  {
    id: "fabric",
    nameKey: "ai_settings.mcp_preset_fabric",
    hintKey: "ai_settings.mcp_preset_fabric_hint",
    url: "https://mcp.fabric.so/mcp",
  },
  {
    id: "notion",
    nameKey: "ai_settings.mcp_preset_notion",
    hintKey: "ai_settings.mcp_preset_notion_hint",
    url: "https://mcp.notion.com/mcp",
  },
  {
    id: "github",
    nameKey: "ai_settings.mcp_preset_github",
    hintKey: "ai_settings.mcp_preset_github_hint",
    url: "https://api.githubcopilot.com/mcp/",
  },
];

export function emptyMCPServerDraft(): MCPServerDraft {
  return {
    name: "",
    transport: "streamable-http",
    url: "",
    authType: "none",
    headers: [],
    enabled: true,
    purposes: [],
    useGlobalFetch: true,
    fetchTimeoutSeconds: MCP_DEFAULT_TIMEOUT_SECONDS,
    fetchConcurrency: MCP_DEFAULT_CONCURRENCY,
    refreshIntervalMinutes: MCP_DEFAULT_REFRESH_INTERVAL_MINUTES,
  };
}

/** 编辑已有连接：回填字段。Header 值保持掩码原样 —— 原样送回表示「这项没改」。 */
export function mcpDraftFromServer(server: MCPServer): MCPServerDraft {
  return {
    name: server.name,
    transport: server.transport,
    url: server.url,
    authType: server.authType,
    headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({
      key,
      value,
    })),
    enabled: server.enabled,
    purposes: [...server.purposes],
    useGlobalFetch: server.useGlobalFetch,
    fetchTimeoutSeconds:
      server.fetchTimeoutSeconds ?? MCP_DEFAULT_TIMEOUT_SECONDS,
    fetchConcurrency: server.fetchConcurrency ?? MCP_DEFAULT_CONCURRENCY,
    refreshIntervalMinutes:
      server.refreshIntervalMinutes ?? MCP_DEFAULT_REFRESH_INTERVAL_MINUTES,
  };
}

/** 点预设卡片：只填名称与地址（其余保持用户已经选好的东西） */
export function applyPresetToDraft(
  draft: MCPServerDraft,
  preset: MCPServerPreset,
  displayName: string,
): MCPServerDraft {
  return {
    ...draft,
    name: displayName,
    url: preset.url,
    transport: "streamable-http",
  };
}

function isHttpUrl(raw: string): boolean {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 表单校验：返回全部错误码（不是遇到第一个就停，用户一次能看到所有问题） */
export function validateMCPServerDraft(draft: MCPServerDraft): MCPDraftError[] {
  const errors: MCPDraftError[] = [];

  if (!draft.name.trim()) errors.push("name_required");
  if (!MCP_SUPPORTED_TRANSPORTS.includes(draft.transport)) {
    errors.push("transport_unsupported");
  }
  if (!isHttpUrl(draft.url)) errors.push("url_invalid");
  if (draft.purposes.length === 0) errors.push("purposes_required");

  if (draft.authType === "header") {
    const incomplete = draft.headers.some(
      (header) => !header.key.trim() || !header.value.trim(),
    );
    if (incomplete) errors.push("headers_incomplete");
  }

  // 取数时机：跟全局时下面三个字段不生效，也就不校验
  if (!draft.useGlobalFetch) {
    if (draft.refreshIntervalMinutes < MCP_MIN_REFRESH_INTERVAL_MINUTES) {
      errors.push("interval_too_small");
    }
    if (draft.fetchTimeoutSeconds <= 0) errors.push("timeout_invalid");
    if (draft.fetchConcurrency <= 0) errors.push("concurrency_invalid");
  }

  return errors;
}

/** 草稿 → 请求体。跟全局时三个数字字段必须省掉（发了反而被当成「单独配」）。 */
export function buildMCPServerPayload(
  draft: MCPServerDraft,
): MCPServerWritePayload {
  const payload: MCPServerWritePayload = {
    name: draft.name.trim(),
    transport: draft.transport,
    url: draft.url.trim(),
    authType: draft.authType,
    headers:
      draft.authType === "header"
        ? Object.fromEntries(
            draft.headers
              .filter((header) => header.key.trim())
              .map((header) => [header.key.trim(), header.value]),
          )
        : {},
    enabled: draft.enabled,
    purposes: [...draft.purposes],
    useGlobalFetch: draft.useGlobalFetch,
  };

  if (!draft.useGlobalFetch) {
    payload.fetchTimeoutSeconds = draft.fetchTimeoutSeconds;
    payload.fetchConcurrency = draft.fetchConcurrency;
    payload.refreshIntervalMinutes = draft.refreshIntervalMinutes;
  }

  return payload;
}

/**
 * 建源向导里可选的连接：**开着**、且「用途里带 feed 或压根没标用途」。
 * 没标用途的连接不隐藏（用户可能还没顾上标），标了「仅 AI 用」的才排除。
 */
export function feedSelectableServers(servers: MCPServer[]): MCPServer[] {
  return servers.filter(
    (server) =>
      server.enabled &&
      (server.purposes.includes("feed") || server.purposes.length === 0),
  );
}

/** 映射草稿：表单里一律是字符串，空串 = 不用这个字段 */
export type MCPMappingDraft = Record<keyof MCPEntryMapping, string>;

export const MAPPING_FIELD_ORDER: (keyof MCPEntryMapping)[] = [
  "listPath",
  "title",
  "url",
  "content",
  "publishedAt",
  "author",
  "id",
  "thumbnail",
];

export function emptyMappingDraft(): MCPMappingDraft {
  return {
    listPath: "",
    title: "",
    url: "",
    content: "",
    publishedAt: "",
    author: "",
    id: "",
    thumbnail: "",
  };
}

/** 后端给的映射 → 表单草稿（自动预填） */
export function mappingDraftFromMapping(
  mapping: MCPEntryMapping | null | undefined,
): MCPMappingDraft {
  const draft = emptyMappingDraft();
  if (!mapping) return draft;
  for (const field of MAPPING_FIELD_ORDER) {
    draft[field] = mapping[field] ?? "";
  }
  return draft;
}

/** 表单草稿 → 请求体里的映射（空串字段直接丢掉，别送空路径） */
export function mappingFromDraft(draft: MCPMappingDraft): MCPEntryMapping {
  const mapping: MCPEntryMapping = {};
  for (const field of MAPPING_FIELD_ORDER) {
    const value = draft[field].trim();
    if (value) mapping[field] = value;
  }
  return mapping;
}

/**
 * 预览请求的「指纹」—— 只要取数参数或映射有一处不同，指纹就变。
 * 用它卡住「预览成功 → 改了映射 → 直接创建」这条路（改了就必须重新预览）。
 */
export function mcpInspectSignature(request: MCPInspectRequest): string {
  return JSON.stringify({
    kind: request.kind,
    toolName: request.toolName ?? "",
    resourceUri: request.resourceUri ?? "",
    arguments: request.arguments ?? {},
    limit: request.limit ?? 0,
    mapping: request.mapping ?? {},
  });
}

/** 拼一次 inspect 的请求体（干跑 / 带映射再预览一次都走这里，避免两处漂） */
export function buildInspectRequest(input: {
  kind: MCPKind;
  toolName?: string;
  resourceUri?: string;
  arguments?: Record<string, unknown>;
  limit?: number;
  mapping?: MCPEntryMapping;
}): MCPInspectRequest {
  const request: MCPInspectRequest = { kind: input.kind };
  if (input.kind === "tool") {
    if (input.toolName) request.toolName = input.toolName;
    if (input.arguments) request.arguments = input.arguments;
    if (typeof input.limit === "number") request.limit = input.limit;
  } else if (input.resourceUri) {
    request.resourceUri = input.resourceUri;
  }
  if (input.mapping) request.mapping = input.mapping;
  return request;
}

/**
 * 创建按钮能不能点：必须**真出过数据**（preview 非空、无 error），
 * 而且那次预览的指纹与「现在这份参数」一致。
 */
export function isMCPPreviewReady(input: {
  result: MCPInspectResult | null;
  previewSignature: string | null;
  currentSignature: string;
}): boolean {
  const { result } = input;
  if (!result) return false;
  if (result.error) return false;
  if (result.preview.length === 0) return false;
  return input.previewSignature !== null &&
    input.previewSignature === input.currentSignature;
}

/** 预览草稿 → 建源用的 mcpConfig */
export function buildMCPFeedConfig(input: {
  serverId: string;
  kind: MCPKind;
  toolName?: string;
  resourceUri?: string;
  arguments?: Record<string, unknown>;
  limit?: number;
  mapping: MCPEntryMapping;
  tier?: string;
  keyLevel?: string;
}): MCPFeedConfig {
  const config: MCPFeedConfig = {
    serverId: input.serverId,
    kind: input.kind,
    mapping: input.mapping,
  };
  if (input.kind === "tool") {
    if (input.toolName) config.toolName = input.toolName;
    if (input.arguments) config.arguments = input.arguments;
    if (typeof input.limit === "number") config.limit = input.limit;
  } else if (input.resourceUri) {
    config.resourceUri = input.resourceUri;
  }
  if (input.tier) config.tier = input.tier;
  if (input.keyLevel) config.keyLevel = input.keyLevel;
  return config;
}

/** 默认订阅标题：`MCP · <连接名> / <工具或资源>` */
export function defaultMCPFeedTitle(
  serverName: string,
  kind: MCPKind,
  targetName: string,
): string {
  const target = targetName.trim() || (kind === "tool" ? "tool" : "resource");
  return `MCP · ${serverName.trim() || "MCP"} / ${target}`;
}

/** 去重键用了哪一级 → i18n 键（界面只显示「用了哪一级」，不让用户做这个决定） */
export function mcpKeyLevelLabelKey(level: MCPKeyLevel | string): string {
  switch (level) {
    case "key":
      return "ai_settings.mcp_key_level_key";
    case "link":
      return "ai_settings.mcp_key_level_link";
    case "title+time":
      return "ai_settings.mcp_key_level_title_time";
    default:
      return "ai_settings.mcp_key_level_unknown";
  }
}

/** 自动度四档 → i18n 键 */
export function mcpTierLabelKey(tier: string): string {
  switch (tier) {
    case "resource":
      return "ai_settings.mcp_tier_resource";
    case "schema":
      return "ai_settings.mcp_tier_schema";
    case "structured":
      return "ai_settings.mcp_tier_structured";
    case "text":
      return "ai_settings.mcp_tier_text";
    default:
      return "ai_settings.mcp_tier_unknown";
  }
}

/**
 * 出向：给一段可直接复制的 MCP 客户端配置。
 * token 一律用占位符 —— 这段文本会被复制到别处，绝不能把真实 token 带出去。
 */
export function buildMCPClientConfigExample(origin?: string): string {
  const base = (origin ?? "").trim().replace(/\/+$/, "");
  const endpoint = base ? `${base}/mcp` : "http://<host>:<port>/mcp";
  return JSON.stringify(
    {
      mcpServers: {
        krss: {
          url: endpoint,
          headers: { Authorization: `Bearer ${MCP_TOKEN_PLACEHOLDER}` },
        },
      },
    },
    null,
    2,
  );
}

/**
 * 把 catch 到的东西收成一句可见的文案来源。
 *
 * 为什么收成一个纯函数、而不是在 catch 里直接 `t(...)`：这些 catch 结果要写进 state，
 * 而组件里「拉数据」的 effect 一旦把 `t` 放进依赖就会在 `t` 身份变化时反复触发
 * （react-i18next 生产环境里 `t` 稳定，但测试/切语言时会变）—— 所以 effect 只存原文，
 * 空串表示「没有可显示的原文」，渲染时再退回 `t("…_failed")`。
 */
export function mcpErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}
