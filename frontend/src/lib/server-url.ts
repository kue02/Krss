/**
 * 自托管服务器基址：构建期由 VITE_API_URL 注入（App 里是 http://服务器:端口，网页里为空）。
 * 空串表示同源相对路径，行为与改动前完全一致。
 */
export const API_BASE_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

/** 把根相对路径（/api/...、/icons/...）拼到服务器基址上；绝对 URL、data:、blob: 原样返回。 */
export function apiUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  return `${API_BASE_URL}${path}`;
}
