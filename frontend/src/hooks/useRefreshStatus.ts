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
  /**
   * 2.2：刷新中计数实时往上走 —— completed 一涨就提前并一次 entries/unreadCounts/feeds，
   * 每刷完一个源它带来的新条目就进列表、未读数跟着加，不用等整轮结束。
   * 整轮结束（lastRefreshedAt 变化）再对一次总数，保证最终数字与刷新报告一致。
   */
  const prevCompletedRef = useRef<number | null>(null);

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
      prevCompletedRef.current = null;
    }
    prevTimestampRef.current = current;

    // 2.2：刷新中 completed 涨了 = 又有源刷完 → 提前并一次（轮询 2s 一次，天然节流）
    if (data.isRefreshing && typeof data.completed === "number") {
      if (prevCompletedRef.current === null) {
        prevCompletedRef.current = data.completed;
      } else if (data.completed > prevCompletedRef.current) {
        prevCompletedRef.current = data.completed;
        queryClient.invalidateQueries({ queryKey: ["entries"] });
        queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
        queryClient.invalidateQueries({ queryKey: ["feeds"] });
      }
    }
  }, [data, queryClient]);

  // 返回状态：刷新结果弹框（useRefreshReportWatcher）要读每源结果（用户 11-8）。
  // 同一个 queryKey，不会因此多一次轮询。
  return data;
}
