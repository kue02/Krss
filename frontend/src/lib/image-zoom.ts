/** 图片缩放的纯计算部分（便于单测，不碰 DOM） */

export const MIN_IMAGE_SCALE = 1;
export const MAX_IMAGE_SCALE = 4;

/** 把一个缩放值夹在允许范围内 */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_IMAGE_SCALE;
  return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale));
}

/**
 * 放大后拖动时，限制平移量，保证图片不会被拖出容器
 * （容器尺寸已知时，最多可以移动「放大后多出来的那部分」的一半）
 */
export function clampOffset(
  offset: { x: number; y: number },
  scale: number,
  container: { width: number; height: number },
): { x: number; y: number } {
  const maxX = Math.max(0, (container.width * (scale - 1)) / 2);
  const maxY = Math.max(0, (container.height * (scale - 1)) / 2);
  return {
    // + 0 是为了把 -0 归一成 0，免得调用方拿到看似相同却不相等的值
    x: Math.min(maxX, Math.max(-maxX, offset.x)) + 0,
    y: Math.min(maxY, Math.max(-maxY, offset.y)) + 0,
  };
}

/**
 * 双击/双指缩放时，让点击位置保持不动所需的平移量。
 * point 为相对容器中心的坐标。
 */
export function offsetForZoomAt(
  point: { x: number; y: number },
  fromScale: number,
  toScale: number,
): { x: number; y: number } {
  if (fromScale <= 0) return { x: 0, y: 0 };
  const ratio = toScale / fromScale;
  return { x: point.x * (1 - ratio) + 0, y: point.y * (1 - ratio) + 0 };
}

/** 滚轮/捏合的下一个缩放值（指数步进，手感更均匀） */
export function nextScale(current: number, delta: number): number {
  return clampScale(current * Math.exp(-delta / 400));
}
