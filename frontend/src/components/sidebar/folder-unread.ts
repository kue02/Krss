import type { Folder, Feed } from "@/types/api";

/**
 * 计算每个文件夹的未读数，含所有后代文件夹的递归聚合。
 *
 * 侧边栏按 parentId 建树（OPML 多层导入会产生多层文件夹），外层/父级文件夹自身
 * 可能没有任何直接订阅，未读数全部来自子文件夹。若只统计 `feed.folderId === folder.id`
 * 的直接子项，父级会恒为 0，徽标永远不显示。
 *
 * 算法：
 *  1. 直接汇总：把每个 direct feed 的未读加到自己所在文件夹（folderId）；
 *     `folders`/`feeds` 已是上游按 animatedContentType 过滤后的同一份数组，直接用。
 *  2. 向上累加：遍历每个文件夹，把它的「直接未读数」沿 parentId 链累加到所有祖先，
 *     从而每个祖先自然得到整棵子树的直接未读合计。任意层级都适用。
 *  3. 防环：向上遍历时用 visited 集合，遇到已访问节点即停止，杜绝 parentId 成环死循环。
 *
 * 返回 map 对传入的每个 folder 都有条目，无未读时为 0。
 */
export function computeFolderUnreadCounts(
  folders: Folder[],
  feeds: Feed[],
  unreadCounts: Map<string, number>,
): Map<string, number> {
  const byId = new Map<string, Folder>();
  const direct = new Map<string, number>();
  for (const folder of folders) {
    byId.set(folder.id, folder);
    direct.set(folder.id, 0);
  }

  // 1. 直接未读：只统计落在本次显示文件夹内的 feed
  for (const feed of feeds) {
    if (!feed.folderId) continue;
    const current = direct.get(feed.folderId);
    if (current === undefined) continue; // 该 feed 所属文件夹不在当前过滤视图内
    direct.set(feed.folderId, current + (unreadCounts.get(feed.id) || 0));
  }

  // 结果以直接未读为起点（保证每个 folder 都有数值）
  const result = new Map(direct);

  // 2. 把每个文件夹的直接未读沿 parentId 链向上累加到所有祖先
  for (const folder of folders) {
    const own = direct.get(folder.id) || 0;
    if (own === 0) continue;

    const visited = new Set<string>([folder.id]);
    let parentId = folder.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break; // 父级不在当前视图内，停止向上
      result.set(parent.id, (result.get(parent.id) || 0) + own);
      parentId = parent.parentId;
    }
  }

  return result;
}
