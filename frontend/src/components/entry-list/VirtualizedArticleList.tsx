import type { CSSProperties, ReactNode } from "react";
import type { Entry } from "@/types/api";
import type { VirtualizedArticleListState } from "./useVirtualizedArticleList";

interface VirtualizedArticleListProps {
  virtualList: VirtualizedArticleListState;
  entries: Entry[];
  /** 与原 `entries.map` 里那份 `EntryListItem` 一字不差（props 接口不变） */
  renderItem: (entry: Entry, index: number) => ReactNode;
  /**
   * 行内会吸顶内容（合列正文 pane 的 sticky 工具栏）时置 true：
   * 用 `top` 定位代替 `transform: translateY`，避免 transform 祖先破坏 sticky。
   * 普通列表保持 transform（合成层更省）。
   */
  disableTransform?: boolean;
}

/**
 * 虚拟容器：只包标准文章列表扁平流（type=article + list 档）。
 *
 * 结构：顶垫片（已滚过行的总高度）+ 可见行（绝对定位，按实测 start 排）+ 底垫片。
 * 可见行就是原 `entries.map` 里那份 `EntryListItem` —— `data-index` /
 * `data-entry-id` / 全部 props 原样透传，滚动标已读、预载、翻译调度、悬停委托、
 * 多选认行全不受影响。
 *
 * 虚拟库测不到尺寸时（jsdom 单测：offsetWidth/offsetHeight 全 0）的回退：
 * 还渲染**全部**行 —— 单测里 5 条不断言虚拟裁剪（不断言的东西不该变），
 * 回归测试用 50 条 + 真实尺寸断言首屏裁剪。
 */
export function VirtualizedArticleList({
  virtualList,
  entries,
  renderItem,
  disableTransform = false,
}: VirtualizedArticleListProps) {
  const { virtualizer, windowVirtualizer, spacers } = virtualList;
  const active = virtualizer ?? windowVirtualizer;

  if (!active) {
    return <>{entries.map((entry, index) => renderItem(entry, index))}</>;
  }

  const virtualItems = active.getVirtualItems();
  // jsdom / 首帧回退：测不到容器尺寸时 range 为空。首帧绝不能把 50 张大卡片
  // 全量挂载（会抵消虚拟化收益），最多先渲染前 12 行；小列表（<=12）仍全量，
  // 保持既有 jsdom 回归测试语义。
  const FALLBACK_ROWS = 12;
  const fallbackEntries =
    entries.length > FALLBACK_ROWS ? entries.slice(0, FALLBACK_ROWS) : entries;
  const items =
    virtualItems.length > 0
      ? virtualItems
      : fallbackEntries.map((entry, index) => ({
          key: entry.id,
          index,
          start: 0,
        }));

  let top = 0;
  let bottom = 0;
  if (virtualItems.length > 0) {
    const cached = spacers.get(entries);
    const total = active.getTotalSize();
    const first = virtualItems[0];
    const last = virtualItems[virtualItems.length - 1];
    if (cached && first && last) {
      top = cached.top;
      bottom = cached.bottom;
    } else if (first && last) {
      top = Math.max(0, first.start);
      bottom = Math.max(0, total - last.end);
      spacers.set(entries, { top, bottom });
    }
  }

  const rowStyle = (start: number): CSSProperties | undefined =>
    virtualItems.length > 0
      ? disableTransform
        ? { position: "absolute", top: start, left: 0, width: "100%" }
        : { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${start}px)` }
      : undefined;

  return (
    <div
      data-virtual-list="true"
      style={
        virtualItems.length > 0
          ? {
              position: "relative",
              height: `${active.getTotalSize()}px`,
              width: "100%",
            }
          : undefined
      }
    >
      {top > 0 && <div aria-hidden="true" style={{ height: `${top}px` }} />}
      {items.map((item) => {
        const entry = entries[item.index];
        if (!entry) return null;
        // 注意：wrapper 只带 data-index（给 measureElement 认行），不带
        // data-entry-id —— 行本体的 EntryListItem 自带它。两处都带会导致
        // querySelectorAll('[data-entry-id]') 一行命中两次（序号浮标翻倍、
        // 滚动标已读重复观察）。
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={active.measureElement}
            style={rowStyle(item.start)}
          >
            {renderItem(entry, item.index)}
          </div>
        );
      })}
      {bottom > 0 && <div aria-hidden="true" style={{ height: `${bottom}px` }} />}
    </div>
  );
}
