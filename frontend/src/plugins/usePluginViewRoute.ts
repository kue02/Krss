import { useCallback, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import {
  pluginViewKey,
  resolvePluginViewFromParam,
  usePluginViews,
} from "./usePluginViews";
import type { PluginView } from "./types";
import type { PluginViewResolution } from "./usePluginViews";

/** 地址栏里的视图参数名（wouter 的 `useSearch()` 不带前导 `?`） */
export const VIEW_PARAM = "view";

function href(location: string, search: string): string {
  return search ? `${location}?${search}` : location;
}

/** 取 `?view=` 的原始值（没有就 null） */
export function readViewParam(search: string): string | null {
  return new URLSearchParams(search).get(VIEW_PARAM);
}

/** 在当前地址上带一个 `?view=插件id:视图id`（其余参数原样保留） */
export function withViewParam(
  location: string,
  search: string,
  key: string,
): string {
  const params = new URLSearchParams(search);
  params.set(VIEW_PARAM, key);
  return href(location, params.toString());
}

/** 摘掉 `?view=`，其余参数原样保留（回落内置视图时用） */
export function withoutViewParam(location: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(VIEW_PARAM);
  return href(location, params.toString());
}

/** 插件视图想按条目看数据时带的 `?entry=<id>`（id 是字符串：19 位 snowflake 不能进 number） */
export type PluginViewEntry = { id: string };

export type PluginViewRoute = {
  /** 当前地址 vs 插件视图清单的解析结果 */
  resolution: PluginViewResolution;
  /** 切换器用的全量清单（按 plugin 排序，加载中是空数组） */
  views: PluginView[];
  /** 正在显示的插件视图 key（没在插件视图里就是 null） */
  activeKey: string | null;
  /** 切到某个插件视图（保留当前路径与其余参数） */
  openView: (key: string) => void;
  /** 从插件视图退回内置视图 */
  closeView: () => void;
  /** 当前 `?entry=<id>`；没有就是 null（视图自己决定要不要提示「先选一条」） */
  entry: PluginViewEntry | null;
};

/**
 * 插件视图的路由（56-28）。
 *
 * 插件视图是**搜索参数**而不是新路径：侧栏的选中态、`?type=`、`?unread=` 都是既有语义，
 * 插件视图只是把主内容区换掉，退回时应该一个字不差地回到原来那屏（而不是回首页）。
 *
 * 三条兜底都在这里：
 *   1. 清单还在路上 → `loading`，界面给一块空底而不是先画内置列表再跳；
 *   2. 认不出的 `?view=`（插件停用 / 卸载 / 手写错）→ 立刻把参数从地址栏摘掉，
 *      下一次渲染自然回到内置视图 —— 不能白屏，也不能让刷新永远卡在一个不存在的视图上；
 *   3. 认得出 → `resolved`，主内容区换成插件视图。
 */
export function usePluginViewRoute(): PluginViewRoute {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { data, isError } = usePluginViews();

  const resolution = resolvePluginViewFromParam(
    // 清单请求失败 = 「这份地址上的视图确实拿不到了」：按认不出处理（摘参数、回落内置视图），
    // 否则网络一抖就永远停在 loading 那块空底上（用户没有出路）。
    isError ? [] : data,
    readViewParam(search),
  );

  useEffect(() => {
    if (resolution.status !== "unknown") return;
    navigate(withoutViewParam(location, search), { replace: true });
  }, [resolution.status, location, search, navigate]);

  const openView = useCallback(
    (key: string) => {
      navigate(withViewParam(location, search, key), { replace: true });
    },
    [location, search, navigate],
  );

  const closeView = useCallback(() => {
    navigate(withoutViewParam(location, search), { replace: true });
  }, [location, search, navigate]);

  const entryParam = new URLSearchParams(search).get("entry")?.trim() ?? "";

  return {
    resolution,
    views: data ?? [],
    entry: entryParam ? { id: entryParam } : null,
    activeKey:
      resolution.status === "resolved" ? pluginViewKey(resolution.view) : null,
    openView,
    closeView,
  };
}
