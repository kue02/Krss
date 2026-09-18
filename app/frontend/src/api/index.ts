import type {
  ApiErrorResponse,
  ContentType,
  Entry,
  EntryListParams,
  EntryListResponse,
  Feed,
  FeedPreview,
  Folder,
  ImportTask,
  MarkAllReadParams,
  StarredCountResponse,
  ViewCountsResponse,
  UnreadCountsResponse,
} from "@/types/api";
import {
  LS_KEYS,
  readLocalValue,
  writeLocalValue,
  removeLocalValue,
} from "@/lib/settings-storage";
import type {
  AISettings,
  AITestRequest,
  AITestResponse,
  AppearanceSettings,
  DomainRateLimit,
  DomainRateLimitListResponse,
  GeneralSettings,
  NetworkSettings,
  NetworkTestRequest,
  NetworkTestResponse,
  FetchSettings,
  UISettingsResponse,
  UISettingsPayload,
  SettingsExportPayload,
  SettingsImportResponse,
} from "@/types/settings";
import type {
  FilterApplyHistoryResult,
  FilterDraft,
  FilterMatch,
  FilterPreviewResult,
  FilterRevertResult,
  FilterRule,
  FilterWritePayload,
  FilterImpactResult,
} from "@/types/filters";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "";
// 21 批：gist_auth_token → krss_auth_token（readLocalValue 会把老键的值搬过来，不掉登录）
const TOKEN_SPEC = LS_KEYS.authToken;

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function isErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== "object" || value === null) return false;
  if (!("error" in value)) return false;
  return typeof (value as { error: unknown }).error === "string";
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;

  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return text;
}

/**
 * Extract error message from response data
 */
function extractErrorMessage(data: unknown, fallback: string): string {
  if (isErrorResponse(data)) return data.error;
  if (typeof data === "string") return data;
  return fallback;
}

/**
 * Create headers with auth token
 */
function createAuthHeaders(): HeadersInit {
  const headers: HeadersInit = { "Content-Type": "application/json" };
  const token = getAuthToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Fetch with auth and error handling for streaming endpoints
 */
async function fetchWithAuth(
  url: string,
  options: RequestInit,
): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    headers: createAuthHeaders(),
  });

  if (!response.ok) {
    const data = await parseResponse(response);
    throw new ApiError(
      extractErrorMessage(data, response.statusText) || "Request failed",
      response.status,
    );
  }

  return response;
}

/**
 * Read NDJSON lines from a stream
 */
async function* readNDJSONLines<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) {
    throw new ApiError("No response body", 500);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            yield JSON.parse(line) as T;
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer) as T;
      } catch {
        // Ignore parse errors
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read SSE events from a stream
 */
async function* readSSEEvents<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) {
    throw new ApiError("No response body", 500);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            yield JSON.parse(line.slice(6)) as T;
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Token management
export function getAuthToken(): string | null {
  return readLocalValue(TOKEN_SPEC);
}

export function setAuthToken(token: string): void {
  writeLocalValue(TOKEN_SPEC, token);
}

export function clearAuthToken(): void {
  removeLocalValue(TOKEN_SPEC);
}

// Callback for handling 401 errors (set by auth store)
let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(callback: () => void): void {
  onUnauthorized = callback;
}

/**
 * 普通请求的兜底超时。
 *
 * 用户 2026-09-18 报的现象：推送地址坏了之后「整个软件都会卡死、刷新网页一直转圈」。
 * 后端实测是有超时的（外部调用 10s 断），所以更可能是**前端根本没有超时** ——
 * 只要有一个响应永不回来，界面就会一直转下去，而不是给出失败原因。
 * 这里给普通 JSON 请求加兜底；流式路径（AI 翻译/摘要、OPML 导出、正文抓取）走各自的 fetch，不受影响。
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** 合并「调用方自己的 signal」与兜底超时（浏览器不支持就退化成调用方的 signal） */
function withTimeout(existing?: AbortSignal | null): AbortSignal | undefined {
  const timeout =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;
  if (!timeout) return existing ?? undefined;
  if (!existing) return timeout;
  return typeof AbortSignal.any === "function"
    ? AbortSignal.any([existing, timeout])
    : existing;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  const headers = new Headers(options.headers);
  const body = options.body;

  if (body && !(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // Add auth token if available
  const token = getAuthToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      signal: withTimeout(options.signal),
    });
  } catch (error) {
    // 超时要给一句人能看懂的失败原因（别让界面永远转圈）
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ApiError(
        `请求超时：${REQUEST_TIMEOUT_MS / 1000} 秒内没有响应（后端可能正卡在某个外部依赖上）`,
        0,
      );
    }
    throw error;
  }

  const data = await parseResponse(response);
  if (!response.ok) {
    // Handle 401 Unauthorized
    if (response.status === 401 && onUnauthorized) {
      onUnauthorized();
    }

    const message = isErrorResponse(data)
      ? data.error
      : typeof data === "string"
        ? data
        : response.statusText;
    throw new ApiError(message || "Request failed", response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return data as T;
}

// Auth API types
export interface AuthUser {
  username: string;
  nickname: string;
  email: string;
  avatarUrl: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface AuthStatusResponse {
  exists: boolean;
}

// Auth API functions
export async function checkAuthStatus(): Promise<AuthStatusResponse> {
  return request<AuthStatusResponse>("/api/auth/status");
}

export async function register(
  username: string,
  nickname: string,
  email: string,
  password: string,
): Promise<AuthResponse> {
  return request<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, nickname, email, password }),
  });
}

export async function login(
  identifier: string,
  password: string,
): Promise<AuthResponse> {
  return request<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier, password }),
  });
}

export async function getCurrentUser(): Promise<AuthUser> {
  return request<AuthUser>("/api/auth/me");
}

export async function logout(): Promise<void> {
  return request<void>("/api/auth/logout", {
    method: "POST",
  });
}

export interface UpdateProfileRequest {
  nickname?: string;
  email?: string;
  currentPassword?: string;
  newPassword?: string;
  /** 头像：不传 = 不动；空串 = 恢复默认（Gravatar）；其余 = 自定义地址（本地图片前端会压成 data URL） */
  avatarUrl?: string;
}

export interface UpdateProfileResponse {
  user: AuthUser;
  token?: string;
}

export async function updateProfile(
  data: UpdateProfileRequest,
): Promise<UpdateProfileResponse> {
  return request<UpdateProfileResponse>("/api/auth/profile", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function listFolders(): Promise<Folder[]> {
  return request<Folder[]>("/api/folders");
}

export async function createFolder(payload: {
  name: string;
  parentId?: string;
  type?: ContentType;
}): Promise<Folder> {
  return request<Folder>("/api/folders", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateFolder(
  id: string,
  payload: { name: string; parentId?: string },
): Promise<Folder> {
  return request<Folder>(`/api/folders/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteFolder(id: string): Promise<void> {
  return request<void>(`/api/folders/${id}`, {
    method: "DELETE",
  });
}

export async function updateFolderType(
  id: string,
  type: ContentType,
): Promise<void> {
  return request<void>(`/api/folders/${id}/type`, {
    method: "PATCH",
    body: JSON.stringify({ type }),
  });
}

export async function deleteFolders(ids: string[]): Promise<void> {
  return request<void>("/api/folders", {
    method: "DELETE",
    body: JSON.stringify({ ids }),
  });
}

export async function listFeeds(folderId?: string): Promise<Feed[]> {
  const params =
    folderId === undefined ? "" : `?folderId=${encodeURIComponent(folderId)}`;
  return request<Feed[]>(`/api/feeds${params}`);
}

export async function createFeed(payload: {
  url: string;
  folderId?: string;
  title?: string;
  type?: ContentType;
}): Promise<Feed> {
  return request<Feed>("/api/feeds", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateFeed(
  id: string,
  payload: { title: string; folderId?: string; summaryPromptReminder?: string },
): Promise<Feed> {
  return request<Feed>(`/api/feeds/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteFeed(id: string): Promise<void> {
  return request<void>(`/api/feeds/${id}`, {
    method: "DELETE",
  });
}

/** 订阅级覆盖自动翻译/自动摘要（传 null 表示跟随全局） */
export async function updateFeedAI(
  id: string,
  payload: {
    autoTranslate?: boolean | null;
    autoSummary?: boolean | null;
    readerMode?: boolean | null;
  },
): Promise<Feed> {
  return request<Feed>(`/api/feeds/${id}/ai`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

/** 合并前的一侧：这个订阅有几条、几条星标（给确认弹框显示「两边各有几条」） */
export interface FeedMergeSide {
  id: string;
  title: string;
  entries: number;
  starred: number;
}

/** 合并预览：把 sourceId 换成 url 时，目标地址属于哪个订阅（null = 没撞车） */
export interface FeedMergePreview {
  source: FeedMergeSide;
  target: FeedMergeSide | null;
}

/**
 * 合并预览（RSSHub 换实例后两个订阅撞成同一地址时用）。
 *
 * 前端在换地址**之前**探一次，撞上就弹「确认合并」；不撞车才直接 PATCH。
 * 后端 PATCH 那边也有 409 兜底，两条路都能兜住。
 */
export async function getFeedMergePreview(
  sourceId: string,
  url: string,
): Promise<FeedMergePreview> {
  return request<FeedMergePreview>(
    `/api/feeds/merge-preview?sourceId=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(url)}`,
  );
}

/** 把一个订阅并入另一个：保留 target，source 的条目/星标/分类并过去，然后 source 被删掉 */
export async function mergeFeed(
  sourceId: string,
  targetId: string,
): Promise<{ targetId: string; movedEntries: number; dedupedEntries: number }> {
  return request<{ targetId: string; movedEntries: number; dedupedEntries: number }>(
    `/api/feeds/${sourceId}/merge`,
    { method: "POST", body: JSON.stringify({ targetId }) },
  );
}

/** 改订阅地址（RSSHub 换实例域名等；只改地址，不动标题/文件夹） */
export async function updateFeedUrl(id: string, url: string): Promise<Feed> {
  return request<Feed>(`/api/feeds/${id}/url`, {
    method: "PATCH",
    body: JSON.stringify({ url }),
  });
}

export async function updateFeedType(
  id: string,
  type: ContentType,
): Promise<void> {
  return request<void>(`/api/feeds/${id}/type`, {
    method: "PATCH",
    body: JSON.stringify({ type }),
  });
}

export async function deleteFeeds(ids: string[]): Promise<void> {
  return request<void>("/api/feeds", {
    method: "DELETE",
    body: JSON.stringify({ ids }),
  });
}

/**
 * 刷新全部订阅。force = 强制拉取（用户 11-19）：忽略 etag/last-modified 与
 * 「同主机多久内不重复抓」的等待，整轮重抓。
 */
export async function refreshAllFeeds(force = false): Promise<void> {
  return request<void>("/api/feeds/refresh", {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}

/** 只刷新指定订阅（按文件夹 / 单个源 / 某个视图刷新都用它） */
export async function refreshFeeds(
  ids: (string | number)[],
  force = false,
): Promise<void> {
  return request<void>("/api/feeds/refresh", {
    method: "POST",
    body: JSON.stringify({ feedIds: ids.map(String), force }),
  });
}

export interface RefreshStatus {
  isRefreshing: boolean;
  lastRefreshedAt?: string;
  /** 本次刷新要刷的源数（仅刷新中返回） */
  total?: number;
  /** 最近一轮刷新是谁触发的：manual（手动）/ auto（定时器）—— 12-17 */
  trigger?: "manual" | "auto";
  /** 本次刷新已完成数（仅刷新中返回） */
  completed?: number;
  /**
   * 最近一轮刷新里每个订阅的结果（用户 11-8：刷新完要告诉用户「一共更新了多少条」并能看明细）。
   * 后端只在刷新结束后带上（刷新中不带）。
   */
  results?: RefreshFeedResult[];
}

/** 单个订阅在一次刷新里的结果 */
export interface RefreshFeedResult {
  feedId: string;
  title: string;
  iconPath?: string;
  new: number;
  updated: number;
  error?: string;
}

export async function getRefreshStatus(): Promise<RefreshStatus> {
  return request<RefreshStatus>("/api/feeds/refresh");
}

/**
 * 关键词检索条目（标题/正文/作者/链接），搜索弹窗用。
 * 后端走子串匹配而不是 FTS5 —— unicode61 分词下中文只能从词首前缀命中，不可用。
 */
export async function searchEntries(
  query: string,
  limit = 30,
): Promise<EntryListResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return request<EntryListResponse>(`/api/entries/search?${params.toString()}`);
}

export async function previewFeed(url: string): Promise<FeedPreview> {
  const params = new URLSearchParams({ url });
  return request<FeedPreview>(`/api/feeds/preview?${params.toString()}`);
}

export async function listEntries(
  params: EntryListParams = {},
): Promise<EntryListResponse> {
  const searchParams = new URLSearchParams();

  if (params.feedId !== undefined) {
    searchParams.set("feedId", String(params.feedId));
  }
  if (params.folderId !== undefined) {
    searchParams.set("folderId", String(params.folderId));
  }
  if (params.viewId !== undefined) {
    searchParams.set("viewId", String(params.viewId));
  }
  if (params.contentType !== undefined) {
    searchParams.set("contentType", params.contentType);
  }
  if (params.unreadOnly) {
    searchParams.set("unreadOnly", "true");
  }
  if (params.starredOnly) {
    searchParams.set("starredOnly", "true");
  }
  if (params.hasThumbnail) {
    searchParams.set("hasThumbnail", "true");
  }
  if (params.includeMuted) {
    searchParams.set("includeMuted", "true");
  }
  if (params.mutedOnly) {
    searchParams.set("mutedOnly", "true");
  }
  if (params.limit !== undefined) {
    searchParams.set("limit", String(params.limit));
  }
  if (params.offset !== undefined) {
    searchParams.set("offset", String(params.offset));
  }

  const queryString = searchParams.toString();
  const path = queryString ? `/api/entries?${queryString}` : "/api/entries";
  return request<EntryListResponse>(path);
}

export async function getEntry(id: string): Promise<Entry> {
  return request<Entry>(`/api/entries/${id}`);
}

export async function updateEntryReadStatus(
  id: string,
  read: boolean,
): Promise<void> {
  return request<void>(`/api/entries/${id}/read`, {
    method: "PATCH",
    body: JSON.stringify({ read }),
  });
}

export async function updateManyEntryReadStatus(
  ids: string[],
  read: boolean,
): Promise<void> {
  return request<void>("/api/entries/read", {
    method: "PATCH",
    body: JSON.stringify({ ids, read }),
  });
}

export async function fetchReadableContent(id: string): Promise<string> {
  const response = await request<{ readableContent: string }>(
    `/api/entries/${id}/fetch-readable`,
    {
      method: "POST",
    },
  );
  return response.readableContent;
}

export async function markAllAsRead(params: MarkAllReadParams): Promise<void> {
  return request<void>("/api/entries/mark-read", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function getUnreadCounts(): Promise<UnreadCountsResponse> {
  return request<UnreadCountsResponse>("/api/unread-counts");
}

export async function updateEntryStarred(
  id: string,
  starred: boolean,
): Promise<void> {
  return request<void>(`/api/entries/${id}/starred`, {
    method: "PATCH",
    body: JSON.stringify({ starred }),
  });
}

export async function getStarredCount(
  contentType?: ContentType,
): Promise<StarredCountResponse> {
  // contentType：侧栏「只显示当前内容类型的星标」那一档的数
  const query = contentType ? `?contentType=${encodeURIComponent(contentType)}` : "";
  return request<StarredCountResponse>(`/api/starred-count${query}`);
}

/**
 * 每条保存视图当前命中的条目数（侧栏「视图」那一段的数量角标）。
 * 后端一次扫描算出全部视图的数，所以侧栏只发一个请求。
 */
export async function getViewCounts(
  contentType?: ContentType,
): Promise<ViewCountsResponse> {
  const query = contentType ? `?contentType=${encodeURIComponent(contentType)}` : "";
  return request<ViewCountsResponse>(`/api/filters/view-counts${query}`);
}

/**
 * 取消单条条目的静音 —— 规则写上去的标记由用户手动反悔：
 * 清掉 muted/filter_id，并让这条回到未读流里。
 */
export async function unmuteEntry(id: string): Promise<void> {
  return request<void>(`/api/entries/${id}/unmute`, { method: "POST" });
}

export async function startImportOPML(file: File): Promise<void> {
  const formData = new FormData();
  formData.append("file", file);

  const url = `${API_BASE_URL}/api/opml/import`;
  const headers: HeadersInit = {};
  const token = getAuthToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(text || "Import failed", response.status);
  }
}

export async function cancelImportOPML(): Promise<boolean> {
  const result = await request<{ cancelled: boolean }>("/api/opml/import", {
    method: "DELETE",
  });
  return result.cancelled;
}

export function watchImportStatus(
  onUpdate: (task: ImportTask) => void,
): () => void {
  const url = `${API_BASE_URL}/api/opml/import/status`;
  let cancelled = false;

  const connect = async () => {
    try {
      const headers: HeadersInit = {};
      const token = getAuthToken();
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const response = await fetch(url, { headers });
      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const task = JSON.parse(line.slice(6)) as ImportTask;
              onUpdate(task);

              // Stop if done, error, or cancelled
              if (
                task.status === "done" ||
                task.status === "error" ||
                task.status === "cancelled"
              ) {
                cancelled = true;
                reader.cancel();
                return;
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    } catch {
      // connection error, ignore
    }
  };

  connect();

  return () => {
    cancelled = true;
  };
}

export async function exportOPML(): Promise<void> {
  const headers: HeadersInit = {};
  const token = getAuthToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}/api/opml/export`, { headers });
  if (!response.ok) {
    throw new ApiError("Export failed", response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "gist.opml";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function getAISettings(): Promise<AISettings> {
  return request<AISettings>("/api/settings/ai");
}

export async function updateAISettings(
  settings: AISettings,
): Promise<AISettings> {
  return request<AISettings>("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function testAIConnection(
  config: AITestRequest,
): Promise<AITestResponse> {
  return request<AITestResponse>("/api/settings/ai/test", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

/** 探测提供商可用模型（设置页的「探测模型」） */
export async function listAIModels(config: {
  provider: string;
  apiKey: string;
  baseUrl: string;
}): Promise<{ models: string[] }> {
  return request<{ models: string[] }>("/api/settings/ai/models", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

/**
 * 发一条测试推送（设置 → 通用 的「发送测试推送」按钮）。
 *
 * 走的是与自动化规则「推送到手机」完全相同的那条通道，所以它通了就说明地址、代理、出网都对。
 * 没配地址后端回 400，投递失败回 502 并带上下游的原话（失败要给可见原因）。
 */
export async function testNotify(): Promise<{ status: number }> {
  return request<{ status: number }>("/api/notify/test", { method: "POST" });
}

export async function getGeneralSettings(): Promise<GeneralSettings> {
  return request<GeneralSettings>("/api/settings/general");
}

export async function updateGeneralSettings(
  settings: GeneralSettings,
): Promise<GeneralSettings> {
  return request<GeneralSettings>("/api/settings/general", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function getNetworkSettings(): Promise<NetworkSettings> {
  return request<NetworkSettings>("/api/settings/network");
}

export async function updateNetworkSettings(
  settings: NetworkSettings,
): Promise<NetworkSettings> {
  return request<NetworkSettings>("/api/settings/network", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function getAppearanceSettings(): Promise<AppearanceSettings> {
  return request<AppearanceSettings>("/api/settings/appearance");
}

export async function updateAppearanceSettings(
  settings: AppearanceSettings,
): Promise<AppearanceSettings> {
  return request<AppearanceSettings>("/api/settings/appearance", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function testNetworkProxy(
  config: NetworkTestRequest,
): Promise<NetworkTestResponse> {
  return request<NetworkTestResponse>("/api/settings/network/test", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export interface SummarizeRequest {
  entryId: string;
  content: string;
  title?: string;
  isReadability?: boolean;
}

export interface SummarizeResponse {
  summary: string;
  cached: boolean;
}

export async function* streamSummary(
  req: SummarizeRequest,
  signal?: AbortSignal,
): AsyncGenerator<string | { cached: true; summary: string }> {
  const url = `${API_BASE_URL}/api/ai/summarize`;
  const response = await fetchWithAuth(url, {
    method: "POST",
    body: JSON.stringify(req),
    signal,
  });

  const contentType = response.headers.get("Content-Type") ?? "";

  // If cached, returns JSON
  if (contentType.includes("application/json")) {
    const data = (await response.json()) as SummarizeResponse;
    yield { cached: true, summary: data.summary };
    return;
  }

  // Otherwise, stream the response
  if (!response.body) {
    throw new ApiError("No response body", 500);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (text) {
        yield text;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface TranslateRequest {
  entryId: string;
  content: string;
  title?: string;
  isReadability?: boolean;
}

export interface TranslateResponse {
  content: string;
  cached: boolean;
}

export interface TranslateBlockData {
  index: number;
  html: string;
  needTranslate: boolean;
}

export interface TranslateInit {
  blocks: TranslateBlockData[];
}

export interface TranslateBlockResult {
  index: number;
  html: string;
  /** 这一段是免费通道失败后由模型兜底译出来的 */
  fallback?: boolean;
}

export interface TranslateDone {
  done: true;
}

export interface TranslateError {
  error: string;
}

export type TranslateEvent =
  | TranslateInit
  | TranslateBlockResult
  | TranslateDone
  | TranslateError;

function isTranslateInit(event: TranslateEvent): event is TranslateInit {
  return "blocks" in event && Array.isArray(event.blocks);
}

function isTranslateBlockResult(
  event: TranslateEvent,
): event is TranslateBlockResult {
  return "index" in event && "html" in event && !("blocks" in event);
}

function isTranslateDone(event: TranslateEvent): event is TranslateDone {
  return "done" in event && event.done === true;
}

function isTranslateError(event: TranslateEvent): event is TranslateError {
  return "error" in event;
}

export async function* streamTranslateBlocks(
  req: TranslateRequest,
  signal?: AbortSignal,
): AsyncGenerator<TranslateEvent | { cached: true; content: string }> {
  const url = `${API_BASE_URL}/api/ai/translate`;
  const response = await fetchWithAuth(url, {
    method: "POST",
    body: JSON.stringify(req),
    signal,
  });

  const contentType = response.headers.get("Content-Type") ?? "";

  // Cached response returns JSON
  if (contentType.includes("application/json")) {
    const data = (await response.json()) as TranslateResponse;
    yield { cached: true, content: data.content };
    return;
  }

  // SSE stream
  yield* readSSEEvents<TranslateEvent>(response);
}

// Re-export type guards for use in components
export {
  isTranslateInit,
  isTranslateBlockResult,
  isTranslateDone,
  isTranslateError,
};

// Keep the old function for backwards compatibility (returns full content)
export async function translateContent(
  req: TranslateRequest,
  signal?: AbortSignal,
): Promise<TranslateResponse> {
  return request<TranslateResponse>("/api/ai/translate", {
    method: "POST",
    body: JSON.stringify(req),
    signal,
  });
}

// Batch translation types
export interface BatchTranslateArticle {
  id: string;
  title: string;
  summary: string;
}

export interface BatchTranslateResult {
  id: string;
  title: string | null;
  summary: string | null;
  cached?: boolean;
}

/**
 * Stream batch translation results using NDJSON format.
 * Each line is a JSON object with the translation result.
 */
export async function* streamBatchTranslate(
  articles: BatchTranslateArticle[],
  signal?: AbortSignal,
): AsyncGenerator<BatchTranslateResult> {
  const url = `${API_BASE_URL}/api/ai/translate/batch`;
  const response = await fetchWithAuth(url, {
    method: "POST",
    body: JSON.stringify({ articles }),
    signal,
  });

  yield* readNDJSONLines<BatchTranslateResult>(response);
}

export interface ClearAICacheResponse {
  summaries: number;
  translations: number;
  listTranslations: number;
}

export async function clearAICache(): Promise<ClearAICacheResponse> {
  return request<ClearAICacheResponse>("/api/ai/cache", {
    method: "DELETE",
  });
}

export interface ClearCacheResponse {
  deleted: number;
}

export async function clearAnubisCookies(): Promise<ClearCacheResponse> {
  return request<ClearCacheResponse>("/api/settings/anubis-cookies", {
    method: "DELETE",
  });
}

export async function clearIconCache(): Promise<ClearCacheResponse> {
  return request<ClearCacheResponse>("/api/icons/cache", {
    method: "DELETE",
  });
}

export async function clearReadabilityCache(): Promise<ClearCacheResponse> {
  return request<ClearCacheResponse>("/api/entries/readability-cache", {
    method: "DELETE",
  });
}

export async function clearEntryCache(): Promise<ClearCacheResponse> {
  return request<ClearCacheResponse>("/api/entries/cache", {
    method: "DELETE",
  });
}

// Domain Rate Limit API

export async function getDomainRateLimits(): Promise<DomainRateLimitListResponse> {
  return request<DomainRateLimitListResponse>("/api/domain-rate-limits");
}

export async function createDomainRateLimit(
  host: string,
  intervalSeconds: number,
): Promise<DomainRateLimit> {
  return request<DomainRateLimit>("/api/domain-rate-limits", {
    method: "POST",
    body: JSON.stringify({ host, intervalSeconds }),
  });
}

export async function updateDomainRateLimit(
  host: string,
  intervalSeconds: number,
): Promise<DomainRateLimit> {
  return request<DomainRateLimit>(
    `/api/domain-rate-limits/${encodeURIComponent(host)}`,
    {
      method: "PUT",
      body: JSON.stringify({ intervalSeconds }),
    },
  );
}

export async function deleteDomainRateLimit(host: string): Promise<void> {
  return request<void>(`/api/domain-rate-limits/${encodeURIComponent(host)}`, {
    method: "DELETE",
  });
}

// —— 过滤规则（自动化） ——
// 规则挂在抓取入库之后执行：只对刚入库的新条目生效，只改条目上的标记。
// 想对老条目生效用 preview 看清影响后再手动处理（本项目默认不回溯）。

export async function listFilters(): Promise<FilterRule[]> {
  const data = await request<{ filters: FilterRule[] | null }>("/api/filters");
  return data.filters ?? [];
}

export async function createFilter(
  payload: FilterWritePayload,
): Promise<FilterRule> {
  return request<FilterRule>("/api/filters", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateFilter(
  id: string,
  payload: FilterWritePayload,
): Promise<FilterRule> {
  return request<FilterRule>(`/api/filters/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

/** revert=true 时顺带把这条规则静音过的条目恢复未读 */
export async function deleteFilter(
  id: string,
  revert = false,
): Promise<FilterRevertResult> {
  const query = revert ? "?revert=true" : "";
  return request<FilterRevertResult>(`/api/filters/${id}${query}`, {
    method: "DELETE",
  });
}

/** 干跑：不写任何数据，只回答「会命中哪些、会影响多少条」 */
export async function previewFilter(
  payload: FilterWritePayload,
  limit = 200,
): Promise<FilterPreviewResult> {
  return request<FilterPreviewResult>(`/api/filters/preview?limit=${limit}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * 撤销规则影响。options.entryIds 为空 = 全部（老行为）；
 * includeStarred 时连「规则当初加过的星」一起撤（用户 11-23 / 11-3）。
 */
export async function revertFilter(
  id: string,
  options: { entryIds?: string[]; includeStarred?: boolean } = {},
): Promise<FilterRevertResult> {
  return request<FilterRevertResult>(`/api/filters/${id}/revert`, {
    method: "POST",
    body: JSON.stringify({
      entryIds: options.entryIds ?? [],
      includeStarred: options.includeStarred ?? false,
    }),
  });
}

/** 撤销前的影响清单（列出这条规则当前还管着哪些条目）。 */
export async function getFilterImpact(
  id: string,
  limit = 5000,
): Promise<FilterImpactResult> {
  return request<FilterImpactResult>(
    `/api/filters/${id}/impact?limit=${limit}`,
  );
}

/** 拉取设置（11-20）：定时频率 / 全局并发 / 同主机并发 / 单源超时 */
export async function getFetchSettings(): Promise<FetchSettings> {
  return request<FetchSettings>("/api/settings/fetch");
}

/** 只传要改的字段（>0 生效）；越界会被后端夹到合法区间。下一轮刷新生效。 */
export async function updateFetchSettings(
  payload: Partial<FetchSettings>,
): Promise<FetchSettings> {
  return request<FetchSettings>("/api/settings/fetch", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

/**
 * 手动回溯：把规则链补跑到这条规则作用域内的历史条目上。
 * 语义与增量一致（首个命中即停）且幂等 —— 已归同一条规则管的条目会跳过。
 */
export async function applyFilterToHistory(
  id: string,
  limit = 500,
): Promise<FilterApplyHistoryResult> {
  return request<FilterApplyHistoryResult>(
    `/api/filters/${id}/apply?limit=${limit}`,
    { method: "POST" },
  );
}

export async function listFilterMatches(
  id: string,
  limit = 50,
): Promise<FilterMatch[]> {
  const data = await request<{ matches: FilterMatch[] | null }>(
    `/api/filters/${id}/matches?limit=${limit}`,
  );
  return data.matches ?? [];
}

/**
 * 自然语言建规则：把人话交给后端 → 模型 → 规则草稿（**不落库**）。
 * 草稿由调用方填进编辑器，用户确认后走常规 createFilter 保存。
 */
export async function parseFilterNaturalLanguage(
  text: string,
): Promise<FilterDraft> {
  return request<FilterDraft>("/api/filters/parse", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

/**
 * 条目级「豁免这类内容」：把误伤转成一条顺序最靠前、只做反向动作的例外规则，
 * 并立刻把这一条放回未读流。
 */
export async function createFilterException(
  entryId: string,
): Promise<FilterRule> {
  return request<FilterRule>("/api/filters/exception", {
    method: "POST",
    body: JSON.stringify({ entryId }),
  });
}

// ---------- 21 批（2026-09-18）：界面设置整包 + 设置导出/导入 ----------

/**
 * 读界面设置整包。`empty=true` 表示服务端一条都没存过 —— 调用方据此决定
 * 「把本地这份当基线推上去（首次迁移）」还是「以服务端为准覆盖本地」。
 */
export async function getUISettings(): Promise<UISettingsResponse> {
  return request<UISettingsResponse>("/api/settings/ui");
}

/** 写界面设置整包：只写传进来的项（服务端对缺省项不动），四组由后端一次事务落库。 */
export async function putUISettings(
  payload: UISettingsPayload,
): Promise<UISettingsResponse> {
  return request<UISettingsResponse>("/api/settings/ui", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

/** 导出设置（凭证类不进文件，被排除的键名在 excludedKeys 里）。 */
export async function exportSettings(): Promise<SettingsExportPayload> {
  return request<SettingsExportPayload>("/api/settings/export");
}

/** 导入设置：只接受白名单键，出现别的键后端会 400 并把键名带回来。 */
export async function importSettings(
  payload: Pick<SettingsExportPayload, "version" | "settings">,
): Promise<SettingsImportResponse> {
  return request<SettingsImportResponse>("/api/settings/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
