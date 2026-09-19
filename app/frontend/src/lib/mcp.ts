/**
 * MCP 功能的纯逻辑（无 React、无网络）——表单草稿、校验、请求体拼装、粘贴 JSON 解析、
 * 失败出口、JSON 高亮 tokenizer、分页默认值。
 *
 * 抽出来的原因有两个：① 这些规则要能被单测直接钉住（开关不受全局、间隔下限 15 分钟、
 * 映射改动后必须重新预览、三形状 JSON 解析）；② 表单组件里只留渲染，别把判据散在 JSX 里。
 */
import type {
  MCPAuthType,
  MCPEntryMapping,
  MCPFailure,
  MCPFailureBucket,
  MCPFeedConfig,
  MCPInspectRequest,
  MCPInspectResult,
  MCPKind,
  MCPKeyLevel,
  MCPPagination,
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

/** 追历史分页的默认值（16-8 口径：3 页 / 200 条） */
export const MCP_DEFAULT_MAX_PAGES = 3;
export const MCP_DEFAULT_MAX_ITEMS = 200;

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
  oauthClientId: string;
  oauthClientSecret: string;
}

/** 校验错误码（组件翻成 `ai_settings.mcp_err_<code>`，这样判据能脱离 i18n 被单测） */
export type MCPDraftError =
  | "name_required"
  | "url_invalid"
  | "headers_incomplete"
  | "purposes_required"
  | "interval_too_small"
  | "timeout_invalid"
  | "concurrency_invalid";

/** MCP 客户端配置示例里的 token 占位符（真实 token 绝不进这段文本） */
export const MCP_TOKEN_PLACEHOLDER = "<token>";

/** 预设卡片已删（16-6 口径：以后要「一键加」做成新建对话框里的下拉，不占列表空间）。
 * 这里故意不留 MCP_SERVER_PRESETS / applyPresetToDraft —— 死代码不进仓。 */

export function emptyMCPServerDraft(): MCPServerDraft {
  return {
    name: "",
    transport: "auto",
    url: "",
    authType: "none",
    headers: [],
    enabled: true,
    purposes: [],
    useGlobalFetch: true,
    fetchTimeoutSeconds: MCP_DEFAULT_TIMEOUT_SECONDS,
    fetchConcurrency: MCP_DEFAULT_CONCURRENCY,
    refreshIntervalMinutes: MCP_DEFAULT_REFRESH_INTERVAL_MINUTES,
    oauthClientId: "",
    oauthClientSecret: "",
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
    oauthClientId: server.oauthClientId ?? "",
    oauthClientSecret: server.oauthClientSecret ?? "",
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

  if (draft.authType === "oauth") {
    payload.oauthClientId = draft.oauthClientId.trim();
    // 掩码原样送回 = 没改（后端换回真值）；空串 = 清掉
    if (draft.oauthClientSecret !== "") {
      payload.oauthClientSecret = draft.oauthClientSecret;
    }
  }

  return payload;
}

// ---------------------------------------------------------------------------
// 16-9：粘贴 JSON 建档（三种形状）
// ---------------------------------------------------------------------------

/** 粘贴解析出的一条连接（含来源说明，界面拼识别结果卡用） */
export interface MCPParsedServer {
  name: string;
  transport: MCPTransport;
  /** "auto" 在这里表示「没看出来，按自动识别走」 */
  url: string;
  headers: Record<string, string>;
  /** 识别依据（`由 "type":"sse" 识别` 这类文案拼装用） */
  detectedFrom: string;
}

/** 粘贴解析结果：ok 若干条，或一段失败原因 */
export type MCPParseResult =
  | { ok: true; servers: MCPParsedServer[] }
  | { ok: false; error: MCPParseError };

export type MCPParseError =
  | "not_json"
  | "not_object"
  | "no_servers_found"
  | "url_invalid";

/**
 * 认三种形状：
 * ① Claude/Cursor 的 `{"mcpServers":{name: {type,url,headers,…}}}`（可一次多条）
 * ② 单条 `{type,url,headers}`（type 多种写法都认）
 * ③ 只有 url（字符串或 `{url}`）→ 按 URL 特征 + 自动识别兜底
 */
export function parseMCPJSON(raw: string): MCPParseResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: "not_json" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "not_json" };
  }
  // ③-a：纯字符串就是一个 url
  if (typeof parsed === "string") {
    return singleFromUrl(parsed);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "not_object" };
  }
  const obj = parsed as Record<string, unknown>;
  // ①：{"mcpServers": {...}}
  const bundle = obj["mcpServers"];
  if (bundle !== undefined) {
    if (
      bundle === null ||
      typeof bundle !== "object" ||
      Array.isArray(bundle)
    ) {
      return { ok: false, error: "no_servers_found" };
    }
    const entries = Object.entries(bundle as Record<string, unknown>);
    if (entries.length === 0) return { ok: false, error: "no_servers_found" };
    const servers: MCPParsedServer[] = [];
    for (const [name, item] of entries) {
      const one = parseSingleServer(name, item);
      if (one === null) return { ok: false, error: "url_invalid" };
      servers.push(one);
    }
    return { ok: true, servers };
  }
  // ②/③-b：单条（{type,url,headers} 或 {url}；command 本地进程不认）
  const one = parseSingleServer("", obj);
  if (one === null) {
    if (!hasAnyUrl(obj)) return { ok: false, error: "no_servers_found" };
    return { ok: false, error: "url_invalid" };
  }
  return { ok: true, servers: [one] };
}

function hasAnyUrl(obj: Record<string, unknown>): boolean {
  return (
    typeof obj["url"] === "string" ||
    typeof obj["serverUrl"] === "string" ||
    typeof obj["server_url"] === "string"
  );
}

/** 单条解析：name 为 "" 时从 url 派生默认名 */
function parseSingleServer(name: string, item: unknown): MCPParsedServer | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const obj = item as Record<string, unknown>;
  // command+args（stdio 本地进程）：没有 url，不认 —— 明确返回 null 让界面说清
  if (typeof obj["command"] === "string" && obj["url"] === undefined) {
    return null;
  }
  const url =
    asString(obj["url"]) ??
    asString(obj["serverUrl"]) ??
    asString(obj["server_url"]) ??
    "";
  if (!isHttpUrl(url)) return null;
  const headers = asHeaders(obj["headers"]);
  const { transport, detectedFrom } = detectTransport(obj, url);
  return {
    name: name.trim() || defaultNameFromUrl(url),
    transport,
    url: url.trim(),
    headers,
    detectedFrom,
  };
}

function singleFromUrl(url: string): MCPParseResult {
  if (!isHttpUrl(url)) return { ok: false, error: "url_invalid" };
  const { transport, detectedFrom } = detectTransport({}, url.trim());
  return {
    ok: true,
    servers: [
      {
        name: defaultNameFromUrl(url.trim()),
        transport,
        url: url.trim(),
        headers: {},
        detectedFrom,
      },
    ],
  };
}

/**
 * 传输识别：JSON 的 type 优先（sse/http/streamable-http 都认）；
 * 没有 type 就看 URL（…/sse 结尾像 SSE 端点）；
 * 都看不出 → auto（后端按「试 HTTP，失败自动试 SSE」走）。
 */
export function detectTransport(
  obj: Record<string, unknown>,
  url: string,
): { transport: MCPTransport; detectedFrom: string } {
  const rawType = asString(obj["type"]) ?? asString(obj["transport"]) ?? "";
  const normalized = rawType.trim().toLowerCase();
  if (normalized === "sse") {
    return { transport: "sse", detectedFrom: '由 "type":"sse" 识别' };
  }
  if (
    normalized === "http" ||
    normalized === "streamable-http" ||
    normalized === "streamablehttp"
  ) {
    return {
      transport: "streamable-http",
      detectedFrom: `由 "type":"${rawType.trim()}" 识别`,
    };
  }
  if (normalized !== "") {
    // 未知的 type：不硬猜，走自动识别
    return { transport: "auto", detectedFrom: "type 未知，按自动识别" };
  }
  if (/\/sse\/?(\?.*)?$/i.test(url.trim())) {
    return { transport: "sse", detectedFrom: "由地址后缀 /sse 识别" };
  }
  return {
    transport: "auto",
    detectedFrom: "未指定，按自动识别（先 HTTP，失败自动试 SSE）",
  };
}

function defaultNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return parsed.hostname || url.trim();
  } catch {
    return url.trim();
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asHeaders(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
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
  pagination?: MCPPagination;
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
  if (input.pagination) config.pagination = input.pagination;
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

/** 失败桶 → i18n 键（标题/建议由后端的人话文案直接给，这里只给桶名与出口按钮） */
export function mcpFailureBucketLabelKey(bucket: MCPFailureBucket): string {
  switch (bucket) {
    case "network":
      return "ai_settings.mcp_failure_network";
    case "auth":
      return "ai_settings.mcp_failure_auth";
    case "protocol":
      return "ai_settings.mcp_failure_protocol";
    case "upstream":
      return "ai_settings.mcp_failure_upstream";
    default:
      return "ai_settings.mcp_failure_unknown";
  }
}

/**
 * 桶 → 出口按钮（16-12 口径，写死在这里，三处共用）：
 * 认证桶 →「去配 Header / 改用 OAuth」；传输出错（sse_endpoint/not_found/empty/not_mcp）
 * →「切 SSE 重试 + 重新探测」；未知桶 →「重新探测」。
 */
export type MCPFailureExit =
  | "to_header"
  | "to_oauth"
  | "to_sse"
  | "redetect"
  | "none";

export function mcpFailureExits(
  failure: MCPFailure | null | undefined,
): MCPFailureExit[] {
  if (!failure) return [];
  if (failure.bucket === "auth") return ["to_header", "to_oauth"];
  if (
    failure.bucket === "protocol" &&
    (failure.code === "sse_endpoint" ||
      failure.code === "not_found" ||
      failure.code === "empty" ||
      failure.code === "not_mcp")
  ) {
    return ["to_sse", "redetect"];
  }
  if (failure.bucket === "unknown") return ["redetect"];
  return [];
}

/**
 * 出向：给一段可直接复制的 MCP 客户端配置。
 * token 一律用占位符 —— 这段文本会被复制到别处，绝不能把真实 token 带出去。
 * HTTP 与 SSE 两种写法都给（17-x 微调）。
 */
export function buildMCPClientConfigExample(
  origin?: string,
  transport?: "http" | "sse",
): string {
  const base = (origin ?? "").trim().replace(/\/+$/, "");
  const endpoint = base ? `${base}/mcp` : "http://<host>:<port>/mcp";
  const type = transport === "sse" ? "sse" : "http";
  return JSON.stringify(
    {
      mcpServers: {
        krss: {
          type,
          url: endpoint,
          headers: { Authorization: `Bearer ${MCP_TOKEN_PLACEHOLDER}` },
        },
      },
    },
    null,
    2,
  );
}

/** OAuth 回调地址：运行时取当前访问 origin（零配置、远程可用） */
export function buildOAuthCallbackURL(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/mcp/oauth/callback`;
}

// ---------------------------------------------------------------------------
// 16-13：JSON 高亮（小 tokenizer，只读区上色用；不做边打字边高亮）
// ---------------------------------------------------------------------------

/** JSON token 种类 → 四色（用现有主题 token，不新造色） */
export type MCPJsonTokenKind = "key" | "string" | "number" | "literal" | "punct";

export interface MCPJsonToken {
  kind: MCPJsonTokenKind;
  text: string;
}

/**
 * 最小 JSON tokenizer：字符串（含转义）/ 数字 / true·false·null / 标点。
 * 坏 JSON 也不会崩（只是部分没颜色），空白原样保留（<pre> 里靠它对齐）。
 */
export function tokenizeJSON(input: string): MCPJsonToken[] {
  const tokens: MCPJsonToken[] = [];
  const isSpace = (ch: string): boolean =>
    ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  // 注：不用 input[i] 下标 —— 本仓开了 noUncheckedIndexedAccess，下标类型是 string|undefined
  const at = (index: number): string =>
    index < input.length ? (input.charAt(index) as string) : "";
  let i = 0;
  while (i < input.length) {
    const ch = at(i);
    if (isSpace(ch)) {
      let j = i + 1;
      while (j < input.length && isSpace(at(j))) j++;
      tokens.push({ kind: "punct", text: input.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < input.length) {
        if (at(j) === "\\") {
          j += 2;
          continue;
        }
        if (at(j) === '"') {
          j++;
          break;
        }
        j++;
      }
      const text = input.slice(i, j);
      // key 判定：后面（跳过空白）紧跟冒号
      let k = j;
      while (k < input.length && /\s/.test(at(k))) k++;
      tokens.push({ kind: at(k) === ":" ? "key" : "string", text });
      i = j;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
        input.slice(i),
      );
      if (match?.[0]) {
        tokens.push({ kind: "number", text: match[0] });
        i += match[0].length;
        continue;
      }
    }
    let literal = "";
    for (const candidate of ["true", "false", "null"]) {
      if (input.startsWith(candidate, i)) {
        literal = candidate;
        break;
      }
    }
    if (literal) {
      tokens.push({ kind: "literal", text: literal });
      i += literal.length;
      continue;
    }
    tokens.push({ kind: "punct", text: ch });
    i++;
  }
  return tokens;
}

/** JSON 格式化（含校验）：失败带原文错误信息，工具条「校验」按钮用 */
export function formatMCPJSON(
  raw: string,
):
  | { ok: true; text: string }
  | { ok: false; message: string } {
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(raw), null, 2) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** JSON 压缩（一行，塞 arguments 那种场景用） */
export function minifyMCPJSON(
  raw: string,
):
  | { ok: true; text: string }
  | { ok: false; message: string } {
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(raw)) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
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
