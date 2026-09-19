import type { MCPFeedConfig } from "@/types/mcp";

export type ContentType = "article" | "picture" | "notification" | "social";


export interface Folder {
  id: string;
  name: string;
  parentId?: string;
  type: ContentType;
  createdAt: string;
  updatedAt: string;
}

export interface Feed {
  id: string;
  folderId?: string;
  title: string;
  url: string;
  siteUrl?: string;
  description?: string;
  summaryPromptReminder?: string;
  /** 订阅级覆盖：null/undefined = 跟随全局设置 */
  autoTranslate?: boolean | null;
  autoSummary?: boolean | null;
  /** 正文打开方式：true=阅读模式 false=原文 空=跟随全局（订阅级覆盖） */
  readerMode?: boolean | null;
  /** 代理覆盖（14 批）：inherit = 跟随文件夹链 → 全局 / proxy = 走代理 / direct = 直连 */
  proxyMode?: ProxyMode;
  /** 订阅单独指定的一套代理（密码是掩码）；缺省 = 用全局那套 */
  proxyConfig?: ProxyOverrideConfig | null;
  iconPath?: string;
  type: ContentType;
  etag?: string;
  lastModified?: string;
  errorMessage?: string;
  /** 取数方式：rss（默认）/ mcp（MCP 工具或资源物化成条目） */
  sourceType?: "rss" | "mcp";
  /** MCP 源的取数配置（连接 id + 工具/资源 + 参数 + 字段映射 + 去重键）；rss 源为空 */
  mcpConfig?: MCPFeedConfig;
  createdAt: string;
  updatedAt: string;
}

// ---------- 14 批：代理按来源生效 ----------

/** 三态：跟随上级 / 走代理 / 直连 */
export type ProxyMode = "inherit" | "proxy" | "direct";

/** 某一层单独指定的一套代理（密码在接口返回里一律是掩码） */
export interface ProxyOverrideConfig {
  type: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** 实际生效结果：决定它的那一层（feed/folder/global）与档位 */
export interface ProxyEffective {
  mode: "proxy" | "direct";
  source: "feed" | "folder" | "global";
  sourceId?: string;
  sourceName?: string;
  /** 选了「走代理」但拿不到可用地址（全局没配/单独指定没填全）→ 实际直连 */
  missing?: boolean;
}

export interface ProxyOverrideView {
  mode: ProxyMode;
  config?: ProxyOverrideConfig | null;
}

export interface ProxyFolderSource {
  id: string;
  parentId?: string;
  name: string;
  type: ContentType;
  /** 直接挂在这个文件夹下的订阅数 */
  feedCount: number;
  override: ProxyOverrideView;
  effective: ProxyEffective;
}

export interface ProxyFeedSource {
  id: string;
  folderId?: string;
  title: string;
  type: ContentType;
  iconPath?: string;
  override: ProxyOverrideView;
  effective: ProxyEffective;
}

export interface ProxyGlobalConfig {
  enabled: boolean;
  type: "http" | "socks5";
  host: string;
  port: number;
  username: string;
  /** 掩码 */
  password: string;
  ipStack?: string;
}

export interface ProxySourceOverview {
  global: ProxyGlobalConfig;
  folders: ProxyFolderSource[];
  feeds: ProxyFeedSource[];
  counts: {
    folders: number;
    feeds: number;
    proxiedFeeds: number;
    globalEnabled: boolean;
  };
}

export interface FeedProxyResponse {
  feed: Feed;
  effective: ProxyEffective;
}

export interface FolderProxyResponse {
  folder: Folder & {
    proxyMode: ProxyMode;
    proxyConfig?: ProxyOverrideConfig | null;
  };
  effective: ProxyEffective;
}

export interface ProxyOverridePayload {
  mode?: ProxyMode;
  /** null = 清掉「单独指定」那套；不传 = 不动 */
  config?: ProxyOverrideConfig | null;
}

export interface FeedPreviewEntry {
  title?: string;
  url?: string;
  content?: string;
  thumbnailUrl?: string;
  author?: string;
  publishedAt?: string;
}

export interface FeedPreview {
  url: string;
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  itemCount?: number;
  lastUpdated?: string;
  /** 订阅前试看的前几条条目（不落库），用于按所选视图渲染真实效果 */
  entries?: FeedPreviewEntry[];
}

export interface Entry {
  id: string;
  feedId: string;
  title?: string;
  url?: string;
  content?: string;
  readableContent?: string;
  thumbnailUrl?: string;
  author?: string;
  publishedAt?: string;
  read: boolean;
  starred: boolean;
  /** 被过滤规则静音：列表默认隐藏，可在「已静音」里回看、可撤销 */
  muted: boolean;
  /** 最后命中这条条目的规则 ID（用于显示「已静音 · 规则名」） */
  filterId?: string;
  /** 规则动作 translate/summarize 打的条目级标记：打开这条时自动翻译 / 自动摘要 */
  autoTranslate?: boolean;
  autoSummary?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EntryListResponse {
  entries: Entry[];
  hasMore: boolean;
}

export interface EntryListParams {
  feedId?: string;
  folderId?: string;
  contentType?: ContentType;
  /** 按「保存筛选视图」取条目（作用域与条件都在视图里） */
  viewId?: string;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  hasThumbnail?: boolean;
  /** 连被规则静音的条目一起列出（默认隐藏） */
  includeMuted?: boolean;
  /** 只看被规则静音的条目 */
  mutedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface UnreadCountsResponse {
  counts: Record<string, number>;
}

/** 视图 id（字符串化）→ 该视图当前命中的条目数（GET /api/filters/view-counts）。 */
export interface ViewCountsResponse {
  counts: Record<string, number>;
}

export interface StarredCountResponse {
  count: number;
}

export interface MarkAllReadParams {
  feedId?: string;
  folderId?: string;
  contentType?: ContentType;
}

export interface ApiErrorResponse {
  error: string;
}

export interface ImportResult {
  foldersCreated: number;
  foldersSkipped: number;
  feedsCreated: number;
  feedsSkipped: number;
}

export interface ImportTask {
  id?: string;
  status: "idle" | "running" | "done" | "error" | "cancelled";
  total: number;
  current: number;
  feed?: string;
  result?: ImportResult;
  error?: string;
  createdAt?: string;
}
