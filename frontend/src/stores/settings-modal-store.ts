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

/**
 * 个人资料弹窗的开关。
 *
 * 2026-09-20（移动端设置滑不动）：资料弹窗原来是 Sidebar 里的 useState，
 * 弹窗组件也挂在 Sidebar 树下。移动端 Sidebar 装在 Sheet 里 —— Sheet 一关
 * （关侧栏、切订阅都会关），Sidebar 卸载，弹窗跟着被卸载。所以开关与组件
 * 一起搬到 App 顶层（见 `App()`），与 Sheet 平级，不随侧栏卸载。
 */
interface ProfileModalStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  close: () => void;
}

export const useProfileModalStore = create<ProfileModalStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  close: () => set({ open: false }),
}));
