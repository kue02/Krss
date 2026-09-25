/**
 * 图片视图「照片墙」档（31-1）的纯计算：网格形状、图集边长、偏移夹紧。
 *
 * 单独放 `.ts` 是为了能**脱离 three.js 单测** —— 组件本体在
 * `components/block/art-gallery.tsx`（obsidianui art-gallery 原件），
 * 这里只放它的数学，jsdom 里也能跑。
 */

/**
 * 一张 canvas 图集装所有照片，图集边长 ∝ √张数（512 像素/格）：
 * 120 张 → 11×11 格 → 5632² 画布（显存约 127MB），已是笔记本能忍的上限。
 */
export const WALL_MAX_TILES = 120;

/** 图集里每格贴图的边长（像素） */
export const WALL_TILE_PX = 512;

/**
 * 一屏可见**几行**（32-2 用户要的「自适应」）：
 * 格子世界尺寸 = 视口世界高度 / 这个行数 ⇒ 屏幕上的格子恒为容器高度的 1/N，
 * 窗口变大格子跟着变大、窗口变小格子跟着变小，一屏永远是 N 行（列数由宽高比顺出来）。
 * 原来是原件写死的 `cellSize = 0.75`（≈ 一屏 2.7 行、格子很大、看着很疏）。
 */
export const WALL_VISIBLE_ROWS = 4;

/** shader 里的 cellSize：视口世界高度（2 * zoom 中的 2）÷ 可见行数 */
export const WALL_CELL_WORLD = 2 / WALL_VISIBLE_ROWS;

/**
 * 照片占格子的比例（32-2 用户原话：「图片到它格子边框之间的距离，这个边距很大，
 * 把这边距缩小一点」）—— 原件是 0.6（每边留 20%，很宽），这里收到 0.92（每边 4%）。
 * 想再窄/再宽只动这一个数。
 */
export const WALL_IMAGE_FILL = 0.92;

export interface WallGrid {
  cols: number;
  rows: number;
  cells: number;
}

export interface WallSize {
  w: number;
  h: number;
}

/** 按张数与容器宽高比挑一个接近容器的网格形状（避免又长又扁的墙） */
export function wallGridLayout(count: number, aspect = 1.6): WallGrid {
  const n = Math.max(1, Math.floor(count));
  const safeAspect = Number.isFinite(aspect) && aspect > 0.2 ? aspect : 1.6;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * safeAspect))));
  const rows = Math.ceil(n / cols);
  return { cols, rows, cells: cols * rows };
}

/** 图集的边长（多少格）—— 原件里是 `ceil(sqrt(count))` */
export function wallAtlasSide(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count))));
}

/**
 * 视口在世界坐标里的尺寸。
 *
 * 原件 shader 里 `worldCoord = distortedUV * aspectRatio * uZoom + uOffset`，
 * 其中 `distortedUV ≈ screenUV ∈ [-1,1]`、`aspectRatio = (w/h, 1)`
 * ⇒ 视口在世界坐标里横跨 `2*aspect*zoom`、纵跨 `2*zoom`。
 */
export function wallViewWorld(
  width: number,
  height: number,
  zoom: number,
): WallSize {
  const aspect = height > 0 ? width / height : 1;
  return { w: 2 * aspect * zoom, h: 2 * zoom };
}

/** 网格在世界坐标里的尺寸（网格已居中于原点，见 shader 里的 `+ gridWorld * 0.5`） */
export function wallGridWorld(grid: WallGrid, cellSize: number): WallSize {
  return { w: grid.cols * cellSize, h: grid.rows * cellSize };
}

/**
 * 偏移夹紧：拖到网格边界就停，网格比视口小就居中不动。
 *
 * 原件不夹紧（无限循环，拖多远都有内容）；本项目要「有限铺满、同一张不重复」，
 * 所以把偏移限制在 `±(网格尺寸 - 视口尺寸)/2` 内。
 */
export function clampWallOffset(
  offset: { x: number; y: number },
  grid: WallSize,
  view: WallSize,
): { x: number; y: number } {
  const maxX = Math.max(0, (grid.w - view.w) / 2);
  const maxY = Math.max(0, (grid.h - view.h) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

/**
 * 收照片：按顺序去重 + 封顶（图集张数平方增长，必须封顶）。
 * 调用方按「条目顺序」喂进来即可（当前视图已加载条目的照片）。
 *
 * 去重键取「去掉查询串」的部分：图片走本仓代理时形如
 * `/api/proxy/image/<源地址的 base64>?ref=<文章地址>` —— 同一张图从不同条目来会带不同的
 * `ref`，只比整串会漏掉重复；去掉 `?ref` 后同一张图就是同一个键。
 */
export function collectWallPhotos(
  urls: Iterable<string>,
  max: number = WALL_MAX_TILES,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    const key = url.split("?")[0] ?? url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

/** cover 裁切：把任意尺寸的图按短边铺满正方形，居中裁（原件是直接拉成正方形，会变形） */
export function wallFitRect(
  width: number,
  height: number,
  tile: number = WALL_TILE_PX,
): { dx: number; dy: number; dw: number; dh: number } {
  const empty = { dx: 0, dy: 0, dw: 0, dh: 0 };
  if (!width || !height) return empty;
  /* 32-2（用户原话）：「它那张图片有些被裁剪了，就让它自适应缩放，不被裁剪」
   * ⇒ cover（裁掉超出部分）改成 **contain**：整张图按比例缩到格子里，长边贴格、
   * 短边留黑（格子底色就是黑，看不出接缝）。 */
  const scale = Math.min(tile / width, tile / height);
  const dw = width * scale;
  const dh = height * scale;
  return { dx: (tile - dw) / 2, dy: (tile - dh) / 2, dw, dh };
}
