import { create } from "zustand";

/**
 * 设置弹窗的开关。
 *
 * 原来开关是 Sidebar 里的 useState，弹窗「内部」关不掉它 —— 而自动化页里
 * 「查看已静音条目」这类跳转需要「切视图 + 关设置」一起发生。放进 store 后两边都能改。
 */
interface SettingsModalStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  close: () => void;
}

export const useSettingsModalStore = create<SettingsModalStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  close: () => set({ open: false }),
}));
