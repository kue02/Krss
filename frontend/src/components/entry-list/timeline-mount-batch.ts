import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 通知时间线的**分批挂载**（perf）。
 *
 * 真机实测（ego + 生产构建，article → notification 冷切换）：通知视图 7~10 个长任务、
 * 合计 678~3462ms、单根最长 1529ms；DOM 690 → 9132、227 张图。根因之一是
 * `buildTimelineRows` 分组后**一次挂满 50 行**（每行一个 ContextMenu + HeroUI Chip +
 * Ripple + 正文预览）→ 首根 596ms。
 *
 * 这里只管「这一批先挂几行」：
 *   - 首屏**同步**挂载首批（视口高度 ÷ 行估算高度，且不少于 `TIMELINE_MIN_FIRST_WAVE_ROWS`），
 *     剩下的行先占一个等高空位（见 `NotificationTimeline` 的 pending 分支）；
 *   - 其余行按波次补挂，每一波用 `requestIdleCallback({ timeout })` 排程。
 *
 * 为什么必须带 timeout、且绝不用裸 `requestAnimationFrame`：
 *   1. 后台标签页里 rAF 被节流到 0 帧 —— 上一轮踩过这个坑（长贴永远不展开），
 *      `setTimeout`/rIC-timeout 在后台只是被限流到 ≥1s，仍然会跑；
 *   2. 补挂**必须**在 1 秒内收口：`useScrollMarkRead` 的挂载宽限期是
 *      `MARK_READ_ON_SCROLL_GRACE_MS = 1000`，宽限期到点才建 IntersectionObserver 并
 *      一次性 `querySelectorAll("[data-entry-id]")` 收集观察对象。晚于它才挂上的行
 *      永远不会被观察 ⇒ 滚动标已读会漏标（那是功能回归，不是性能取舍）。
 *      所以波次超时压到 120ms：50 行 / 每波 12 行 = 4 波，最坏 ≈ 600ms < 1000ms，
 *      浏览器一有空闲帧就提前跑（典型远快于最坏值）。
 */

/** 一行折叠态卡片的估计高度（正文 2 行 + 标题 + 内边距 + 行间距，取整） */
export const TIMELINE_ROW_ESTIMATE_PX = 140;
/** 首批最少挂载的行数：视口量不出来（jsdom / 首帧 0 高）时也要挂够这一批 */
export const TIMELINE_MIN_FIRST_WAVE_ROWS = 12;
/** 每一波补挂的行数 */
export const TIMELINE_WAVE_ROWS = 12;
/** 每一波 `requestIdleCallback` 的兜底超时（见文件头第 2 点，别随手调大） */
export const TIMELINE_WAVE_IDLE_TIMEOUT_MS = 120;
/**
 * 分批挂载的**硬截止**：到点一定把剩下的行全部挂完。
 *
 * 波次本身是「有空就跑 + 120ms 兜底」，理论上会被长任务挤后；而
 * `useScrollMarkRead` 只在挂载后 1000ms 的宽限期到点时建一次 IntersectionObserver，
 * 并把那时已经在 DOM 里的 `[data-entry-id]` 一次性收进观察列表 —— 晚于它才挂上的行
 * **永远不会被观察**，滚动标已读会漏标（功能回归，不是性能取舍）。
 * 所以这里钉一条 800ms 的底线（留 200ms 给 commit + 上报合批），最坏情况也兜得住。
 */
export const TIMELINE_MOUNT_DEADLINE_MS = 800;
/** 「全部立刻挂载」的哨兵值（用户主动展开小节点 / 到硬截止时用） */
export const TIMELINE_MOUNT_ALL_ROWS = Number.MAX_SAFE_INTEGER;

type IdleDeadlineLike = { didTimeout: boolean; timeRemaining: () => number };
type IdleHandle = number;

interface IdleWindow {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadlineLike) => void,
    options?: { timeout?: number },
  ) => IdleHandle;
  cancelIdleCallback?: (handle: IdleHandle) => void;
  /** 兜底排程位（真实 `window` 一定有；测试里的假 window 可以不给） */
  setTimeout?: (handler: () => void, timeout?: number) => IdleHandle;
  clearTimeout?: (handle?: IdleHandle) => void;
}

/**
 * 排一次空闲回调；环境没有 `requestIdleCallback`（Safari / jsdom）就用 `setTimeout`
 * 兜同样长的超时。**不用 rAF**（后台节流）。
 *
 * 返回取消函数（没有可排的通道时返回 undefined），调用方负责在清理里调它。
 */
export function scheduleIdleCallback(
  run: () => void,
  timeoutMs: number,
  target: IdleWindow | undefined = typeof window === "undefined"
    ? undefined
    : window,
): (() => void) | undefined {
  if (!target) return undefined;
  if (typeof target.requestIdleCallback === "function") {
    const handle = target.requestIdleCallback(() => run(), { timeout: timeoutMs });
    return () => {
      if (typeof target.cancelIdleCallback === "function") {
        target.cancelIdleCallback(handle);
      }
    };
  }
  if (typeof target.setTimeout !== "function") return undefined;
  const timer = target.setTimeout(run, timeoutMs);
  return () => target.clearTimeout?.(timer);
}

/**
 * 首批行数：`视口高度 ÷ 行估算高度`（向上取整 + 一点余量），但不低于最小值。
 *
 * 只做「够填满首屏」的意思 —— 精确高度由真实布局决定，估算只影响首屏一瞬。
 */
export function computeFirstWaveRows(
  viewportHeight: number,
  rowEstimatePx: number = TIMELINE_ROW_ESTIMATE_PX,
): number {
  const rowsFromViewport = Math.ceil(viewportHeight / rowEstimatePx) + 2;
  return Math.max(TIMELINE_MIN_FIRST_WAVE_ROWS, rowsFromViewport);
}

/** 取当前视口高度（SSR / 无 window 环境回 0 ⇒ 直接落最小首批） */
export function measureTimelineViewportHeight(): number {
  if (typeof window === "undefined") return 0;
  return window.innerHeight || document.documentElement?.clientHeight || 0;
}

export interface TimelineBatchMount {
  /** 当前允许挂载的行数（已按总行数与「必须挂载的行」夹好） */
  mountedRows: number;
  /** 这批剩下的行全部立刻挂载（用户主动展开小节点等结构性增行时用） */
  mountAllNow: () => void;
}

/**
 * 分批挂载的排程钩子。
 *
 * @param totalRows   当前批次的**内容行**总数（日期分隔行不算，它恒挂载）
 * @param batchKey    批次标识：变化即重置回首批（换订阅/换一批条目/换粒度或时间基准）
 * @param minRowsToMount  无论排程如何都必须挂载的行数（选中条目所在的那一行）
 */
export function useTimelineBatchMount(
  totalRows: number,
  batchKey: string,
  minRowsToMount: number,
): TimelineBatchMount {
  const [mountCount, setMountCount] = useState(() =>
    computeFirstWaveRows(measureTimelineViewportHeight()),
  );

  // 选中行必须可见 ⇒ 就地夹一次，不等排程（等排程会让「选中即展开」空转一波）
  const mountedRows = Math.min(totalRows, Math.max(mountCount, minRowsToMount));

  // 渲染期把最新值留给排程回调读（回调只在宏任务里跑，不参与渲染）
  const mountedRowsRef = useRef(mountedRows);
  mountedRowsRef.current = mountedRows;
  const totalRowsRef = useRef(totalRows);
  totalRowsRef.current = totalRows;

  // 换一批（切换 selection / entries 批 / 换粒度基准）→ 重置回首批
  const prevBatchKeyRef = useRef(batchKey);
  useEffect(() => {
    if (prevBatchKeyRef.current === batchKey) return;
    prevBatchKeyRef.current = batchKey;
    setMountCount(computeFirstWaveRows(measureTimelineViewportHeight()));
  }, [batchKey]);

  /**
   * 硬截止：每一批排**一个** `setTimeout(800)`，到点把剩下的行全挂完。
   *
   * 波次靠「空闲 + 120ms 兜底」推进，主线程一直忙的话会拖过滚动标已读的 1s 宽限期
   * （见 `TIMELINE_MOUNT_DEADLINE_MS` 的注释）—— 那是功能回归。底线到点一律挂完。
   */
  useEffect(() => {
    if (totalRows <= TIMELINE_MIN_FIRST_WAVE_ROWS) return undefined;
    const timer = setTimeout(() => {
      if (mountedRowsRef.current >= totalRowsRef.current) return;
      setMountCount(TIMELINE_MOUNT_ALL_ROWS);
    }, TIMELINE_MOUNT_DEADLINE_MS);
    return () => clearTimeout(timer);
    // 批次变化（含条目增量）重排截止；`mountedRows` 不参与依赖 —— 它前进不该续命
  }, [batchKey, totalRows]);

  // 还剩没挂的行 → 排一波；每次 mountedRows 前进后本 effect 重跑再排下一波，
  // 直到全挂完（所以「展开簇插进来的新行」也会被补挂）。
  useEffect(() => {
    if (mountedRows >= totalRows) return undefined;
    let cancelled = false;
    const cancel = scheduleIdleCallback(() => {
      if (cancelled) return;
      const current = mountedRowsRef.current;
      const target = current + TIMELINE_WAVE_ROWS;
      if (target >= totalRowsRef.current) {
        // 这一波就能挂完 → 直接把计数推到底，省掉后续波次与它自己的排程
        setMountCount(TIMELINE_MOUNT_ALL_ROWS);
        return;
      }
      setMountCount(target);
    }, TIMELINE_WAVE_IDLE_TIMEOUT_MS);
    return () => {
      cancelled = true;
      cancel?.();
    };
  }, [mountedRows, totalRows]);

  const mountAllNow = useCallback(() => setMountCount(TIMELINE_MOUNT_ALL_ROWS), []);

  return { mountedRows, mountAllNow };
}
