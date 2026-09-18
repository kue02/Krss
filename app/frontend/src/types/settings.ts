import type { ContentType } from "./api";

export type AIProvider = "openai" | "anthropic" | "compatible";

export type RequestOptions = Record<string, unknown>;

/** 一份保存好的 AI 提供商配置 */
export interface AIProviderConfig {
  id: string;
  name: string;
  provider: AIProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  requestOptions?: RequestOptions | null;
}

export interface AISettings {
  provider: AIProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  requestOptions: RequestOptions;
  summaryLanguage: string;
  /** 翻译通道：空 = 用模型；google / youdao = 免 key 通道 */
  translateChannel: string;
  /** 免费通道失败时是否自动切回模型（默认开） */
  fallbackToModel: boolean;
  autoTranslate: boolean;
  autoSummary: boolean;
  rateLimit: number;
  /** 已保存的提供商列表；上面的 provider/apiKey/... 始终等于当前使用的那一份 */
  providers?: AIProviderConfig[];
  activeProviderId?: string;
}

export interface AITestRequest {
  provider: AIProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  requestOptions: RequestOptions;
}

export interface AITestResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface GeneralSettings {
  fallbackUserAgent: string;
  autoReadability: boolean;
  markReadOnScroll: boolean;
  /** RSSHub 适配：自有实例地址（如 https://rsshub.example.com） */
  rsshubBaseUrl: string;
  /** RSSHub 实例的 ACCESS_KEY（可选，会作为 key 参数写入地址） */
  rsshubAccessKey: string;
  /** 推送地址（Bark 兼容，形如 https://api.day.app/<你的 key>）；留空 = 不推送 */
  barkUrl: string;
}

export type ProxyType = "http" | "socks5";

export type IPStack = "default" | "ipv4" | "ipv6";

export interface NetworkSettings {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
  ipStack: IPStack;
}

export interface NetworkTestRequest {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface NetworkTestResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface DomainRateLimit {
  id: string;
  host: string;
  intervalSeconds: number;
}

export interface DomainRateLimitListResponse {
  items: DomainRateLimit[];
}

export interface AppearanceSettings {
  contentTypes: ContentType[];
}

/** 拉取设置（11-20）：定时频率 / 全局并发 / 同主机并发 / 单源超时 */
export interface FetchSettings {
  intervalMinutes: number;
  concurrency: number;
  perHostConcurrency: number;
  timeoutSeconds: number;
}
