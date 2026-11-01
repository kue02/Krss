import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Entry } from "@/types/api";
import type { ScrollSurface } from "./scroll-surface";

/**
 * 58-3（用户 2026-10-29）：自动刷新把新条目插到列表最前面时，**不要挪用户正在看的那一屏**。
 *
 * 背景：列表容器写了 `[overflow-anchor:none]`（历史上为了躲图片/卡片高度跳动），
 * 于是新条目一 prepend，DOM 整体往下推、`scrollTop` 数字不变 ⇒ 用户看到内容「向下滚了」
 * 一整块。这里在 React 提交后、浏览器绘制前（`useLayoutEffect`）按**可见锚点**
 * （当前视口里前几条 `[data-entry-id]` 的屏幕坐标）补偿 `scrollTop`：
 * 锚点回到原来的屏幕位置，新条目就「无感地叠在前面」。
 *
 * 另外补偿之后还有一段**短锁定期**（`ANCHOR_LOCK_MS`）：新卡片的图片/翻译异步落下来
 * 可能再一次把锚点推走，锁定期内每帧把锚点拉回原位；用户一旦自己滚轮/触摸/按键/点击，
 * 立刻解锁，绝不和用户抢滚动。
 *
 * 只在「列表不在最顶端」时补偿；在最顶端时按用户原话「直接往进插」——
 * `scrollTop` 本来就是 0，新条目出现在顶部正是他要的。
 */

/** 小于这个距离就当作「在最顶端」（浏览器取整误差兜底） */
const AT_TOP_THRESHOLD_PX = 2;
/** 补偿后的短锁定期：覆盖图片/翻译在插入后一两秒内把行高撑开的情况 */
const ANCHOR_LOCK_MS = 2_500;
/** 锁定期最多跑多少帧（jsdom 里 rAF 同步回调时防止死循环） */
const ANCHOR_LOCK_MAX_FRAMES = 160;
/** 同时记几个可见锚点：万一第一条被刷新换掉，用下一条还能算位移 */
const ANCHOR_CANDIDATES = 3;

interface UsePrependScrollAnchorOptions {
  surface: ScrollSurface;
  contentRootRef: RefObject<HTMLDivElement | null>;
  entries: Entry[];
  /** 换列表（订阅 / 视图 / 内容类型 / 已读筛选）时重置记账 */
  resetKey: string;
  enabled: boolean;
  /**
   * 暂时关闭「内容位移兜底」（比如正在做程序化的平滑滚回顶部）——
   * 平滑滚动过程中 `scrollBy` 一样会打断动画，所以这期间只让滚动自己跑完。
   * 用 ref 而不是布尔 prop：`scrollTo(0,"smooth")` 跟在 setState 后面会被 React
   * 的异步渲染拖一拍，兜底会抢在 state 生效前把动画掐断。
   */
  pausedRef?: RefObject<boolean>;
  /**
   * 要不要由这个 hook 亲自补偿滚动（默认 true）。
   *
   * 非虚拟列表（社媒 / 通知时间线）关掉补偿：视口挂 `[overflow-anchor:auto]`，
   * 浏览器原生 scroll anchoring 和布局补偿在同一帧里完成。JS 再补一次既多余、
   * 又会因为「锚点坐标是上一帧记的」把页面拉走一段 —— 2026-11-01 用户复测
   * 「还是不行」的现场就是采样里 `scrollHeight` 没变却出现
   * `stabilize delta=255 / 201` 的凭空补偿，之后页面整块下移并停住。
   * 虚拟化文章列表必须保留 JS 补偿（原生认不出垫片内绝对定位行整体平移）。
   * 关闭补偿后仍然照常统计 `headIds / newIds` 并回调 `onHeadAdditions`，
   * 所以新增条数 Toast 与未读串点不受影响。
   */
  compensate?: boolean;
  /**
   * 发现刷新带来新条目时回调：
   * - `headIds` = 插在**列表最前面**的 id（按列表顺序，用来判断要不要补偿滚动）；
   * - `newIds` = 这次更新里**新增到已加载列表里**的全部 id（新条目可能按发布时间
   *   插在两条旧条目之间，只数头部会漏；尾部翻页追加的不算 —— 只看到 `prevLength` 为止）；
   * - `atTop` = 触发时列表是否在最顶端。
   */
  onHeadAdditions?: (headIds: string[], newIds: string[], atTop: boolean) => void;
}

interface Anchor {
  id: string;
  /** 锚点元素当时的屏幕 top（视口坐标系） */
  top: number;
}

/**
 * 头部新增条目的 id：从第 0 条开始，直到遇到一条「上一轮就存在」的条目为止。
 *
 * 为什么不用「全部新增 id 的集合」：翻下一页是往**尾部**追加，不能算新条目；
 * 只有出现在第一个旧条目之前的才叫「插到前面」。
 */
export function findHeadAdditionIds(
  prevIds: ReadonlySet<string>,
  entries: readonly Entry[],
): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (prevIds.has(entry.id)) break;
    ids.push(entry.id);
  }
  return ids;
}

function findEntryNode(root: HTMLElement | null, id: string): HTMLElement | null {
  if (!root) return null;
  return (
    Array.from(root.querySelectorAll<HTMLElement>("[data-entry-id]")).find(
      (node) => node.dataset.entryId === id,
    ) ?? null
  );
}

export function usePrependScrollAnchor({
  surface,
  contentRootRef,
  entries,
  resetKey,
  enabled,
  pausedRef,
  compensate = true,
  onHeadAdditions,
}: UsePrependScrollAnchorOptions): void {
  const prevIdsRef = useRef<Set<string> | null>(null);
  const resetKeyRef = useRef(resetKey);
  const anchorsRef = useRef<Anchor[]>([]);
  /** 我们自己补偿 scrollTop 时置位，避免把补偿引起的滚动当成用户滚动重新量锚点 */
  const compensatingRef = useRef(false);
  /** 上一次滚动事件的时间：滚动中的锚点坐标会变，先让用户滚，停稳后再兜底 */
  const lastScrollAtRef = useRef(0);
  /** 滚动停稳后的兜底检查（图片晚一帧加载也能接住） */
  const idleStabilizeTimer = useRef<number | null>(null);
  /** DEV 诊断去重：同样的 entries 摘要不反复打日志 */
  const entriesLogSigRef = useRef("");

  /**
   * 补偿后的锁定：`{ id, top }` = 要把哪条钉在什么屏幕位置。
   * 每帧量一次，偏了就补；偏的幅度和上一帧**一模一样**说明滚动没生效（jsdom / 布局未更新），
   * 直接放弃，免得空转。
   */
  const lockRef = useRef<{
    id: string;
    top: number;
    deadline: number;
    framesLeft: number;
    lastDelta: number | null;
  } | null>(null);

  const stopLock = useCallback(() => {
    lockRef.current = null;
  }, []);

  const measureAnchors = useCallback(() => {
    const root = contentRootRef.current;
    if (!root) {
      anchorsRef.current = [];
      return;
    }
    const viewportTop = surface.getViewportRect().top;
    const anchors: Anchor[] = [];
    for (const item of root.querySelectorAll<HTMLElement>("[data-entry-id]")) {
      if (anchors.length >= ANCHOR_CANDIDATES) break;
      const rect = item.getBoundingClientRect();
      if (rect.bottom > viewportTop) {
        const id = item.dataset.entryId;
        if (id) anchors.push({ id, top: rect.top });
      }
    }
    anchorsRef.current = anchors;
  }, [contentRootRef, surface]);

  // 滚动 / 尺寸变化时保持「当前可见锚点」是最新的；没有这个，用户滚动后再刷新就会拿旧坐标补偿。
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (compensatingRef.current) return;
      measureAnchors();
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };
    const unsubscribe =
      typeof surface.subscribe === "function"
        ? surface.subscribe(() => {
            lastScrollAtRef.current = Date.now();
            schedule();
          })
        : () => undefined;
    const handleResize = () => schedule();
    window.addEventListener("resize", handleResize);
    measure();
    return () => {
      unsubscribe();
      window.removeEventListener("resize", handleResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, measureAnchors, surface]);

  // 每次 entries 变化后刷新一次锚点（图片加载、翻译换字导致的行高变化）
  useEffect(() => {
    if (!enabled) return;
    measureAnchors();
    if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
      // 诊断用：能确认「这份代码真的加载了」以及「刷新后 entries 到底有没有换」；
      // 条数/首条没变就不重复刷屏（刷新中每 2 秒重拉一次会打很多行）
      const signature = `${entries.length}:${entries[0]?.id ?? ""}:${entries.at(-1)?.id ?? ""}`;
      if (signature !== entriesLogSigRef.current) {
        entriesLogSigRef.current = signature;
        console.log("[krss-anchor] entries", {
          n: entries.length,
          first: entries[0]?.id ?? null,
          last: entries.at(-1)?.id ?? null,
        });
      }
    }
  }, [enabled, entries, measureAnchors]);

  useEffect(() => {
    if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
      console.log("[krss-anchor] hook mounted");
    }
  }, []);

  /**
   * 通用内容位移兜底（2026-10-29 用户复测：新条目那块好了，但「图片加载后把列表滚动」还在）。
   *
   * `overflow-anchor:none` 下浏览器不管，图片/翻译异步把行高撑开就会把视口推走。
   * 这里用 ResizeObserver 盯列表内容层：尺寸一变就量锚点、偏多少补多少。
   * 用户正在滚动时不动（锚点坐标本来就是滚出来的），停稳 220ms 后再兜底。
   */
  useEffect(() => {
    if (!enabled) return;
    const root = contentRootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    let observed: Element | null = null;

    const stabilize = () => {
      frame = 0;
      if (!compensate) return;
      if (pausedRef?.current || lockRef.current || compensatingRef.current) return;
      const scroller = contentRootRef.current;
      if (!scroller) return;
      if (surface.getScrollTop() <= AT_TOP_THRESHOLD_PX) return;
      // 用户刚滚过：先让锚点测量跟上，停稳后再看
      if (Date.now() - lastScrollAtRef.current < 200) {
        if (idleStabilizeTimer.current !== null) {
          window.clearTimeout(idleStabilizeTimer.current);
        }
        idleStabilizeTimer.current = window.setTimeout(() => {
          idleStabilizeTimer.current = null;
          schedule();
        }, 220);
        return;
      }

      let chosen: { id: string; top: number } | null = null;
      for (const candidate of anchorsRef.current) {
        if (findEntryNode(scroller, candidate.id)) {
          chosen = candidate;
          break;
        }
      }
      if (!chosen) {
        measureAnchors();
        return;
      }
      const node = findEntryNode(scroller, chosen.id);
      if (!node) return;
      const delta = node.getBoundingClientRect().top - chosen.top;
      if (Math.abs(delta) < 0.5) return;

      compensatingRef.current = true;
      surface.scrollBy(delta);
      anchorsRef.current = [
        { id: chosen.id, top: chosen.top },
        ...anchorsRef.current.filter((item) => item.id !== chosen.id),
      ];
      requestAnimationFrame(() => {
        compensatingRef.current = false;
      });
      if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
        console.log("[krss-anchor] stabilize", { delta, anchorId: chosen.id });
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(stabilize);
    };

    const observer = new ResizeObserver(schedule);
    const attach = () => {
      const target = root.firstElementChild;
      if (target === observed) return;
      if (observed) observer.unobserve(observed);
      observed = target;
      if (observed) observer.observe(observed);
    };
    attach();

    // 骨架屏 → 列表、空态 → 列表会把 firstElementChild 换掉，换掉后重新 observe
    const mutation = new MutationObserver(() => {
      attach();
      schedule();
    });
    mutation.observe(root, { childList: true });

    return () => {
      observer.disconnect();
      mutation.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (idleStabilizeTimer.current !== null) {
        window.clearTimeout(idleStabilizeTimer.current);
        idleStabilizeTimer.current = null;
      }
    };
  }, [compensate, contentRootRef, enabled, measureAnchors, pausedRef, surface]);

  // 用户一旦自己滚/点/按键，立刻解锁 —— 锁定只服务于「插入造成的位移」，不能跟用户抢。
  useEffect(() => {
    const cancel = () => stopLock();
    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("pointerdown", cancel, { passive: true });
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("touchstart", cancel);
      window.removeEventListener("pointerdown", cancel);
      window.removeEventListener("keydown", cancel);
      stopLock();
    };
  }, [stopLock]);

  const startLock = useCallback(
    (anchor: Anchor) => {
      const tick = () => {
        const lock = lockRef.current;
        if (!lock) return;
        // 程序化回顶（Toast / 回到顶部按钮）也会走这里：别再跟它抢
        if (pausedRef?.current) {
          lockRef.current = null;
          return;
        }
        if (lock.framesLeft <= 0 || performance.now() > lock.deadline) {
          lockRef.current = null;
          return;
        }
        lock.framesLeft -= 1;

        const node = findEntryNode(contentRootRef.current, lock.id);
        if (!node) {
          lockRef.current = null;
          return;
        }
        const delta = node.getBoundingClientRect().top - lock.top;
        if (Math.abs(delta) >= 0.5) {
          // 同一帧里反复要求同样幅度的补偿 ⇒ 滚动没起作用（jsdom / 布局还没更新），放弃
          if (lock.lastDelta !== null && Math.abs(lock.lastDelta - delta) < 0.5) {
            lockRef.current = null;
            return;
          }
          lock.lastDelta = delta;
          compensatingRef.current = true;
          surface.scrollBy(delta);
          requestAnimationFrame(() => {
            compensatingRef.current = false;
          });
        }

        requestAnimationFrame(tick);
      };
      lockRef.current = {
        id: anchor.id,
        top: anchor.top,
        deadline: performance.now() + ANCHOR_LOCK_MS,
        framesLeft: ANCHOR_LOCK_MAX_FRAMES,
        lastDelta: null,
      };
      requestAnimationFrame(tick);
    },
    [contentRootRef, pausedRef, surface],
  );

  useLayoutEffect(() => {
    const currentIds = new Set(entries.map((entry) => entry.id));

    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      prevIdsRef.current = currentIds;
      anchorsRef.current = [];
      stopLock();
      return;
    }

    const prevIds = prevIdsRef.current;
    if (!prevIds) {
      prevIdsRef.current = currentIds;
      return;
    }

    const headIds = findHeadAdditionIds(prevIds, entries);
    // 刷新可能把新条目插在两条旧条目之间（发布时间排序），只数头部会少报；
    // 但翻下一页是往尾部追加旧条目，所以只看「上一轮已有的条数」以内。
    const prevLength = prevIds.size;
    const newIds = entries
      .slice(0, prevLength)
      .filter((entry) => !prevIds.has(entry.id))
      .map((entry) => entry.id);
    prevIdsRef.current = currentIds;
    if (newIds.length === 0 || !enabled) return;

    const scrolled = surface.getScrollTop();
    const atTop = scrolled <= AT_TOP_THRESHOLD_PX;
    const root = contentRootRef.current;

    // 第一条锚点可能正好被这次刷新换掉；用记下来的前几条里第一条还活着的来算。
    let chosen: Anchor | null = null;
    for (const candidate of anchorsRef.current) {
      if (!findEntryNode(root, candidate.id)) continue;
      chosen = candidate;
      break;
    }

    let delta = 0;
    if (!compensate) {
      // 交给浏览器的原生 anchoring：这里只把锚点坐标刷新成「补偿之后」的真实值，
      // 免得后面的记账还拿着上一帧的旧数字。
      measureAnchors();
    } else if (!atTop && chosen) {
      const node = findEntryNode(root, chosen.id);
      if (node) {
        const nextTop = node.getBoundingClientRect().top;
        delta = nextTop - chosen.top;
        if (Math.abs(delta) >= 0.5) {
          compensatingRef.current = true;
          surface.scrollBy(delta);
          requestAnimationFrame(() => {
            compensatingRef.current = false;
          });
        }
        const locked: Anchor = { id: chosen.id, top: chosen.top };
        anchorsRef.current = [locked, ...anchorsRef.current.filter((a) => a.id !== locked.id)];
        // 提交后异步落下来的高度变化（图片/翻译）也拉回锚点
        startLock(locked);
      }
    }

    if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
      console.log("[krss-anchor] prepend", {
        head: headIds.length,
        added: newIds.length,
        atTop,
        anchorId: chosen?.id ?? null,
        anchorTop: chosen?.top ?? null,
        delta,
        scrollTop: scrolled,
      });
    }

    onHeadAdditions?.(headIds, newIds, atTop);
  }, [
    compensate,
    contentRootRef,
    enabled,
    entries,
    measureAnchors,
    onHeadAdditions,
    resetKey,
    startLock,
    stopLock,
    surface,
  ]);
}