import { create } from "zustand";
import type { Entry, Feed } from "@/types/api";

/** 画廊里的一项 = 图片视图里的一个条目（它可能自带多张图） */
export interface LightboxGalleryItem {
  entry: Entry;
  feed?: Feed;
  images: string[];
}

interface LightboxState {
  isOpen: boolean;
  entry: Entry | null;
  feed: Feed | null;
  images: string[];
  currentIndex: number;
  /**
   * 整条画廊（图片视图里已加载的条目）。有它，左右箭头才能「同条目内切图 → 切到头跳到下一条目」
   * （用户 2026-09-17 要求）。只用单条目打开时，画廊就是这一条。
   */
  gallery: LightboxGalleryItem[];
  galleryIndex: number;

  open: (
    entry: Entry,
    feed: Feed | undefined,
    images: string[],
    startIndex?: number,
    gallery?: LightboxGalleryItem[],
  ) => void;
  close: () => void;
  reset: () => void;
  setIndex: (index: number) => void;
  next: () => void;
  prev: () => void;
  updateEntryStarred: (starred: boolean) => void;
}

const initialState = {
  isOpen: false,
  entry: null,
  feed: null,
  images: [] as string[],
  currentIndex: 0,
  gallery: [] as LightboxGalleryItem[],
  galleryIndex: 0,
};

export const useLightboxStore = create<LightboxState>((set, get) => ({
  ...initialState,

  open: (entry, feed, images, startIndex = 0, gallery) => {
    const list: LightboxGalleryItem[] = gallery?.length
      ? gallery
      : [{ entry, feed, images }];
    const index = list.findIndex((item) => item.entry.id === entry.id);
    set({
      isOpen: true,
      entry,
      feed: feed ?? null,
      images,
      currentIndex: startIndex,
      gallery: list,
      galleryIndex: index >= 0 ? index : 0,
    });
  },

  close: () => {
    set({ isOpen: false });
  },

  reset: () => {
    set(initialState);
  },

  setIndex: (index) => {
    const { images } = get();
    if (index >= 0 && index < images.length) {
      set({ currentIndex: index });
    }
  },

  /**
   * 右箭头：先在同一条目内切下一张图；切到头就跳到**下一个条目**的第一张（用户 2026-09-17 要求 C）。
   * 跳到新条目时 Lightbox 会弹一条简洁提示（来源 + 标题）。
   */
  next: () => {
    const { currentIndex, images, gallery, galleryIndex } = get();
    if (currentIndex < images.length - 1) {
      set({ currentIndex: currentIndex + 1 });
      return;
    }
    const nextItem = gallery[galleryIndex + 1];
    if (!nextItem) return;
    set({
      galleryIndex: galleryIndex + 1,
      entry: nextItem.entry,
      feed: nextItem.feed ?? null,
      images: nextItem.images,
      currentIndex: 0,
    });
  },

  /** 左箭头：先在同一条目内退一张；到头退到**上一个条目**的最后一张 */
  prev: () => {
    const { currentIndex, gallery, galleryIndex } = get();
    if (currentIndex > 0) {
      set({ currentIndex: currentIndex - 1 });
      return;
    }
    const prevItem = gallery[galleryIndex - 1];
    if (!prevItem) return;
    set({
      galleryIndex: galleryIndex - 1,
      entry: prevItem.entry,
      feed: prevItem.feed ?? null,
      images: prevItem.images,
      currentIndex: Math.max(0, prevItem.images.length - 1),
    });
  },

  updateEntryStarred: (starred) => {
    const { entry } = get();
    if (entry) {
      set({ entry: { ...entry, starred } });
    }
  },
}));
