import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getProxySources,
  updateFeedProxy,
  updateFolderProxy,
} from "@/api";
import type {
  ProxyEffective,
  ProxyOverridePayload,
  ProxySourceOverview,
} from "@/types/api";

/** 代理来源一览查询键：改完覆盖项后所有相关界面（设置段、管理面板、订阅弹窗）一起刷新 */
export const PROXY_SOURCES_QUERY_KEY = ["proxy-sources"] as const;

/**
 * 代理按来源生效的一览（14 批）。
 *
 * 设置 → 网络「按来源覆盖」段用它拿计数；管理面板用它画文件夹/订阅树；
 * 订阅编辑弹窗用它显示这一条**实际生效**的结果（「走代理 · 来自：文件夹『技术』」）。
 * staleTime 短一点：改完设置回来就要看到新结果，不做长时间缓存。
 */
export function useProxySources(enabled = true) {
  return useQuery({
    queryKey: PROXY_SOURCES_QUERY_KEY,
    queryFn: () => getProxySources(),
    enabled,
    staleTime: 5_000,
  });
}

function invalidateAll(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: PROXY_SOURCES_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: ["feeds"] });
  queryClient.invalidateQueries({ queryKey: ["folders"] });
}

/**
 * 用 PATCH 的回显就地更新一览（不等一轮 refetch）。
 *
 * 为什么值得写这几行：覆盖是「就近生效」的 —— 改了文件夹，它下面的订阅也全变；
 * 只靠 invalidate 再拉一遍，点完到看见新结果要等一两秒（91 行重渲染），
 * 用户会以为没生效。这里先把**服务端算出来的** effective 写回缓存，界面立刻正确；
 * 随后的 invalidate 再把它拉成最终一致（比如文件夹改了，子订阅的生效结果也要跟着变）。
 */
function patchOverviewCache(
  queryClient: ReturnType<typeof useQueryClient>,
  kind: "feed" | "folder",
  id: string,
  override: ProxyOverridePayload,
  effective: ProxyEffective,
) {
  queryClient.setQueryData<ProxySourceOverview>(
    PROXY_SOURCES_QUERY_KEY,
    (prev) => {
      if (!prev) return prev;
      if (kind === "feed") {
        return {
          ...prev,
          feeds: prev.feeds.map((feed) =>
            feed.id === id
              ? {
                  ...feed,
                  override: {
                    mode: override.mode ?? feed.override.mode,
                    config:
                      override.config === undefined
                        ? feed.override.config
                        : override.config,
                  },
                  effective,
                }
              : feed,
          ),
        };
      }
      return {
        ...prev,
        folders: prev.folders.map((folder) =>
          folder.id === id
            ? {
                ...folder,
                override: {
                  mode: override.mode ?? folder.override.mode,
                  config:
                    override.config === undefined
                      ? folder.override.config
                      : override.config,
                },
                effective,
              }
            : folder,
        ),
      };
    },
  );
}

/** 写单条订阅的代理覆盖（回显里带实际生效结果，直接写回缓存让行上立刻正确） */
export function useUpdateFeedProxy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { id: string; override: ProxyOverridePayload }) =>
      updateFeedProxy(payload.id, payload.override),
    onSuccess: (data, variables) => {
      patchOverviewCache(
        queryClient,
        "feed",
        variables.id,
        variables.override,
        data.effective,
      );
      invalidateAll(queryClient);
    },
  });
}

/** 写单个文件夹的代理覆盖（子文件夹与该文件夹下的订阅都跟着变） */
export function useUpdateFolderProxy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { id: string; override: ProxyOverridePayload }) =>
      updateFolderProxy(payload.id, payload.override),
    onSuccess: (data, variables) => {
      patchOverviewCache(
        queryClient,
        "folder",
        variables.id,
        variables.override,
        data.effective,
      );
      invalidateAll(queryClient);
    },
  });
}
