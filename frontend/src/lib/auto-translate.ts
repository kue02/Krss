/**
 * 「这条要不要自动翻译正文」的**唯一**判定入口。
 *
 * 口径（照搬 `EntryContent.tsx` 里 `autoSummary` 的三态：条目级 > 订阅级 > 全局）：
 *   条目级规则标记（过滤规则动作 translate 打的）最大
 *     > 订阅级 `feed.autoTranslate`（订阅菜单里那个开关，#5）
 *       > AI 全局 `aiSettings.autoTranslate`
 *
 * 为什么订阅级要算进来：用户 2026-10-10 拍板「配置了翻译的跟配置了摘要的一样」——
 * 订阅级 autoTranslate 之前只管中栏列表的标题/摘要批量翻译
 * （`EntryList.tsx` 的 `isAutoTranslateEnabled`），打开正文却不翻，属于语义缺口。
 *
 * 两处必须共用这一份（正文页 + 预载判定），否则会漂移出
 * 「预载算了要翻、打开却不翻」这类白干 —— `entry-prefetch-plan.ts` 的注释里
 * 记着上一轮踩过的同一个坑。
 */

/** 条目级标记（`Entry.autoTranslate`，规则动作打的） */
type EntryLike = { autoTranslate?: boolean | null } | null | undefined;
/** 订阅级覆盖（`Feed.autoTranslate`，订阅菜单开关；null = 没设） */
type FeedLike = { autoTranslate?: boolean | null } | null | undefined;
/** AI 全局（`aiSettings.autoTranslate`） */
type AiLike = { autoTranslate?: boolean | null } | null | undefined;

export interface ResolveEntryAutoTranslateInput {
  entry: EntryLike;
  feed: FeedLike;
  aiSettings: AiLike;
}

/**
 * 条目级 > 订阅级 > 全局。
 * 条目级只有 true 才短路（false 落回订阅级/全局，与 `autoSummary` 同一口径）。
 */
export function resolveEntryAutoTranslate({
  entry,
  feed,
  aiSettings,
}: ResolveEntryAutoTranslateInput): boolean {
  if (entry?.autoTranslate) return true;
  return feed?.autoTranslate ?? aiSettings?.autoTranslate ?? false;
}