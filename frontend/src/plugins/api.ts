import { request } from "@/api";
import type { PluginContribution, PluginMeta, PluginSettings } from "./types";

/**
 * 插件 API（55-8）。
 *
 * 约定：所有返回清单的接口都回 `{ plugins: [...] }`，这里统一摊平成数组，
 * 页面拿到新清单直接 setState —— 启停/重扫后不用再补一次 GET。
 */

/**
 * 后端 Go 侧的空 slice 会序列化成 `null`（`sections: null`），
 * 前端一律按「空数组」处理，别让页面里的 `.map/.length` 踩空。
 */
function normalize(item: PluginMeta): PluginMeta {
  return {
    ...item,
    actions: item.actions ?? [],
    sections: item.sections ?? [],
    lastError: item.lastError ?? "",
  };
}

function normalizeList(data: { plugins?: PluginMeta[] | null }): PluginMeta[] {
  return (data.plugins ?? []).map(normalize);
}

export function fetchPlugins(): Promise<PluginMeta[]> {
  return request<{ plugins: PluginMeta[] }>("/api/plugins").then(normalizeList);
}

export function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<PluginMeta[]> {
  return request<{ plugins: PluginMeta[] }>(`/api/plugins/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  }).then(normalizeList);
}

/** 读插件设置（secret 字段是掩码，不是明文） */
export function fetchPluginSettings(
  id: string,
): Promise<Record<string, string>> {
  return request<PluginSettings>(`/api/plugins/${id}/settings`).then(
    (data) => data.values ?? {},
  );
}

/** 写插件设置（值等于掩码 = 后端保持原值） */
export function savePluginSettings(
  id: string,
  values: Record<string, string>,
): Promise<Record<string, string>> {
  return request<PluginSettings>(`/api/plugins/${id}/settings`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  }).then((data) => data.values ?? {});
}

/** 让插件动作自己发一次测试（失败会抛 ApiError，页面上给红字） */
export function testPluginAction(id: string, actionId: string): Promise<void> {
  return request<{ status: number }>(
    `/api/plugins/${id}/actions/${actionId}/test`,
    { method: "POST" },
  ).then(() => undefined);
}

/**
 * 重新扫描插件目录（55-7b：外部插件的「安装」= 丢文件夹 + 等轮询，
 * 等不及就点这个 —— 后端 Catalog 链上会 ensureExternal）。
 */
export function rescanPlugins(): Promise<PluginMeta[]> {
  return request<{ plugins: PluginMeta[] }>("/api/plugins/rescan", {
    method: "POST",
  }).then(normalizeList);
}

/**
 * 界面贡献（56-4）：`{ surfaces: Record<Surface, Contribution[]> }`，按挂点分组。
 *
 * 一个插件停用后它的贡献项要从「所有挂点」里消失，所以这张表是全量的 ——
 * 钩子那边一次拉完、按 surface 切片，别让每个挂点各打一次请求。
 * 后端空 slice 同样会序列化成 `null`，这里统一摊成 `{}`。
 */
export function fetchPluginContributions(): Promise<
  Record<string, PluginContribution[]>
> {
  return request<{ surfaces?: Record<string, PluginContribution[]> | null }>(
    "/api/plugins/contributions",
  ).then((data) => data.surfaces ?? {});
}
