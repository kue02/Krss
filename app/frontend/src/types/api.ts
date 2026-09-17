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
  iconPath?: string;
  type: ContentType;
  etag?: string;
  lastModified?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
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
