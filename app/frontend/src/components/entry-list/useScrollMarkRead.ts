import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useMarkManyAsRead, useRemoveFromUnreadList } from "@/hooks/useEntries";
import type { Entry } from "@/types/api";
import type { ScrollSurface } from "./scroll-surface";

const MARK_READ_ON_SCROLL_BATCH_DELAY_MS = 200;
const MARK_READ_ON_SCROLL_GRACE_MS = 1000;
/** 「看到即已读」（Folo 语义）下，条目需在视口停留这么久才算读过 */
const MARK_READ_ON_VISIBLE_DWELL_MS = 600;

/** 滚动已读的判定时机 */
export type ScrollMarkReadTiming = "scrollPast" | "onVisible";

interface UseScrollMarkReadOptions {
  surface: ScrollSurface;
  contentRootRef: RefObject<HTMLDivElement | null>;
  entries: Entry[];
  enabled: boolean;
  unreadOnly: boolean;
  hasNextPage: boolean;
  resetKey: string;
  /** 滚出顶部才算读过（默认）／进入视口停留片刻就算读过（Folo 语义） */
  timing?: ScrollMarkReadTiming;
  /**
   * 20-3（用户 2026-09-18）：标成已读后**先不摘掉**这些条目（默认 true）。
   *
   * 边滚边摘会把下面的条目往上顶（往回滚时最容易看到「位置在跳」）；
   * 推迟到「离开当前列表」时（`resetKey` 变化）一次摘掉 —— 也就是用户要的
   * 「切换离开当前视图 / 换订阅再回来，这些已读条目才消失」。
   */
  deferRemoval?: boolean;
}

interface UseScrollMarkReadResult {
  endPaddingHeight: number;
}

export function useScrollMarkRead({
  surface,
  contentRootRef,
  entries,
  enabled,
  unreadOnly,
  hasNextPage,
  resetKey,
  timing = "scrollPast",
  deferRemoval = true,
}: UseScrollMarkReadOptions): UseScrollMarkReadResult {
  const { mutate: markManyAsRead } = useMarkManyAsRead();
  const removeFromUnreadList = useRemoveFromUnreadList();
  const seenEntryIds = useRef(new Set<string>());
  const markedReadIds = useRef(new Set<string>());
  /**
   * 20-3：延迟摘除模式下，本段滚动标成已读、但**还没**从「只看未读」列表里摘掉的条目。
   * 离开这个列表（`resetKey` 变化）时一次性摘掉。
   */
  const deferredRemovalIds = useRef(new Set<string>());
  const pendingReadEntries = useRef(new Map<string, number>());
  const dwellTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const batchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const session = useRef(0);
  const graceUntil = useRef(0);
  /**
   * 「看到即已读」（onVisible）下的连锁问题：
   * 一屏条目停留 600ms 就标已读 → 在「只看未读」列表里被移除 → 列表上移把下一屏顶进视口 →
   * 又停留 600ms 又标已读……用户什么都没做，整列表自己读完消失了（实测 12 秒掉 15 条）。
   * 所以一批标记完成后，必须等用户真的再滚一次才继续判定。
   */
  const awaitingUserScroll = useRef(false);
  /** 自己补偿滚动的时间窗，用来把自己触发的 scroll 事件和用户滚动区分开 */
  const programmaticScrollUntil = useRef(0);
  const [observerVersion, setObserverVersion] = useState(0);
  const endPaddingHeightRef = useRef(0);
  const [scrollLayout, setScrollLayout] = useState({
    containerHeight: 0,
    naturalContentOverflows: false,
  });

  const entriesIdentityKey = useMemo(
    () => entries.map((entry) => entry.id).join("\u0000"),
    [entries],
  );
  const hasUnreadEntries = useMemo(
    () => entries.some((entry) => !entry.read),
    [entries],
  );
  const endPaddingHeight =
    enabled &&
    hasUnreadEntries &&
    !hasNextPage &&
    scrollLayout.naturalContentOverflows
      ? scrollLayout.containerHeight
      : 0;

  useEffect(() => {
    endPaddingHeightRef.current = endPaddingHeight;
  }, [endPaddingHeight]);

  const measureScrollLayout = useCallback(() => {
    const contentRoot = contentRootRef.current;
    if (!contentRoot) return;

    const containerHeight = surface.getViewportRect().height;
    const naturalScrollHeight = Math.max(
      0,
      contentRoot.scrollHeight - endPaddingHeightRef.current,
    );
    const naturalContentOverflows = naturalScrollHeight > containerHeight + 1;

    setScrollLayout((current) => {
      if (
        current.containerHeight === containerHeight &&
        current.naturalContentOverflows === naturalContentOverflows
      ) {
        return current;
      }

      return { containerHeight, naturalContentOverflows };
    });
  }, [contentRootRef, surface]);

  useEffect(() => {
    const contentRoot = contentRootRef.current;
    if (!contentRoot) return;

    measureScrollLayout();
    const handleResize = () => measureScrollLayout();
    if (surface.kind === "document") {
      window.addEventListener("resize", handleResize);
    }

    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", handleResize);
    }

    const observer = new ResizeObserver(measureScrollLayout);
    observer.observe(contentRoot);
    for (const child of Array.from(contentRoot.children)) {
      observer.observe(child);
    }

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [contentRootRef, measureScrollLayout, surface.kind]);

  useEffect(() => {
    measureScrollLayout();
  }, [entriesIdentityKey, enabled, hasNextPage, measureScrollLayout]);

  useEffect(() => {
    /**
     * 20-3：离开这个列表（换订阅 / 换视图 / 换内容类型 —— `resetKey` 就是这三样的组合）时，
     * 把上一段滚动标掉的条目**一次摘掉**：回来时它们就不在了。
     * 这就是用户要的「切换离开当前视图、或换订阅再回来，这些已读条目才消失」——
     * 延迟摘除模式下 flush 阶段不摘（否则条目被往上顶）。
     */
    if (deferredRemovalIds.current.size > 0) {
      removeFromUnreadList(new Set(deferredRemovalIds.current));
      deferredRemovalIds.current.clear();
    }

    seenEntryIds.current.clear();
    markedReadIds.current.clear();
    pendingReadEntries.current.clear();
    awaitingUserScroll.current = false;
    session.current += 1;

    if (batchTimer.current) {
      clearTimeout(batchTimer.current);
      batchTimer.current = null;
    }
    if (graceTimer.current) {
      clearTimeout(graceTimer.current);
      graceTimer.current = null;
    }
  }, [removeFromUnreadList, resetKey]);

  useEffect(() => {
    return () => {
      if (batchTimer.current) {
        clearTimeout(batchTimer.current);
        batchTimer.current = null;
      }
      if (graceTimer.current) {
        clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    seenEntryIds.current.clear();
    graceUntil.current = Date.now() + MARK_READ_ON_SCROLL_GRACE_MS;
    if (graceTimer.current) {
      clearTimeout(graceTimer.current);
    }
    graceTimer.current = setTimeout(() => {
      graceTimer.current = null;
      setObserverVersion((version) => version + 1);
    }, MARK_READ_ON_SCROLL_GRACE_MS);

    return () => {
      if (graceTimer.current) {
        clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
    };
  }, [entriesIdentityKey, enabled]);

  useEffect(() => {
    if (!enabled) return;

    // 容错：单测里的 surface 桩可能没实现 subscribe
    if (typeof surface.subscribe !== "function") return;

    const unsubscribe = surface.subscribe(() => {
      // 自己为补偿高度做的滚动不算「用户滚了」
      if (Date.now() < programmaticScrollUntil.current) return;
      if (!awaitingUserScroll.current) return;

      awaitingUserScroll.current = false;
      // 重新观察一遍：让此刻在视口里的条目重新开始计时
      setObserverVersion((version) => version + 1);
    });

    return unsubscribe;
  }, [enabled, surface]);

  const flushReadQueue = useCallback(() => {
    if (batchTimer.current) {
      clearTimeout(batchTimer.current);
      batchTimer.current = null;
    }

    const pendingEntries = pendingReadEntries.current;
    if (pendingEntries.size === 0) return;

    const ids = Array.from(pendingEntries.keys());
    const removedHeight = Array.from(pendingEntries.values()).reduce(
      (sum, height) => sum + height,
      0,
    );
    const currentSession = session.current;
    pendingEntries.clear();

    markManyAsRead(
      { ids, read: true, skipInvalidate: true },
      {
        onSuccess: () => {
          if (!unreadOnly || session.current !== currentSession) return;

          /**
           * 20-3（默认档）：**先不摘**。记账到 deferredRemovalIds，等离开这个列表时一起摘。
           * 不摘就不会把下面的条目往上顶，也就不需要「补偿滚动」和「等用户再滚一次」那套自锁。
           */
          if (deferRemoval) {
            for (const id of ids) deferredRemovalIds.current.add(id);
            return;
          }

          removeFromUnreadList(new Set(ids));
          // 别让「移除 → 顶上来 → 再标」自己转起来
          awaitingUserScroll.current = true;

          if (removedHeight <= 0) return;
          requestAnimationFrame(() => {
            if (session.current !== currentSession) return;
            programmaticScrollUntil.current = Date.now() + 200;
            surface.scrollBy(-removedHeight);
          });
        },
        onError: () => {
          for (const id of ids) {
            markedReadIds.current.delete(id);
            seenEntryIds.current.delete(id);
          }
        },
      },
    );
  }, [markManyAsRead, removeFromUnreadList, surface, unreadOnly, deferRemoval]);

  const queueRead = useCallback(
    (entryId: string, removedHeight: number) => {
      if (!pendingReadEntries.current.has(entryId)) {
        pendingReadEntries.current.set(entryId, removedHeight);
      }
      if (batchTimer.current) return;

      const remainingGraceMs = Math.max(0, graceUntil.current - Date.now());
      batchTimer.current = setTimeout(
        flushReadQueue,
        remainingGraceMs + MARK_READ_ON_SCROLL_BATCH_DELAY_MS,
      );
    },
    [flushReadQueue],
  );

  useEffect(() => {
    const contentRoot = contentRootRef.current;
    if (
      !enabled ||
      !contentRoot ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const unreadIds = new Set(
      entries.filter((entry) => !entry.read).map((entry) => entry.id),
    );
    if (unreadIds.size === 0) return;

    const viewport = surface.getViewportRect();
    const rootMargin =
      surface.kind === "document"
        ? `-${Math.ceil(viewport.top)}px 0px 0px 0px`
        : "0px";
    const observer = new IntersectionObserver(
      (items) => {
        for (const item of items) {
          const target = item.target as HTMLElement;
          const entryId = target.dataset.entryId;
          if (
            !entryId ||
            !unreadIds.has(entryId) ||
            markedReadIds.current.has(entryId)
          ) {
            continue;
          }

          if (item.isIntersecting) {
            seenEntryIds.current.add(entryId);

            // Folo 语义：进入视口后停留片刻即视为已读
            if (timing === "onVisible" && !dwellTimers.current.has(entryId)) {
              const timer = setTimeout(() => {
                dwellTimers.current.delete(entryId);
                if (markedReadIds.current.has(entryId)) return;
                // 上一批刚移除完、用户还没再滚，先不判
                if (awaitingUserScroll.current) return;

                const node = contentRoot.querySelector<HTMLElement>(
                  `[data-entry-id="${entryId}"]`,
                );
                const rect = node?.getBoundingClientRect();
                const viewportRect = surface.getViewportRect();
                // 定时器到点后再确认一次仍在视口内（快速划过不留痕）
                if (
                  !rect ||
                  rect.bottom < viewportRect.top ||
                  rect.top > viewportRect.bottom
                ) {
                  return;
                }

                markedReadIds.current.add(entryId);
                queueRead(entryId, rect.height || node?.offsetHeight || 0);
              }, MARK_READ_ON_VISIBLE_DWELL_MS);

              dwellTimers.current.set(entryId, timer);
            }
            continue;
          }

          const pendingDwell = dwellTimers.current.get(entryId);
          if (pendingDwell) {
            clearTimeout(pendingDwell);
            dwellTimers.current.delete(entryId);
          }

          if (timing === "onVisible") {
            continue;
          }

          const rootTop = item.rootBounds?.top ?? surface.getViewportRect().top;
          if (
            !seenEntryIds.current.has(entryId) ||
            item.boundingClientRect.bottom > rootTop
          ) {
            continue;
          }

          markedReadIds.current.add(entryId);
          const removedHeight =
            target.getBoundingClientRect().height || target.offsetHeight || 0;
          queueRead(entryId, removedHeight);
        }
      },
      {
        root: surface.getIntersectionRoot(),
        rootMargin,
        threshold: 0,
      },
    );

    const visibleRect = surface.getViewportRect();
    for (const item of contentRoot.querySelectorAll<HTMLElement>(
      "[data-entry-id]",
    )) {
      const entryId = item.dataset.entryId;
      if (
        !entryId ||
        !unreadIds.has(entryId) ||
        markedReadIds.current.has(entryId)
      ) {
        continue;
      }

      const itemRect = item.getBoundingClientRect();
      if (
        itemRect.bottom > visibleRect.top &&
        itemRect.top < visibleRect.bottom
      ) {
        seenEntryIds.current.add(entryId);
      }
      observer.observe(item);
    }

    return () => {
      observer.disconnect();
      for (const timer of dwellTimers.current.values()) clearTimeout(timer);
      dwellTimers.current.clear();
    };
  }, [contentRootRef, entries, enabled, observerVersion, queueRead, surface, timing]);

  return { endPaddingHeight };
}
