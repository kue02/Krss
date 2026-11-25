import { create } from "zustand";
import {
  getDimensionsBatch,
  saveDimension as saveToDb,
  type ImageDimension,
} from "@/lib/image-dimensions-db";

interface ImageDimensionsState {
  dimensions: Record<string, ImageDimension>;
  failedImages: Set<string>;
  isLoading: boolean;
  getDimension: (src: string) => ImageDimension | undefined;
  setDimension: (src: string, width: number, height: number) => void;
  markFailed: (src: string) => void;
  isFailed: (src: string) => boolean;
  clearFailed: () => void;
  loadFromDB: (srcs: string[]) => Promise<void>;
}

export const useImageDimensionsStore = create<ImageDimensionsState>(
  (set, get) => ({
    dimensions: {},
    failedImages: new Set<string>(),
    isLoading: false,

    getDimension: (src) => get().dimensions[src],

    markFailed: (src) => {
      set((state) => {
        const newSet = new Set(state.failedImages);
        newSet.add(src);
        return { failedImages: newSet };
      });
    },

    isFailed: (src) => get().failedImages.has(src),

    clearFailed: () => {
      if (get().failedImages.size === 0) return;
      set({ failedImages: new Set<string>() });
    },

    setDimension: (src, width, height) => {
      // 判等：同一张图反复量到相同尺寸（`complete` 图每次挂载都会补记一次，
      // 回访/滚动来回时很常见）时直接 return —— 原来每次都新建整张 dimensions
      // 对象，会通知所有订阅方重渲染，社交 tab 多图时退化成 O(N²)。
      const prev = get().dimensions[src];
      if (prev && prev.width === width && prev.height === height) {
        return;
      }
      const dim: ImageDimension = {
        src,
        width,
        height,
        ratio: width / height,
      };
      set((state) => ({
        dimensions: { ...state.dimensions, [src]: dim },
      }));
      saveToDb(dim);
    },

    loadFromDB: async (srcs) => {
      if (srcs.length === 0) return;

      set({ isLoading: true });
      try {
        const cached = await getDimensionsBatch(srcs);
        if (cached.size > 0) {
          set((state) => ({
            dimensions: {
              ...state.dimensions,
              ...Object.fromEntries(cached),
            },
          }));
        }
      } finally {
        set({ isLoading: false });
      }
    },
  }),
);

export function useImageDimension(src: string | undefined) {
  return useImageDimensionsStore((state) =>
    src ? state.dimensions[src] : undefined,
  );
}

export function useImageFailed(src: string | undefined) {
  return useImageDimensionsStore((state) =>
    src ? state.failedImages.has(src) : false,
  );
}
