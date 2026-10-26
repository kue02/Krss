import { useMutation, useQueryClient } from "@tanstack/react-query";
import { showToast } from "@/stores/toast-store";
import { invokePluginAction } from "./api";
import type {
  PluginContribution,
  PluginInvokeResult,
  PluginSelection,
} from "./types";

/**
 * 插件动作的「刷新意图」→ 前端已有 query key（56-8）。
 *
 * 插件只会声明它希望刷新的**语义**名字（`refresh: ["entries"]`），拼具体 queryKey 是宿主的
 * 事：插件的 query key 一改，插件不该跟着改。这里只认这四类；插件写了别的一律忽略 ——
 * 宁可少刷一次，也不能让一条 `refresh: ["../../secret"]` 之类的手滑把整个缓存树打翻。
 */
const REFRESH_QUERY_KEYS: Record<string, readonly string[]> = {
  entries: ["entries"],
  feeds: ["feeds"],
  filters: ["filters"],
  views: ["views"],
};

export type InvokePluginActionInput = {
  selection: PluginSelection;
  config?: Record<string, string>;
};

/**
 * 执行一条界面贡献背后的插件动作（56-8）。
 *
 * 归还的是 `useMutation` 的结果，调用方按需用 `mutate` / `isPending` 挂按钮状态。
 * 三件事都收在这一处，避免每个挂点各写一遍：
 * 1. body 里的 `surface` 来自贡献项本身（插件据此知道自己在哪个挂点被点）；
 * 2. 插件回的 `message` 直接弹提示 —— 文案由插件决定（它才知道自己刚做了什么），
 *    空串/缺省不弹（插件可以不说话）；
 * 3. `refresh` 决定失效哪些缓存：优先用本次返回值（可能按实际结果收窄），没给才退回
 *    贡献项上声明的静态 `refresh`。
 *
 * 关于 level：仓库的 toast store 只有 `showToast(message)`、没有等级参数（成功/失败同一形态，
 * 见 stores/toast-store.ts），所以这里不伪造一个不存在的 error 样式，成功与失败都走同一个
 * `showToast`；错误文案本身就是「失败原因」，用户看文案即可分辨。
 */
export function useInvokePluginAction(contribution: PluginContribution) {
  const queryClient = useQueryClient();
  const { plugin, action, surface } = contribution;

  return useMutation<PluginInvokeResult, Error, InvokePluginActionInput>({
    mutationFn: ({ selection, config }) =>
      invokePluginAction(plugin, action, { surface, selection, config }),
    onSuccess: (result) => {
      const message = result.message ?? "";
      if (message) showToast(message);

      const refresh = result.refresh ?? contribution.refresh ?? [];
      for (const name of refresh) {
        const queryKey = REFRESH_QUERY_KEYS[name];
        if (!queryKey) continue;
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : String(error));
    },
  });
}
