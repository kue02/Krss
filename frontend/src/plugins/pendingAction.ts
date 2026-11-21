import { create } from "zustand";
import type { PluginContribution, PluginSelection } from "./types";

/**
 * 「等用户填参数 / 点确认」的那一条插件动作（56-10）。
 *
 * 为什么放进 store 而不是插槽自己的 `useState`：插件项最常出现在**右键菜单**里，
 * 菜单一点就关、整棵子树被 Radix `Presence` 卸载（实测：点完菜单项，
 * `ContextMenuItem` 已经不在文档里）。把弹窗挂在菜单项内部，弹窗会跟着消失 ——
 * 用户点「推送到手机」什么都看不到。这与设置弹窗踩过的坑是同一个
 * （见 `stores/settings-modal-store.ts` 与 App 顶层的注释），
 * 所以开关与弹窗一起搬到 App 顶层：`PluginActionDialog` 与 `FilterEditorDialog` 同级。
 */
export type PendingPluginAction = {
  /** 点了哪条贡献（label / confirm / fields / plugin+action 都在里面） */
  contribution: PluginContribution;
  /** 点击当时宿主给的上下文（条目 / 订阅 / 视图…），提交时原样带回 */
  selection: PluginSelection;
};

interface PendingPluginActionStore {
  pending: PendingPluginAction | null;
  open: (pending: PendingPluginAction) => void;
  close: () => void;
}

export const usePendingPluginActionStore = create<PendingPluginActionStore>(
  (set) => ({
    pending: null,
    open: (pending) => set({ pending }),
    close: () => set({ pending: null }),
  }),
);

/** 给菜单项 / 按钮这类「不在 React 事件回调里也能拿 store」的地方用 */
export function openPendingPluginAction(pending: PendingPluginAction) {
  usePendingPluginActionStore.getState().open(pending);
}
