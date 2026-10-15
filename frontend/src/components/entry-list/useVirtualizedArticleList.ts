import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  useVirtualizer,
  useWindowVirtualizer,
  type ReactVirtualizer,
} from "@tanstack/react-virtual";
import type { Entry } from "@/types/api";
import type { ScrollSurface } from "./scroll-surface";

/**
 * 标准文章列表扁平流的虚拟化（`type=article` + list 档专用）。
 *
 * 只解决「50 张卡全挂 DOM」：首屏只挂载可视区 + overscan 行，其余用总高度垫片占位。
 * 行高动态测量（`measureElement`）：每张卡文本/缩略图长短不一，估计值只做首屏占位，
 * 真实高度以挂载后实测为准 —— 长短卡混排不会错位。
 *
 * 不碰的东西（行为一字不动）：
 * - 滚动位置还原（`scroll-key` + `entryListScrollPositions`）：还是原来那套 effect，
 *   虚拟化只消费还原后的 scrollTop，不接管。
 * - 滚动标已读 / 预载 / 翻译调度：它们按 `[data-entry-id]` 认行，行还是同一份
 *   `EntryListItem`（props 接口不变，只包虚拟容器），querySelector 全能命中。
 * - 多选 / 悬停浮层：虚拟容器只包 list 档，hover 档（`isArticleHover`）走原路径。
 */
export interface UseVirtualizedArticleListOptions {
  enabled: boolean;
  scrollSurface: ScrollSurface;
  scrollKey: string;
  containerRef: RefObject<HTMLDivElement | null>;
  entries: Entry[];
}

/** 首屏占位用的估计行高（下一张卡实测后即被替换，只影响首屏瞬间） */
export const VIRTUAL_ARTICLE_ESTIMATE_PX = 148;
/** 可视区上下各多渲染的行数（滚动时不白屏，又不至于挂太多 DOM） */
export const VIRTUAL_ARTICLE_OVERSCAN = 8;

export interface VirtualizedArticleListState {
  virtualizer: ReactVirtualizer<HTMLDivElement, HTMLElement> | null;
  windowVirtualizer: ReactVirtualizer<Window, HTMLElement> | null;
  spacers: WeakMap<Entry[], { top: number; bottom: number }>;
}

export function useVirtualizedArticleList({
  enabled,
  scrollSurface,
  scrollKey,
  containerRef,
  entries,
}: UseVirtualizedArticleListOptions): VirtualizedArticleListState {
  const documentScroll = scrollSurface.kind === "document";
  const active = enabled && !documentScroll;
  const windowActive = enabled && documentScroll;

  const spacers = useMemo(
    () => new WeakMap<Entry[], { top: number; bottom: number }>(),
    [],
  );

  /**
   * 列表身份：换订阅/视图/内容类型时清掉上一份列表的实测行高。
   * 不清的话，新列表首屏会先按旧列表每行的高度排（切订阅瞬间错位一帧）。
   * invalidate 标记打在「下一份」上：当前渲染用的还是旧 entries 引用时不碰，
   * 等新 entries 进来那次渲染才清 —— 否则清早了，当前屏的行全回估计值。
   */
  const listIdentityRef = useRef(scrollKey);
  const pendingIdentityRef = useRef<string | null>(null);
  if (listIdentityRef.current !== scrollKey) {
    listIdentityRef.current = scrollKey;
    pendingIdentityRef.current = scrollKey;
  }
  // 已读态/筛选变化会换 entries 引用但不是换列表：只认 scrollKey，不认引用。
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const itemKeyOf = (index: number): string => {
    const list = entriesRef.current;
    return list[index]?.id ?? `index:${index}`;
  };

  const elementVirtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    enabled: active,
    count: entries.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => VIRTUAL_ARTICLE_ESTIMATE_PX,
    overscan: VIRTUAL_ARTICLE_OVERSCAN,
    getItemKey: itemKeyOf,
  });

  const winVirtualizer = useWindowVirtualizer<HTMLElement>({
    enabled: windowActive,
    count: entries.length,
    estimateSize: () => VIRTUAL_ARTICLE_ESTIMATE_PX,
    overscan: VIRTUAL_ARTICLE_OVERSCAN,
    getItemKey: itemKeyOf,
  });

  const virtualizer = active ? elementVirtualizer : null;
  const windowVirtualizer = windowActive ? winVirtualizer : null;

  // 新列表进来时清实测缓存（见上面的 pendingIdentity 标记）。
  useEffect(() => {
    if (pendingIdentityRef.current === null) return;
    pendingIdentityRef.current = null;
    elementVirtualizer.measurementsCache = [];
    winVirtualizer.measurementsCache = [];
    elementVirtualizer.itemSizeCache.clear();
    winVirtualizer.itemSizeCache.clear();
  }, [elementVirtualizer, entries, winVirtualizer]);

  return { virtualizer, windowVirtualizer, spacers };
}
