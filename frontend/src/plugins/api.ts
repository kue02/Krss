import { ApiError, request } from "@/api";
import type {
  PluginContribution,
  PluginDecoration,
  PluginInvokeResult,
  PluginMeta,
  PluginSelection,
  PluginSettings,
  PluginView,
} from "./types";

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

/**
 * 卸载一个**外部**插件（56-35）：后端归档插件目录并清掉它的设置与数据，
 * 与 PATCH 一样回整份清单，页面拿到新清单直接 setState。
 *
 * 只对外部插件（`transport === "http"`）开放 —— 内置插件编译进二进制，卸载不了。
 * 路径参数 encodeURIComponent：插件 id 来自 manifest 文件名，可能带 `.` / 空格 / 中文。
 */
export function uninstallPlugin(id: string): Promise<PluginMeta[]> {
  return request<{ plugins: PluginMeta[] }>(
    `/api/plugins/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  ).then(normalizeList);
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

/**
 * 插件注册的视图（56-27 的后端接口，56-28 的视图切换器用）。
 *
 * `GET /api/plugins/views` 只含**已启用**插件，回 `{views: [...]}`；空时后端给 `[]`，
 * 但 Go 的空 slice 也可能序列化成 `null`（同 contributions），这里统一摊成 `[]`。
 */
export function fetchPluginViews(): Promise<PluginView[]> {
  return request<{ views?: PluginView[] | null }>("/api/plugins/views").then(
    (data) => data.views ?? [],
  );
}

/**
 * 调用插件动作（56-8）：`POST /api/plugins/:id/actions/:actionId/invoke`。
 *
 * 与 `/test` 的区别：`/test` 是设置页里「发一条测试」、只回状态码；这里带 `surface` +
 * `selection`，插件知道自己是在哪个挂点上、对哪几条条目/订阅被点的，返回值里还可能带
 * 「要刷新的前端缓存」(`refresh`)，由调用方的 hook 统一失效。
 *
 * 路径参数一律 encodeURIComponent：插件 id 来自 manifest 文件名，动作 id 来自插件代码，
 * 都可能带 `.` / 空格 / 中文，不转义会把路径拼断（后端路由按段匹配，断掉就是 404）。
 */
export function invokePluginAction(
  plugin: string,
  action: string,
  body: {
    surface: string;
    selection: PluginSelection;
    config?: Record<string, string>;
  },
): Promise<PluginInvokeResult> {
  return request<PluginInvokeResult>(
    `/api/plugins/${encodeURIComponent(plugin)}/actions/${encodeURIComponent(action)}/invoke`,
    { method: "POST", body: JSON.stringify(body) },
  ).then((data) => data ?? {});
}

/**
 * 插件专属数据（56-19 的接口，56-25 起由沙箱 bridge 调用）。
 *
 * 形状见后端 `plugin_handler.go` 的 ListPluginData / GetPluginData / PutPluginData：
 * 单键回 `{key, value}`、列举回 `{values: {键: 值}}`、值一律是不透明字符串
 * （插件自己序列化的 JSON，宿主不解析 —— 所以这里也不做 JSON.parse）。
 *
 * 路径参数一律 encodeURIComponent：`collection` 只允许 `[a-z0-9_-]`，但 `key` 可以是
 * 条目 id、URL、带斜杠的路径，不转义会把路径拼断（断掉就是 404 / 打到别的路由）。
 */
export function fetchPluginData(
  pluginId: string,
  collection: string,
  key: string,
): Promise<string> {
  return request<{ key: string; value: string }>(
    `/api/plugins/${encodeURIComponent(pluginId)}/data/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`,
  ).then((data) => data.value ?? "");
}

/** 写插件自己的一个键（同键再写 = 覆盖）；回写入后的值 */
export function putPluginData(
  pluginId: string,
  collection: string,
  key: string,
  value: string,
): Promise<string> {
  return request<{ key: string; value: string }>(
    `/api/plugins/${encodeURIComponent(pluginId)}/data/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`,
    { method: "PUT", body: JSON.stringify({ value }) },
  ).then((data) => data.value ?? value);
}

/** 列一个 collection 的键值（`prefix` 过滤、`limit` 上限 1000，留空用后端缺省） */
export function listPluginData(
  pluginId: string,
  collection: string,
  options: { prefix?: string; limit?: number } = {},
): Promise<Record<string, string>> {
  const query = new URLSearchParams();
  if (options.prefix) query.set("prefix", options.prefix);
  if (options.limit) query.set("limit", String(options.limit));
  const search = query.toString();
  const suffix = search ? `?${search}` : "";
  return request<{ values?: Record<string, string> | null }>(
    `/api/plugins/${encodeURIComponent(pluginId)}/data/${encodeURIComponent(collection)}${suffix}`,
  ).then((data) => data.values ?? {});
}

/** 删一个键（后端 404 说明本来就没有，这里当成功 —— 插件只关心「现在没有了」） */
export function deletePluginData(
  pluginId: string,
  collection: string,
  key: string,
): Promise<void> {
  return request<void>(
    `/api/plugins/${encodeURIComponent(pluginId)}/data/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`,
    { method: "DELETE" },
  )
    .then(() => undefined)
    .catch((error: unknown) => {
      // 404 = 这个键本来就没有；「删掉一个不存在的东西」的目标状态已经达成，不该让插件看到失败
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    });
}

/**
 * 某条目身上的正文装饰（56-22）：`{ decorations: [...] }`。
 *
 * 偏移是纯文本的 rune 下标，落到 DOM 上的活由 `components/reader/decorations.ts` 干。
 * 后端 Go 侧空 slice 会序列化成 `null`（没有插件画东西时就是 `{decorations: null}`），
 * 这里统一摊成 `[]` —— 调用方直接交给 `applyDecorations`，不用再判空。
 *
 * 路径参数 encodeURIComponent：条目 id 是 19 位数字串（不转数字，见 `PluginSelection` 的注释），
 * 转义只是照本文件既有做法统一一遍。
 */
export function fetchEntryDecorations(
  entryId: string,
): Promise<PluginDecoration[]> {
  return request<{ decorations?: PluginDecoration[] | null }>(
    `/api/entries/${encodeURIComponent(entryId)}/decorations`,
  ).then((data) => data.decorations ?? []);
}

/**
 * 把插件导出的文件写到「设置 → 通用 → 导出目录」（56-33）。
 *
 * 返回绝对路径；后端没配目录时抛错，调用方据此回落到浏览器下载 ——
 * 「写不写盘」取决于用户环境，前端不该自己拼路径。
 */
export function exportPluginFiles(
  files: { name: string; content: string }[],
): Promise<{ paths: string[] }> {
  return request<{ paths: string[] }>("/api/exports", {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}
