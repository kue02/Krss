/**
 * MCP 双向功能的类型契约（入向 MCP → Feed / 出向 Krss 当 MCP 服务器）。
 *
 * 字段与后端 `/api/mcp/*` 的响应一一对应（见 docs/MCP-方案-2026-09-18.md 与后端 handler）。
 * 两条铁律：① 不出现 any；② Header 值永远只是掩码串（`MCP_MASK`），真值只在后端。
 */
import type { ContentType } from "@/types/api";

/** 传输：第一版只支持 streamable-http（sse 在界面上禁用并注明「第一版不支持」） */
export type MCPTransport = "streamable-http" | "sse";

/** 认证：第一版只做无认证 / Header（OAuth 留到后面） */
export type MCPAuthType = "none" | "header";

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
}

/** POST /api/mcp/servers/:id/test —— 永远 200，连接失败也在 body 里（不是请求失败） */
export interface MCPTestResult {
  connected: boolean;
  serverName?: string;
  serverVersion?: string;
  toolCount: number;
  resourceCount: number;
  error?: string;
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
}

/** 出向服务状态（GET / PUT /api/mcp/outbound） */
export interface MCPOutboundStatus {
  enabled: boolean;
  /** 允许写操作（mark_read / star_entry），默认关 */
  writeEnabled: boolean;
  tokenSet: boolean;
  tokenPrefix?: string;
  tokenCreatedAt?: string;
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
}

/** POST /api/feeds 建 MCP 订阅的请求体 */
export interface MCPFeedCreatePayload {
  title: string;
  folderId?: string;
  type?: ContentType;
  mcpConfig: MCPFeedConfig;
}
