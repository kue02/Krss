import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchPluginSettings } from "@/plugins/api";
import { rewriteRssHubUrl } from "./rsshub";

/**
 * RSSHub 实例设置（插件键 plugin.rsshub.base_url / access_key）与「把地址换到该实例」的改写器。
 *
 * 55-18：这两项从通用设置（generalSettings.rsshubBaseUrl/rsshubAccessKey）搬进了 rsshub 插件，
 * 所以消费方（添加订阅的 useAddFeed、插件设置段自己）不再读 useGeneralSettings，改读插件设置。
 * 缓存键与设置段共用 `["pluginSettings","rsshub"]` —— 设置页保存后 invalidate 它，添加订阅立刻拿到新值。
 */
export function useRssHubRewrite() {
  const { data } = useQuery({
    queryKey: ["pluginSettings", "rsshub"],
    queryFn: () => fetchPluginSettings("rsshub"),
    staleTime: 5 * 60 * 1000,
  });

  const baseUrl = (data?.base_url ?? "").trim();
  const accessKey = (data?.access_key ?? "").trim();

  /** 换到自有实例；没配实例 / 不是 RSSHub 地址 / 换了等于没换 → null（调用方保持原样） */
  const rewrite = useCallback(
    (rawUrl: string): string | null => {
      if (!baseUrl) return null;
      const next = rewriteRssHubUrl(rawUrl, baseUrl, accessKey);
      if (!next || next === rawUrl) return null;
      return next;
    },
    [accessKey, baseUrl],
  );

  return { baseUrl, accessKey, rewrite };
}
