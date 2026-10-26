import { useQuery } from "@tanstack/react-query";
import { fetchPluginViews } from "./api";
import type { PluginView } from "./types";

/**
 * 插件注册的视图（56-28）。
 *
 * 契约：`GET /api/plugins/views` 回 `{views: [...]}`，只含**已启用**插件。停用/卸载后
 * 这一份清单里就没有那一条了 —— 界面上的「插件视图」按钮与 `?view=` 直达都得跟着消失，
 * 所以清单只拉这一处，切换器、路由、渲染三边共用同一份缓存。
 */
export const PLUGIN_VIEWS_QUERY_KEY = ["pluginViews"] as const;

/** 插件视图的稳定 key，也是地址栏 `?view=` 的取值（`插件id:视图id`） */
export function pluginViewKey(view: Pick<PluginView, "plugin" | "id">): string {
  return `${view.plugin}:${view.id}`;
}

/**
 * 归一：`plugin` 缺省空串（宿主没注入时不猜，猜错会把视图挂到别家插件名下）、
 * `kind` 认不出的一律当声明式（与后端 registry 的降级口径一致）、
 * 其余可选字段保持 undefined，别塞空串。
 */
export function normalizePluginView(view: PluginView): PluginView {
  return {
    ...view,
    plugin: view.plugin ?? "",
    kind: view.kind === "custom" ? "custom" : "declarative",
  };
}

/**
 * 排序：按插件 id，再按视图 id —— 切换器里的插件分组就是这个顺序，
 * 同一插件自己的几个视图因此挨在一起（而不是按后端注册先后跳来跳去）。
 */
export function sortPluginViews(views: readonly PluginView[]): PluginView[] {
  return [...views].sort(
    (a, b) =>
      a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id),
  );
}

/** 全量插件视图（按 plugin 排序、已归一）；加载中 `data` 是 undefined */
export function usePluginViews() {
  return useQuery({
    queryKey: PLUGIN_VIEWS_QUERY_KEY,
    queryFn: () =>
      fetchPluginViews().then((list) =>
        sortPluginViews(list.map(normalizePluginView)),
      ),
    staleTime: 30_000,
  });
}

/**
 * 地址栏 `?view=` 的三种可分辨状态。
 *
 * `loading` 与 `unknown` 必须分开：清单还在路上时把一个真视图当成「认不出」去摘参数，
 * 刷新页面就会把用户正开着的插件视图踢掉（表现是「插件视图刷新一下就没了」）。
 */
export type PluginViewResolution =
  | { status: "none" }
  | { status: "loading" }
  | { status: "resolved"; view: PluginView }
  | { status: "unknown"; raw: string };

/**
 * 把 `?view=` 的原始值解析成「哪个插件视图」。
 *
 * `views === undefined` = 清单还没到；空数组是**已知的没有**，那是 unknown。
 */
export function resolvePluginViewFromParam(
  views: readonly PluginView[] | undefined,
  raw: string | null | undefined,
): PluginViewResolution {
  const key = (raw ?? "").trim();
  if (!key) return { status: "none" };
  if (views === undefined) return { status: "loading" };
  const found = views.find((view) => pluginViewKey(view) === key);
  return found
    ? { status: "resolved", view: found }
    : { status: "unknown", raw: key };
}
