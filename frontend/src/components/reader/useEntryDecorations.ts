import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchEntryDecorations } from "@/plugins/api";
import { applyDecorations } from "./decorations";

/**
 * 正文装饰的取数 + 绘制（56-23）。
 *
 * 取数走 react-query（key `["decorations", entryId]`）：插件执行完会回
 * `refresh:["decorations"]`，宿主按这个 key 失效，正文标记就能立刻重画，
 * 不用刷新页面。裸 useEffect 拿不到可失效的 key，那条 refresh 等于空转。
 *
 * 绘制仍是一对一的生命周期：
 *   - 条目 / 正文内容 / 数据变了 → 重新画；
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
  const { data } = useQuery({
    queryKey: ["decorations", entryId],
    queryFn: () => fetchEntryDecorations(entryId as string),
    enabled: Boolean(entryId) && root !== null,
    // 装饰只在「有人改过」时才需要重拉（那条路径会主动失效），平时别反复打接口。
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!root || !entryId || !data) return undefined;
    const restore = applyDecorations(root, data);
    return restore;
  }, [root, entryId, data, contentKey]);
}
