import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRefreshStatus } from "@/api";

/**
 * Polls the backend refresh status and automatically invalidates
 * entries/unreadCounts/feeds caches when a scheduled refresh completes.
 *
 * Mount this hook once at the app level (e.g., AuthenticatedApp).
 */
export function useRefreshStatus() {
  const queryClient = useQueryClient();
  // null = not initialized (haven't received first response yet)
  // undefined = server returned no lastRefreshedAt (no refresh has happened)
  // string = last known timestamp
  const prevTimestampRef = useRef<string | undefined | null>(null);

  const { data } = useQuery({
    queryKey: ["refreshStatus"],
    queryFn: getRefreshStatus,
    /**
     * 12-10：刷新中 2 秒一次，空闲 15 秒。
     *
     * 原来固定 15 秒 —— 侧栏右键「刷新」是后台跑的（POST 立刻 204），
     * 中栏进度条与「刷新完成」弹框只能等下一次轮询，用户看到的就是「点了没反应」。
     */
    refetchInterval: (query) => (query.state.data?.isRefreshing ? 2_000 : 15_000),
    staleTime: 1_000,
  });

  useEffect(() => {
    if (!data) return;

    const current = data.lastRefreshedAt;
    if (
      prevTimestampRef.current !== null &&
      prevTimestampRef.current !== current
    ) {
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
    }
    prevTimestampRef.current = current;
  }, [data, queryClient]);

  // 返回状态：刷新结果弹框（useRefreshReportWatcher）要读每源结果（用户 11-8）。
  // 同一个 queryKey，不会因此多一次轮询。
  return data;
}
