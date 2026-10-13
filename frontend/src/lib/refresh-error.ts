import type { TFunction } from "i18next";

/**
 * 刷新失败的错误分类 → 人话（51 批 2）。
 *
 * 后端在抓取失败时识别 RSSHub 错误页，把失败原因存成**机器前缀**的稳定字符串
 * （见 backend/internal/service/rsshub_error.go）：
 *   `rsshub route not found: <route>`   —— 路由不存在（地址写错 / RSSHub 版本没有）
 *   `rsshub upstream error: <detail>`   —— RSSHub 抓它的上游失败（上游的事，去实例侧处理）
 *   `rsshub unreachable: <detail>`      —— 连 RSSHub 实例本身都连不上
 * 其余错误（老数据、非 RSSHub 源）原样透传。
 *
 * 展示点：侧栏订阅 tooltip、刷新悬浮层、刷新报告、自动刷新历史。
 */
const PREFIXES = [
  { prefix: "rsshub route not found: ", key: "refresh_tooltip.rsshub_route_not_found" },
  { prefix: "rsshub upstream error: ", key: "refresh_tooltip.rsshub_upstream_error" },
  { prefix: "rsshub unreachable: ", key: "refresh_tooltip.rsshub_unreachable" },
] as const;

export function describeRefreshError(
  reason: string | undefined,
  t: TFunction<"translation", undefined>,
): string {
  if (!reason) return "";
  for (const { prefix, key } of PREFIXES) {
    if (reason.startsWith(prefix)) {
      return t(key, { detail: reason.slice(prefix.length) });
    }
  }
  return reason;
}
