/**
 * 23-4：正文阅读进度的**纯计算**部分（与 DOM 解耦，便于单测）。
 *
 * 正文滚动容器在本项目里是**元素滚动**（`EntryContentBody` 的 `.entry-content-viewport`，
 * `overflow-y: auto` + `flex-1`），不是文档滚动；移动端的文档滚动只服务列表
 * （`html.mobile-document-scroll`），进详情时文档滚动被锁
 * （`mobile-document-scroll-locked`），所以正文始终是那个元素在滚。
 * 组件侧拿到的就是那个真实滚动节点（`useEntryContentScroll().scrollNode`）。
 */

export interface ScrollMetrics {
  scrollTop: number;
  /** 内容总高 */
  scrollHeight: number;
  /** 可视区高 */
  clientHeight: number;
}

export interface ReadingProgress {
  /** 0–100，可直接喂给 HeroUI `ProgressBar` 的 `value` */
  percent: number;
  /** 可滚动距离（px）：<= 0 表示这一屏根本没得滚（短正文 / 还没渲染完） */
  scrollable: number;
}

/** 1px 容差：浏览器在 DPR / 缩放下的 scrollHeight-clientHeight 会差零点几像素 */
const EPSILON = 1;

export function computeReadingProgress(metrics: ScrollMetrics): ReadingProgress {
  const scrollable = metrics.scrollHeight - metrics.clientHeight;
  if (scrollable <= EPSILON) {
    return { percent: 0, scrollable: Math.max(0, scrollable) };
  }
  const ratio = metrics.scrollTop / scrollable;
  return {
    percent: Math.min(100, Math.max(0, ratio * 100)),
    scrollable,
  };
}
