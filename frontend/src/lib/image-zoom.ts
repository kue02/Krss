/** 图片缩放的纯计算部分（便于单测，不碰 DOM） */

export const MIN_IMAGE_SCALE = 1;
export const MAX_IMAGE_SCALE = 4;

/** 把一个缩放值夹在允许范围内 */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_IMAGE_SCALE;
  return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale));
}

/**
 * 放大后拖动时，限制平移量，保证图片不会被拖出容器。
 *
 * 允许范围由「图片实际渲染尺寸 × 缩放」与容器尺寸的差决定：
 * 图片比容器小（letterbox）时，即使放大到 2x 也可能还没有溢出，此时不应允许平移。
 * `image` 省略时退回按容器尺寸计算，保持旧调用方的语义。
 */
export function clampOffset(
  offset: { x: number; y: number },
  scale: number,
  container: { width: number; height: number },
  image: { width: number; height: number } = container,
): { x: number; y: number } {
  const maxX = Math.max(0, (image.width * scale - container.width) / 2);
  const maxY = Math.max(0, (image.height * scale - container.height) / 2);
  return {
    // + 0 是为了把 -0 归一成 0，免得调用方拿到看似相同却不相等的值
    x: Math.min(maxX, Math.max(-maxX, offset.x)) + 0,
    y: Math.min(maxY, Math.max(-maxY, offset.y)) + 0,
  };
}

/**
 * 双击/双指缩放时，让锚点位置保持不动所需的平移量。
 * point 为相对容器中心的坐标。
 *
 * `currentOffset` 是缩放前的平移量；变换是 `translate(offset) scale(scale)`，
 * 因此已有平移也会被缩放放大，不能直接丢掉（否则 2x→3x 时图片会跳走）。
 */
export function offsetForZoomAt(
  point: { x: number; y: number },
  fromScale: number,
  toScale: number,
  currentOffset: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  if (fromScale <= 0) return { x: 0, y: 0 };
  const ratio = toScale / fromScale;
  return {
    x: point.x * (1 - ratio) + currentOffset.x * ratio + 0,
    y: point.y * (1 - ratio) + currentOffset.y * ratio + 0,
  };
}

/** 滚轮/捏合的下一个缩放值（指数步进，手感更均匀） */
export function nextScale(current: number, delta: number): number {
  return clampScale(current * Math.exp(-delta / 400));
}

/** 一次点按记录：时间戳 + 屏幕坐标 */
export interface TapPoint {
  t: number;
  x: number;
  y: number;
}

/**
 * 判定当前点按能否与上一次点按组成「双击」。
 * 纯函数，触屏在 pointerup 里提前判定（避免多等一次 click 造成慢半拍），
 * 鼠标走原生路径，两处共用同一套阈值语义。
 */
export function isDoubleTap(
  last: TapPoint | null,
  now: number,
  x: number,
  y: number,
  maxGapMs: number,
  slop: number,
): boolean {
  if (!last) return false;
  if (now - last.t > maxGapMs) return false;
  return Math.hypot(x - last.x, y - last.y) <= slop;
}
