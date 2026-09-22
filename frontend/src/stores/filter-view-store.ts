import { create } from "zustand";

/**
 * 当前正在看的「保存筛选视图」（filters.kind = "view"）。
 *
 * 为什么用本地 store 而不是往路由里加一个维度：和「已静音」胶囊同一套理由 ——
 * 路由的订阅/分类/已读态是导航维度，而视图只是「同一批条目换一种筛法」的回看入口，
 * 为一个快捷入口扩容路由会让 buildPath / parseRoute / 侧栏高亮全部跟着改。
 *
 * 语义：选中后 EntryList 把它翻成 listEntries 的 viewId 参数；
 * 一旦用户点了别的订阅 / 分类 / 内容类型，就自动清掉（避免带着别人的筛选条件看新列表）。
 * 视图不是「作用域」的替代品：范围（全部/分类/订阅）由视图自己携带，后端按视图的作用域取数。
 */
interface FilterViewStore {
  viewId: string | null;
  viewName: string | null;
  /** 选中视图那一刻的列表作用域（selection + contentType）；一变就自动退出，免得带着别人的筛法看新列表 */
  scopeKey: string | null;
  /**
   * 「已静音」回看态：被规则静音的条目默认不出现在任何列表里，
   * 入口从「中栏筛选胶囊」挪到了 设置 → 自动化（2026-09-17 用户要求：
   * 既然静音了就是不想看，不该占中栏那么高的入口）。
   * 放 store 里是为了让设置页能直接切过来 —— 它是跨面板的状态，不是 EntryList 的私事。
   */
  mutedOnly: boolean;
  selectView: (view: { id: string; name: string }, scopeKey: string) => void;
  clearView: () => void;
  setMutedOnly: (value: boolean) => void;
}

export const useFilterViewStore = create<FilterViewStore>((set) => ({
  viewId: null,
  viewName: null,
  scopeKey: null,
  mutedOnly: false,
  selectView: (view, scopeKey) =>
    set({ viewId: view.id, viewName: view.name, scopeKey }),
  clearView: () => set({ viewId: null, viewName: null, scopeKey: null }),
  setMutedOnly: (value) => set({ mutedOnly: value }),
}));
