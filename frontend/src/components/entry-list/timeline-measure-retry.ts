import { useCallback, useEffect, useRef } from "react";

/**
 * 通知时间线的**共享复测定时器**（perf）。
 *
 * 卡片量两件事：正文预览的自然高度（父级拿它判「长贴」> 300px）与折叠态是否真的被截断
 * （决定「展开全文」按钮出不出）。两处都在挂载时量一次 + **400ms 后复测一次**
 * （图片异步加载会改高度）。之前是每张卡自己 `setTimeout(400)` 两次 ⇒ 50 张卡 = 100 个
 * 独立宏任务，每个回调都读一次 `scrollHeight` 强制布局：真机 CPU tracing 里
 * TimerFire + TimerBase.run 合计 1017ms，是切换长任务的主要来源之一。
 *
 * 现在收敛到父级**一个**定时器：
 *   - 卡片挂载时把复测回调注册进父级的集合（`Map<回调, 到期时刻>`），卸载时摘掉；
 *   - 任一时刻最多只有**一个** `setTimeout` 在排（排向集合里最早的那个到期时刻）；
 *   - 到点把已届期的回调依次跑完并从集合摘掉，集合里还有更晚的就再排一次。
 *
 * 为什么按「各自的到期时刻」而不是「第一个注册者 + 400ms」一把梭：分批挂载之后卡片是
 * 分波挂上来的，若共用第一条波的到期时刻，后面几波的卡片会在自己挂载后 ~40ms 就复测 ——
 * 图片还没加载完，长贴判定与截断判定会漏（那是功能回归）。按各自 due 排队保证
 * **每个回调不早于自己注册后 400ms 执行**（可能因合批偏晚，偏晚无害：只是把同样的值
 * 再量一遍），同时定时器数从 100 降到「每个注册波次一个」。
 *
 * 回调只跑一次（跑完即摘），与改前 `setTimeout(report, 400)` 的语义一致。
 */

/** 复测延迟（与改前每张卡的 `setTimeout(400)` 同一个值） */
export const TIMELINE_MEASURE_RETRY_MS = 400;

/** 注册一个复测回调，返回注销函数（卡片卸载 effect 直接 return 它） */
export type MeasureRetryRegistrar = (run: () => void) => () => void;

export function useMeasureRetryHub(
  delayMs: number = TIMELINE_MEASURE_RETRY_MS,
): MeasureRetryRegistrar {
  /** 待复测的回调 → 它自己的到期时刻（`Date.now() + delayMs`） */
  const pendingRef = useRef<Map<() => void, number>>(new Map());
  /** 当前那一个定时器：id + 它的到期时刻（null = 没排） */
  const timerRef = useRef<number | null>(null);
  const armedUntilRef = useRef(0);
  const delayRef = useRef(delayMs);
  delayRef.current = delayMs;

  /** `arm` ⇄ `pump` 互相调用，放 ref 里省得两个 useCallback 互相依赖 */
  const hubRef = useRef<{ arm: (dueAt: number) => void; pump: () => void }>({
    arm: () => {},
    pump: () => {},
  });

  hubRef.current.arm = (dueAt: number) => {
    if (timerRef.current !== null && armedUntilRef.current <= dueAt) {
      // 已排的那次更早（或同刻）到点：留着。它到点时会把还没届期的回调重排到各自到期时刻。
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    armedUntilRef.current = dueAt;
    timerRef.current = window.setTimeout(
      () => hubRef.current.pump(),
      Math.max(0, dueAt - Date.now()),
    );
  };

  hubRef.current.pump = () => {
    // 这次定时器是为哪个时刻排的 —— 它到点了，为它排的那批就必须跑。
    // 不能只认 `Date.now()`：测试里常见「只 fake Date、不 fake setTimeout」的时钟是冻住的
    // （真定时器会到点、假时钟不走），只看 now 会让这批回调永远不届期 → 无限重排。
    const firedFor = armedUntilRef.current;
    timerRef.current = null;
    armedUntilRef.current = 0;
    const pending = pendingRef.current;
    if (pending.size === 0) return;

    const now = Date.now();
    const due: Array<() => void> = [];
    let earliest = Number.POSITIVE_INFINITY;
    pending.forEach((dueAt, run) => {
      if (dueAt <= now || dueAt <= firedFor) due.push(run);
      else if (dueAt < earliest) earliest = dueAt;
    });
    // 先摘再跑：回调里会 setState / 可能再注册，跑之前集合状态就得是对的
    for (const run of due) pending.delete(run);
    for (const run of due) run();
    if (pending.size > 0) hubRef.current.arm(earliest);
  };

  useEffect(
    () => () => {
      // 卸载：定时器与待处理回调一起丢掉（回调闭包的是已卸载卡片的 ref，跑它们没意义）
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      armedUntilRef.current = 0;
      pendingRef.current.clear();
    },
    [],
  );

  /**
   * 注册位必须**稳定**：它是卡片的 prop，身份每渲染一变就会让每张卡的量测 effect
   * 重跑（又变成「每次渲染都重新排程」，比改前更糟）。
   */
  return useCallback((run: () => void) => {
    const dueAt = Date.now() + delayRef.current;
    pendingRef.current.set(run, dueAt);
    hubRef.current.arm(dueAt);
    return () => {
      pendingRef.current.delete(run);
    };
  }, []);
}
