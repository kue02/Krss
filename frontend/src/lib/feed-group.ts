import { groupDomainFor } from "./feed-site";
import type { ContentType, Feed } from "@/types/api";

/**
 * 52-5：按网站域名自动分组（用户第 5 条）。
 *
 * 场景：RSSHub 这类集合实例，一次加完好几条源都不在任何文件夹，
 * 但它们都属于同一个真网站（都在 x.com / 都在 t.me）。这时自动建一个
 * 以域名命名的文件夹，把同域名的散订阅一起归进去。
 *
 * 口径（用户 2026-10-13 拍板）：
 * - 域名 = **反解后的主站域名**（x.com / t.me / appinn.com），不是 RSSHub 实例 host；
 * - 只在**用户没手选文件夹**时触发（手选了文件夹 = 用户已经有安排，别抢）；
 * - 把同域名的散订阅一起移入（不只搬新加这条）+ 一条 toast 说明。
 *
 * 判定放在这里（纯函数）：接口调用与写库在 `hooks/useAddFeed` 里做，便于单测覆盖边界。
 */

/** 至少几条才分：少于两条就不叫「分组」，把单条源塞进一个文件夹是噪声。 */
export const MIN_GROUP_SIZE = 2;

export interface DomainGroupPlan {
  /** 文件夹名 = 域名 */
  name: string;
  /** 参与归组的订阅（含新加这条） */
  feedIds: string[];
}

/**
 * 从「同一视图（内容类型）下的全部订阅」里算出该归组的那一批。
 *
 * @param feeds 当前视图的全部订阅
 * @param newFeedId 刚添加成功的那条
 * @param contentType 当前视图（文件夹类型必须与之一致，否则建出来的文件夹看不见这条）
 * @returns 归组方案；不该分（新加那条已进文件夹 / 同域名散订阅不足两条）时返回 null
 */
export function planDomainGroup(
  feeds: Feed[],
  newFeedId: string,
  contentType: ContentType,
): DomainGroupPlan | null {
  const target = feeds.find((feed) => feed.id === newFeedId);
  if (!target) return null;
  // 已经在某个文件夹里（用户手选了 / 建的时候指定了）→ 不动别的，也不自我归组
  if (target.folderId) return null;

  const domain = groupDomainFor({ siteUrl: target.siteUrl, url: target.url });
  if (!domain) return null;

  const siblings = feeds.filter(
    (feed) =>
      feed.type === contentType &&
      !feed.folderId &&
      groupDomainFor({ siteUrl: feed.siteUrl, url: feed.url }) === domain,
  );
  if (siblings.length < MIN_GROUP_SIZE) return null;

  return {
    name: domain,
    feedIds: siblings.map((feed) => feed.id),
  };
}
