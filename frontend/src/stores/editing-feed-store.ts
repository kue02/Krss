import { create } from "zustand";
import type { Feed } from "@/types/api";

/**
 * 订阅「编辑」弹窗的打开目标。
 *
 * 原来这份 state 只活在 Sidebar 内部（useState），第二栏条目菜单想复用
 * 「编辑」就够不着。抽成 store 后 Sidebar 与条目菜单都能唤起，弹窗组件
 * 本体仍挂在 Sidebar 树下（行为不变）。
 */
interface EditingFeedStore {
  feed: Feed | null;
  openForFeed: (feed: Feed) => void;
  close: () => void;
}

export const useEditingFeedStore = create<EditingFeedStore>((set) => ({
  feed: null,
  openForFeed: (feed) => set({ feed }),
  close: () => set({ feed: null }),
}));
