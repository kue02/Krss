import { useEffect } from "react";
import { fetchEntryDecorations } from "@/plugins/api";
import { applyDecorations } from "./decorations";

/**
 * 正文装饰的取数 + 绘制（56-23）。
 *
 * 一个 effect 管一次「条目 → 装饰」的生命周期：
 *   - 条目（或正文内容）变了 → 重新拉 `GET /api/entries/:id/decorations`；
 *   - 卸掉 / 换条目 / 重渲染前 → 调还原函数，把 `<mark>` 拆回文本。
 *
 * 还原必须做在「下一次绘制」之前：正文内容没变时 React 不会重写 innerHTML，
 * 上一次画的 mark 会原地留着，新装饰再往上叠就成了两层标记（还原函数还会重复拆）。
 *
 * 拉不到就当没装饰（插件是锦上添花，不该让正文挂掉），失败不弹错。
 */
export function useEntryDecorations(
  entryId: string | null | undefined,
  root: HTMLElement | null,
  contentKey?: string | null,
): void {
  useEffect(() => {
    if (!entryId || !root) return undefined;
    let cancelled = false;
    let restore: (() => void) | null = null;

    fetchEntryDecorations(entryId)
      .then((decorations) => {
        if (cancelled || !root.isConnected) return;
        restore = applyDecorations(root, decorations);
      })
      .catch(() => {
        /* 装饰是附加信息：接口不可用就不画，正文照常读 */
      });

    return () => {
      cancelled = true;
      restore?.();
    };
  }, [entryId, root, contentKey]);
}
