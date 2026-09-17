import { create } from "zustand";
import type { RefreshFeedResult } from "@/api";

/**
 * 刷新结果弹框的状态（用户 11-8）。
 *
 * 为什么单开一个 store：刷新是后台跑的（POST 立刻 204、进度走 GET /feeds/refresh），
 * 触发点有两处（侧栏订阅右键「刷新」、中栏刷新按钮）—— 由 `useRefreshReportWatcher()` 统一
 * 监听「刷新中 → 刷新完」这个跳变来弹框，两个入口自然都走同一份报告（联动）。
 */
export interface RefreshReport {
  /** 新增 + 更新 的总条数 */
  changed: number;
  created: number;
  updated: number;
  /** 每个订阅的明细（失败的在 failures 里，也留在 results 里） */
  results: RefreshFeedResult[];
  failures: RefreshFeedResult[];
}

interface RefreshReportState {
  report: RefreshReport | null;
  /** 是否展开了「详情」（展开后不自动关闭，由用户手动关） */
  detailsOpen: boolean;
  open: (report: RefreshReport) => void;
  close: () => void;
  toggleDetails: () => void;
}

export function buildRefreshReport(results: RefreshFeedResult[]): RefreshReport {
  const created = results.reduce((sum, item) => sum + (item.new || 0), 0);
  const updated = results.reduce((sum, item) => sum + (item.updated || 0), 0);
  return {
    changed: created + updated,
    created,
    updated,
    results,
    failures: results.filter((item) => !!item.error),
  };
}

export const useRefreshReportStore = create<RefreshReportState>((set) => ({
  report: null,
  detailsOpen: false,
  open: (report) => set({ report, detailsOpen: false }),
  close: () => set({ report: null, detailsOpen: false }),
  toggleDetails: () => set((state) => ({ detailsOpen: !state.detailsOpen })),
}));
