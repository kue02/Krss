import { useQuery } from "@tanstack/react-query";
import { fetchPluginContributions } from "./api";
import type { PluginContribution } from "./types";
import type { Surface } from "./surfaces";

/**
 * 插件界面贡献（56-4）。
 *
 * 契约：GET /api/plugins/contributions 回 `{ surfaces: Record<Surface, Contribution[]> }`。
 * 全量拉一次、按 surface 切片 —— 挂点有很多个（右键菜单、工具栏、阅读区、设置…），
 * 每个挂点各自请求会打成一堆重复请求，而且停用插件后还得逐个失效。
 */
export const PLUGIN_CONTRIBUTIONS_QUERY_KEY = ["pluginContributions"] as const;

/**
 * 后端 Contribution 里没有 `plugin` 字段（后端按 surface 分组时由宿主注入来源），
 * 所以这里对「没带 plugin 的项」只兜底成空串，**不猜**插件 id：
 * 猜错会让「停用某插件」的过滤逻辑误杀别家的贡献项。真拿不到就当作未知来源，
 * 由调用方决定要不要显示。
 */
function normalize(
  groups: Record<string, PluginContribution[] | null> | undefined,
): Record<string, PluginContribution[]> {
  const out: Record<string, PluginContribution[]> = {};
  for (const [surface, list] of Object.entries(groups ?? {})) {
    out[surface] = (list ?? []).map((item) => ({
      ...item,
      plugin: item.plugin ?? "",
      refresh: item.refresh ?? [],
    }));
  }
  return out;
}

/** 全量贡献表（一次拉完，挂点共享同一份缓存） */
export function usePluginContributions() {
  return useQuery({
    queryKey: PLUGIN_CONTRIBUTIONS_QUERY_KEY,
    queryFn: () => fetchPluginContributions().then(normalize),
    staleTime: 30_000,
  });
}

/**
 * 某个挂点上的贡献项。缺省 `[]`（不是 undefined）：挂点上直接 map 不会踩空，
 * 「这个挂点没人贡献」和「还在加载」在界面上都是空，不用各处再判一次。
 */
export function useContributions(surface: Surface): PluginContribution[] {
  const { data } = usePluginContributions();
  return data?.[surface] ?? [];
}
