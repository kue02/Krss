import type { ContentType, Feed, Folder } from "@/types/api";

/**
 * 给定一个文件夹 id，返回它自身 + 所有后代（子、孙…）文件夹 id 的集合。
 *
 * OPML 多层导入会产生多层文件夹，只按「直接子级」(feed.folderId === rootId)
 * 会漏掉孙级文件夹里的订阅。这里用 parentId 建子节点索引后做 DFS；用 Set 去重，
 * 即使 parentId 历史数据成环也只会访问一次、不会死循环。
 */
export function collectDescendantFolderIds(
  folders: Folder[],
  rootId: string,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const siblings = childrenByParent.get(folder.parentId);
    if (siblings) siblings.push(folder.id);
    else childrenByParent.set(folder.parentId, [folder.id]);
  }

  const ids = new Set<string>([rootId]);
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const children = childrenByParent.get(current);
    if (!children) continue;
    for (const childId of children) {
      if (ids.has(childId)) continue;
      ids.add(childId);
      stack.push(childId);
    }
  }
  return ids;
}

/**
 * 选中某文件夹时，它自身 + 所有后代文件夹里订阅的未读合计。
 * `contentType` 传入时只统计该类型的订阅（与中栏按内容类型过滤一致）。
 */
export function computeFolderSubtreeUnread(
  folders: Folder[],
  feeds: Feed[],
  unreadCounts: Record<string, number>,
  rootId: string,
  contentType?: ContentType,
): number {
  const folderIds = collectDescendantFolderIds(folders, rootId);
  let sum = 0;
  for (const feed of feeds) {
    if (!feed.folderId || !folderIds.has(feed.folderId)) continue;
    if (contentType && feed.type !== contentType) continue;
    sum += unreadCounts[feed.id] ?? 0;
  }
  return sum;
}
