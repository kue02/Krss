/**
 * MCP 双向功能的类型契约（入向 MCP → Feed / 出向 Krss 当 MCP 服务器）。
 *
 * 字段与后端 `/api/mcp/*` 的响应一一对应（见 docs/MCP-方案-2026-09-18.md 与后端 handler）。
 * 两条铁律：① 不出现 any；② Header 值永远只是掩码串（`MCP_MASK`），真值只在后端。
 */
import type { ContentType } from "@/types/api";

/** 传输：auto（默认，自动识别 + 记住上次成功的）/ streamable-http / sse（旧版 HTTP+SSE） */
export type MCPTransport = "auto" | "streamable-http" | "sse";

/** 认证：无 / Header / OAuth（well-known 发现 → DCR → PKCE） */
export type MCPAuthType = "none" | "header" | "oauth";

/** 同一份连接的用途标记，可并存 */
export type MCPPurpose = "ai" | "feed";

/** 取的对象是工具还是资源 */
export type MCPKind = "tool" | "resource";

/** 自动度四档（后端推断出来的） */
export type MCPInspectTier = "resource" | "schema" | "structured" | "text";

/** 去重键实际用了哪一级：映射里的键字段 → 链接 → 标题 + 时间 */
export type MCPKeyLevel = "key" | "link" | "title+time";

/**
 * 声明式字段映射：列表路径 + 各字段的点号路径。
 * 全部可选 —— 缺了就是留空，不猜不硬塞（去重键的退化顺序由后端按上面 `MCPKeyLevel` 走）。
 */
export interface MCPEntryMapping {
  listPath?: string;
  title?: string;
  url?: string;
  content?: string;
  publishedAt?: string;
  author?: string;
  id?: string;
  thumbnail?: string;
}

/** 一条 MCP 连接（GET /api/mcp/servers 的每一项） */
export interface MCPServer {
  id: string;
  name: string;
  transport: MCPTransport;
  url: string;
  authType: MCPAuthType;
  /** 值为掩码串（见 `MCP_MASK`）；PATCH 回掩码 = 这一项没改 */
  headers?: Record<string, string>;
  enabled: boolean;
  isConnected: boolean;
  lastError?: string;
  toolCount: number;
  resourceCount: number;
  purposes: MCPPurpose[];
  /** true = 取数跟全局（超时/并发）；false = 用下面三个字段单独配 */
  useGlobalFetch: boolean;
  fetchTimeoutSeconds?: number;
  fetchConcurrency?: number;
  refreshIntervalMinutes?: number;
  /** 上次成功的传输（transport='auto' 时下次优先试它） */
  lastTransport?: string;
  /** OAuth：client_id 明文可出；secret 只出掩码 */
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthAuthorized: boolean;
  oauthExpiresAt?: string;
  oauthAuthServer?: string;
  /** 结构化失败（列表行/测试/预览三处共用） */
  lastFailure?: MCPFailure | null;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 更新连接的请求体（POST / PATCH /api/mcp/servers） */
export interface MCPServerWritePayload {
  name: string;
  transport: MCPTransport;
  url: string;
  authType: MCPAuthType;
  headers: Record<string, string>;
  enabled: boolean;
  purposes: MCPPurpose[];
  useGlobalFetch: boolean;
  fetchTimeoutSeconds?: number;
  fetchConcurrency?: number;
  refreshIntervalMinutes?: number;
  /** OAuth 手填凭证（不支持 DCR 的服务用；secret 传掩码 = 没改） */
  oauthClientId?: string;
  oauthClientSecret?: string;
}

/** 失败 4 桶 + 未知兜底（16-12：列表行 / 测试按钮 / 向导预览三处共用同一套） */
export type MCPFailureBucket =
  | "network"
  | "auth"
  | "protocol"
  | "upstream"
  | "unknown";

/** 一次失败的结构化原因：结论一句话（人话）+ 一句建议 + 可复制的原始返回 */
export interface MCPFailure {
  bucket: MCPFailureBucket;
  code: string;
  title: string;
  suggestion?: string;
  raw?: string;
}

/** POST /api/mcp/servers/:id/test —— 永远 200，连接失败也在 body 里（不是请求失败） */
export interface MCPTestResult {
  connected: boolean;
  serverName?: string;
  serverVersion?: string;
  toolCount: number;
  resourceCount: number;
  error?: string;
  /** 结构化失败（成功时没有） */
  failure?: MCPFailure | null;
  /** 这次实际用的传输 */
  transport?: string;
  /** 握手耗时毫秒 */
  latencyMs?: number;
}

/** 工具定义（tools/list）：inputSchema 必有、outputSchema 可选 */
export interface MCPTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** 资源定义（resources/list） */
export interface MCPResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** POST /api/mcp/servers/:id/tools */
export interface MCPToolsResponse {
  tools: MCPTool[];
  resources: MCPResource[];
}

/** POST /api/mcp/servers/:id/inspect 的请求体 */
export interface MCPInspectRequest {
  kind: MCPKind;
  toolName?: string;
  resourceUri?: string;
  arguments?: Record<string, unknown>;
  limit?: number;
  /** 传了就是「用我改过的映射再预览一次」 */
  mapping?: MCPEntryMapping;
  tier?: string;
}

/** 预览里的样本条目 */
export interface MCPInspectPreviewItem {
  title?: string;
  url?: string;
  content?: string;
  publishedAt?: string;
  author?: string;
  /** 这一条算出来的去重键值 */
  key: string;
  keyLevel: string;
}

/** POST /api/mcp/servers/:id/inspect 的响应（失败也是 200 + error） */
export interface MCPInspectResult {
  tier: MCPInspectTier;
  mapping: MCPEntryMapping;
  keyLevel: MCPKeyLevel;
  notes: string[];
  preview: MCPInspectPreviewItem[];
  total: number;
  error?: string;
  truncated?: boolean;
  /** 结构化失败（向导预览与测试按钮共用同一套文案） */
  failure?: MCPFailure | null;
  /** 还有下一页时回传（向导「拉更多」把游标塞进 arguments 再 inspect） */
  nextCursor?: string;
  /** 游标参数名（inputSchema 里自动找到的） */
  cursorParam?: string;
}

/** 追历史分页配置（存在 mcp_config 里，不用新迁移；默认 single 只取一页） */
export interface MCPPagination {
  mode?: "single" | "history";
  maxPages?: number;
  maxItems?: number;
  cursorParam?: string;
  cursorPath?: string;
}

/** POST /api/mcp/servers/:id/suggest-mapping 的请求体（第 4 档 AI 兜底，只返回不落库） */
export interface MCPSuggestRequest {
  kind: MCPKind;
  toolName?: string;
  resourceUri?: string;
  arguments?: Record<string, unknown>;
  limit?: number;
}

/** suggest-mapping 的响应：猜出来的映射（必须预览确认后才落库） */
export interface MCPSuggestResult {
  mapping: MCPEntryMapping;
  model: string;
  estimatedTokens: number;
  textUsed: number;
  raw?: string;
}

/** POST /api/mcp/servers/:id/oauth/discovery 的响应 */
export interface MCPOAuthDiscovery {
  authServer: string;
  hasDCR: boolean;
  needsManual: boolean;
  hasClientID: boolean;
  instructions?: string;
}

/** POST /api/mcp/servers/:id/oauth/start 的响应：前端拿 authURL 开浏览器 */
export interface MCPOAuthStart {
  authURL: string;
  state: string;
}

/** 出向服务状态（GET / PUT /api/mcp/outbound） */
export interface MCPOutboundStatus {
  enabled: boolean;
  /** 允许写操作（mark_read / star_entry），默认关 */
  writeEnabled: boolean;
  tokenSet: boolean;
  tokenPrefix?: string;
  tokenCreatedAt?: string;
  /** 对外访问地址（用户填；空 = 没填，示例回落到浏览器当前 origin） */
  baseUrl?: string;
  endpoint: string;
  protocolVersion: string;
  toolCount: number;
  resourceCount: number;
}

/** POST /api/mcp/outbound/token —— 明文 token 只此一次 */
export interface MCPOutboundTokenResponse extends MCPOutboundStatus {
  token: string;
}

/** 建 MCP 订阅时随 feed 一起存的取数配置 */
export interface MCPFeedConfig {
  serverId: string;
  kind: MCPKind;
  toolName?: string;
  resourceUri?: string;
  arguments?: Record<string, unknown>;
  limit?: number;
  mapping: MCPEntryMapping;
  tier?: string;
  keyLevel?: string;
  /** 追历史分页（16-8：缺省 single 只取一页） */
  pagination?: MCPPagination;
}

/** POST /api/feeds 建 MCP 订阅的请求体 */
export interface MCPFeedCreatePayload {
  title: string;
  folderId?: string;
  type?: ContentType;
  mcpConfig: MCPFeedConfig;
}
