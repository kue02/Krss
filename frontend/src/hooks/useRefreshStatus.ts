import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRefreshStatus } from "@/api";
import { requestEntriesHeadSync } from "@/lib/entries-head-sync";

/**
 * 空闲且页面可见时的轮询间隔。
 *
 * 原来是固定 15 秒：后端每 15 分钟定时刷新跑完后，前端最多要等下一次空闲轮询（跨过「刚刷完」）
 * 才把新条目拉出来，最坏 ~15 秒。可见时缩到 5 秒，把这段延迟压到 ~5 秒。
 */
const IDLE_VISIBLE_POLL_MS = 5_000;
/** 刷新中的快轮询间隔：进度条 / 逐源结果要跟得上 */
const REFRESHING_POLL_MS = 2_000;
/**
 * 页面隐藏（切到后台标签页）时的间隔。配合 TanStack 默认的
 * `refetchIntervalInBackground: false`，后台本就不会轮询，这里再拉长只是兜底，避免反而更费电。
 */
const HIDDEN_POLL_MS = 60_000;

/** 页面当前是否可见（SSR / 测试环境可能没有 document） */
function isPageVisible(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible";
}

/**
 * 计算 `["refreshStatus"]` 的轮询间隔（纯函数，便于单测）。
 * - 隐藏：60s 兜底（后台实际不轮询，见 HIDDEN_POLL_MS 注释）
 * - 可见 + 刷新中：2s 快轮询
 * - 可见 + 空闲：5s（原 15s，见 IDLE_VISIBLE_POLL_MS 注释）
 */
export function getRefreshStatusPollInterval(
  isRefreshing: boolean,
  visible: boolean,
): number {
  if (!visible) return HIDDEN_POLL_MS;
  return isRefreshing ? REFRESHING_POLL_MS : IDLE_VISIBLE_POLL_MS;
}

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

  const { data, refetch } = useQuery({
    queryKey: ["refreshStatus"],
    queryFn: getRefreshStatus,
    /**
     * 12-10：刷新中 2 秒一次。
     * 11-25：可见时空闲轮询由 15 秒缩到 5 秒，把「自动刷新完成 → 新条目出现」的最坏延迟从
     *         ~15s 压到 ~5s；隐藏时降到 60s 兜底（且 refetchIntervalInBackground 保持默认 false，
     *         后台不轮询，不耗电）。刷新中仍保持 2 秒快轮询。
     */
    refetchInterval: (query) =>
      getRefreshStatusPollInterval(
        query.state.data?.isRefreshing === true,
        isPageVisible(),
      ),
    staleTime: 1_000,
  });

  /**
   * 切回前台立即刷新一次状态：用户从别的标签页/窗口切回来时马上看到最新状态，
   * 不用再等下一次 5 秒轮询。组件卸载 / 依赖变化时移除监听。
   */
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refetch();
      }
    };
    const onFocus = () => {
      void refetch();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [refetch]);

  useEffect(() => {
    if (!data) return;

    const current = data.lastRefreshedAt;
    if (
      prevTimestampRef.current !== null &&
      prevTimestampRef.current !== current
    ) {
      // 58-3：不整窗重拉（offset 会被头部插入顶掉，用户正读的卡直接从 DOM 消失），
      // 只把新条目并到已加载列表头部
      void requestEntriesHeadSync(queryClient);
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
        void requestEntriesHeadSync(queryClient);
        queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
        queryClient.invalidateQueries({ queryKey: ["feeds"] });
      }
    }
  }, [data, queryClient]);

  // 返回状态：刷新结果弹框（useRefreshReportWatcher）要读每源结果（用户 11-8）。
  // 同一个 queryKey，不会因此多一次轮询。
  return data;
}
