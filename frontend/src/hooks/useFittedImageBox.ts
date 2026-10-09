import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useImageDimensionsStore } from "@/stores/image-dimensions-store";
import { computeSingleBox, rowItemWidth } from "@/lib/extract-content-media";

/** Folo 单图上限：`window.innerHeight * 2/3`（`media-gallery.tsx:59`） */
const SINGLE_MAX_HEIGHT_RATIO = 2 / 3;
/** 视口高度还没量到时的兜底（ SocialMediaGallery 同值 ） */
const FALLBACK_VIEWPORT_HEIGHT = 900;

export interface FittedImageBox {
  width: number;
  height: number;
}

export interface UseFittedImageBoxOptions {
  /** 原始 URL（store key）。代理 URL 不做 key —— 见 extract-content-media.ts 顶部注释。 */
  src: string | undefined;
  /** `<img>` 上的 width 属性（第一级兜底） */
  declaredWidth?: number;
  /** `<img>` 上的 height 属性（第一级兜底） */
  declaredHeight?: number;
  /** 是否按容器宽自适应。false 时一律不介入（文章视图维持现状） */
  enabled: boolean;
}

/**
 * 「选尺寸 + 算盒子」的纯函数部分（抽出来是为了能脱离 DOM 单测）。
 *
 * 尺寸优先级：`<img>` 的 width/height 属性 → store 里量到的（onLoad/IndexedDB）。
 * 容器宽或尺寸未知 → 返回 undefined（此时不设 inline 尺寸，交给 prose 原样渲染）。
 *
 * `imageCount` = 同一容器（引文框 / 段落）里的图片张数，按张数分行 ——
 * 1 张铺满，2 张各半，3 张以上各三分之一。这条口径直接复用正文画廊的
 * `rowItemWidth`（Folo `media-gallery.tsx:53-74`），保证「引文内 = 普通条目」。
 * 12-11 用户明确要过「并排、等比缩小」，所以多图不能各占一行。
 */
export function resolveFittedBox({
  enabled,
  declaredWidth,
  declaredHeight,
  measured,
  containerWidth,
  viewportHeight,
  imageCount = 1,
}: {
  enabled: boolean;
  declaredWidth?: number;
  declaredHeight?: number;
  measured?: { width: number; height: number };
  containerWidth: number;
  viewportHeight: number;
  imageCount?: number;
}): FittedImageBox | undefined {
  if (!enabled) return undefined;

  const dims =
    declaredWidth && declaredHeight
      ? { width: declaredWidth, height: declaredHeight }
      : measured;
  if (!dims || !dims.width || !dims.height || containerWidth <= 0)
    return undefined;

  const count = Math.max(1, Math.floor(imageCount));
  const itemWidth = rowItemWidth(count, containerWidth);

  // 单图才封顶高度（Folo 只对单图封顶，多图不封 —— 那是它的逻辑现状，照此执行）：
  // 超高就按高度反算宽度、两侧留边、零裁切。与正文画廊共用同一份算法，不另抄一遍。
  if (count === 1) {
    const maxHeight = viewportHeight * SINGLE_MAX_HEIGHT_RATIO;
    const raw = computeSingleBox(
      itemWidth,
      dims.width,
      dims.height,
      maxHeight,
    );
    return { width: Math.round(raw.width), height: Math.round(raw.height) };
  }

  const ratio = dims.height / dims.width;
  return {
    width: Math.round(itemWidth),
    height: Math.round(itemWidth * ratio),
  };
}

/**
 * 正文图片的自适应盒子（42-9）。
 *
 * 让 `ArticleImage` 具备「量容器宽 + 按真实比例算盒子」的能力，引文内外的 `<img>`
 * 走同一个组件 ⇒ **逻辑从此只有一套**，区别只剩外层那个引文框。
 *
 * 尺寸三级兜底（与 `SocialMediaGallery` / Folo 同构）：
 *  1. `<img>` 的 width/height 属性（Twitter 系 RSSHub 会带；Telegram 系不带）
 *  2. `image-dimensions-store` 里上次量到的缓存（含 IndexedDB）
 *  3. `onLoad` 实测 → 写回 store，第二次出现即同步命中
 *
 * **为什么要实测**：库里 72 张引文图有 48 张（2/3）没有 width/height 属性，
 * 纯 CSS 的 `width:auto + max-height` 对它们只能按 intrinsic size 碰运气 ——
 * 实测那张 800×1200 只显示成 320×480（占容器一半宽，两侧留白）。
 */
export function useFittedImageBox({
  src,
  declaredWidth,
  declaredHeight,
  enabled,
}: UseFittedImageBoxOptions) {
  const containerRef = useRef<HTMLImageElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [imageCount, setImageCount] = useState(1);
  const [viewportHeight, setViewportHeight] = useState(
    typeof window === "undefined" ? FALLBACK_VIEWPORT_HEIGHT : window.innerHeight,
  );

  // 尺寸表整体进依赖：任何一张量到新尺寸都会重算（无属性那批靠这条生效）
  const dimensions = useImageDimensionsStore(
    useShallow((state) => state.dimensions),
  );
  const setDimension = useImageDimensionsStore((state) => state.setDimension);

  // 量容器：内容宽 + 同容器里的图片张数（张数决定分行，见 resolveFittedBox）
  useEffect(() => {
    if (!enabled) return;
    const node = containerRef.current;
    if (!node?.parentElement) return;
    const parent = node.parentElement;

    const measure = () => {
      // 扣掉父元素左右 padding 才是**内容宽**：引文框自带 padding，
      // 直接用 clientWidth 会算超（靠 `max-width:100%` 兜虽然也能看，
      // 但竖图那条会被 max-height 反算成偏高的盒子、比例走样）。
      const cs = getComputedStyle(parent);
      const pad =
        (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      setContainerWidth(Math.max(0, parent.clientWidth - pad));

      // 同容器（引文框 / 段落）里的图算作一排：2 张各半、3 张以上各三分之一
      const n = parent.querySelectorAll("img").length;
      setImageCount(Math.max(1, n));
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled]);

  // onLoad 实测：量到就写 store（key = 原始 src，画廊与引文共用一份缓存）
  const handleLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      if (!enabled || !src) return;
      const img = event.currentTarget;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w > 0 && h > 0) {
        setDimension(src, w, h);
        // 懒加载补上来的图会让「同容器张数」变化，顺手重算一次
        const parent = img.parentElement;
        if (parent) setImageCount(Math.max(1, parent.querySelectorAll("img").length));
      }
    },
    [enabled, src, setDimension],
  );

  /**
   * 浏览器缓存命中的图**不再触发 `load`**（挂载时 `complete` 已为 true），
   * 只挂 `onLoad` 的话回访用户这批图永远量不到 ⇒ 永远退回 prose 原样。
   * 与 `SocialMediaGallery` 的 `GalleryImage` 同一个坑、同一个修法。
   */
  useEffect(() => {
    if (!enabled || !src) return;
    const img = containerRef.current;
    if (img?.complete && img.naturalWidth > 0) {
      setDimension(src, img.naturalWidth, img.naturalHeight);
    }
  }, [enabled, src, setDimension]);

  const measured = src ? dimensions[src] : undefined;

  const box = resolveFittedBox({
    enabled,
    declaredWidth,
    declaredHeight,
    measured,
    containerWidth,
    viewportHeight,
    imageCount,
  });

  return { containerRef, box, handleLoad };
}
