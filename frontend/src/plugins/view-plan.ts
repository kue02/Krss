import type { ContentType, Entry, EntryListParams } from "@/types/api";
import type { PluginView } from "./types";

/**
 * 声明式插件视图的「取数翻译层」（56-28）。
 *
 * 插件（56-27）只声明 `query`，不碰接口：把 `feedIds / types / unread / starred /
 * search / sort` 翻成宿主现有的取数参数是宿主的活。放在 .ts 里而不是组件文件里，
 * 一是这些是纯函数、可以单独验，二是 react-refresh 只允许组件文件导出组件。
 */

export type PluginViewLayout = "list" | "grid" | "timeline";

/**
 * `layout` → 宿主的三种版式。
 *
 * `grid` 是「同一张卡片铺成网格」（宿主没有专门的卡片网格版式，条目行本身可复用）；
 * 认不出的值一律按 `list` —— 插件写错一个词不该让视图打不开。
 */
export function resolvePluginViewLayout(layout?: string): PluginViewLayout {
  if (layout === "grid" || layout === "timeline") return layout;
  return "list";
}

const CONTENT_TYPES: readonly ContentType[] = [
  "article",
  "picture",
  "notification",
  "social",
];

export function isContentType(value: string): value is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(value);
}

export type PluginViewFetchPlan = {
  /** 条目接口的参数（`/api/entries` 的既有入参） */
  params: Omit<EntryListParams, "limit" | "offset">;
  /**
   * `/api/entries` 只认**单个** feedId / contentType（后端是 `c.QueryParam`）。
   * 插件声明了多个时接口层表达不了：取回这一页后在前端按集合过滤 ——
   * 宁可少几条也不假装「支持多选」（不做静默取第一个）。
   */
  feedFilter?: string[];
  typeFilter?: string[];
  /** 有它就改走检索接口（`/api/entries/search?q=`），与列表接口是两条路 */
  search?: string;
  /** `oldest`：后端只有时间倒序，把这一页反序 */
  sort: "newest" | "oldest";
};

/**
 * 把插件声明的 `query`（56-27 的 ViewQuery）翻成宿主现有的取数参数。
 *
 * 刻意只映射接口真有的维度；没声明的维度不猜、不补默认值。
 */
export function pluginViewFetchPlan(view: PluginView): PluginViewFetchPlan {
  const query = view.query ?? {};
  const feedIds = (query.feedIds ?? []).map(String).filter(Boolean);
  const types = (query.types ?? []).filter(isContentType);

  const params: PluginViewFetchPlan["params"] = {};
  if (feedIds.length === 1) params.feedId = feedIds[0];
  if (types.length === 1) params.contentType = types[0];
  // 条目接口只在 true 时带参数（falsy = 不过滤），所以 false 不写进去 ——
  // 「显式 false」与「没声明」在接口上本来就是同一个结果。
  if (query.unread) params.unreadOnly = true;
  if (query.starred) params.starredOnly = true;

  return {
    params,
    ...(feedIds.length > 1 ? { feedFilter: feedIds } : {}),
    ...(types.length > 1 ? { typeFilter: types } : {}),
    ...(query.search ? { search: query.search } : {}),
    sort: query.sort === "oldest" ? "oldest" : "newest",
  };
}

/**
 * 条目自带的内容类型（`types/api.ts` 的 `Entry` 上没有这个字段）。
 * 只有声明了多个 `types` 时才会被用于前端过滤；拿不到的一律当作 article
 * （文章是缺省内容类型，与路由的 `parseContentType` 同口径）。
 */
function entryType(entry: Entry): ContentType {
  const raw = (entry as Entry & { contentType?: string }).contentType;
  return raw && isContentType(raw) ? raw : "article";
}

function timeOf(entry: Entry): number {
  const raw = entry.publishedAt ?? entry.createdAt;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? 0 : time;
}

/** 取回这一页后按「接口表达不了的集合条件」过滤，并按 sort 排序 */
export function shapeEntries(
  entries: Entry[],
  plan: PluginViewFetchPlan,
): Entry[] {
  const feedFilter = plan.feedFilter ? new Set(plan.feedFilter) : null;
  const typeFilter = plan.typeFilter ? new Set(plan.typeFilter) : null;
  const filtered = entries.filter(
    (entry) =>
      (!feedFilter || feedFilter.has(entry.feedId)) &&
      (!typeFilter || typeFilter.has(entryType(entry))),
  );
  if (plan.sort !== "oldest") return filtered;
  return [...filtered].sort((a, b) => timeOf(a) - timeOf(b));
}
