import { useEffect, useRef } from "react";
import { useRefreshStatus } from "@/hooks/useRefreshStatus";
import {
  buildRefreshReport,
  useRefreshReportStore,
} from "@/stores/refresh-report-store";

/**
 * 盯住刷新状态：**完成时间（lastRefreshedAt）一变**就弹出刷新结果弹框（用户 11-8）。
 *
 * 统一在这里监听，侧栏订阅右键「刷新」与中栏刷新按钮两个入口自然都弹同一份报告（联动）。
 *
 * 为什么用时间戳而不是「看 isRefreshing 从 true 变 false」：单源刷新通常两秒内就结束，
 * 而状态是 15 秒轮询一次的 —— 轮询很可能**直接看到「已经刷完」**，根本观察不到「刷新中」这一段
 * （实测：右键刷新单个订阅后弹框一直不出现，就是踩了这个）。时间戳不会漏：后端每轮结束都会更新它。
 */
export function useRefreshReportWatcher() {
  const status = useRefreshStatus();
  const open = useRefreshReportStore((state) => state.open);
  /** 已经弹过的那一轮刷新的时间戳（首次挂载先记基线，不把上次的旧报告弹出来） */
  const lastShownRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!status || status.isRefreshing) return;
    const stamp = status.lastRefreshedAt ?? null;
    if (lastShownRef.current === undefined) {
      lastShownRef.current = stamp;
      return;
    }
    if (stamp === null || stamp === lastShownRef.current) return;
    lastShownRef.current = stamp;
    const results = status.results ?? [];
    if (results.length === 0) return;
    open(buildRefreshReport(results));
  }, [status, open]);
}
