/**
 * 过滤规则（自动化）—— 后端 /api/filters 的契约。
 *
 * 规则 = 作用域（全部/分类/订阅）+ 条件链 + 动作；
 * 执行点在抓取入库之后，只改自己库里的标记（muted / read / starred）。
 * 语义：按 position 自上而下，**首个命中即停**，一条规则内可带正反成对的动作。
 * 字段与操作符的取值必须与后端白名单一致（internal/model/filter.go）。
 */

import type { ContentType } from "@/types/api";

export type FilterScopeType = "all" | "folder" | "feed";

/**
 * 规则种类：
 * - rule：命中后执行动作（默认）
 * - view：只筛条目、不写数据的「保存筛选视图」（侧栏快捷入口）
 */
export type FilterKind = "rule" | "view";

export const FILTER_CONDITION_FIELDS = [
  "title",
  "content",
  "author",
  "url",
  "published_at",
  "feed_title",
  "feed_url",
  "feed_type",
  "folder",
  "has_thumbnail",
  "is_read",
  "is_starred",
  "ai_relevance",
] as const;

export type FilterConditionField = (typeof FILTER_CONDITION_FIELDS)[number];

export const FILTER_CONDITION_OPERATORS = [
  "contains",
  "exact",
  "regex",
  "before",
  "after",
  "older_than",
  "is_future",
  "is_empty",
  "is_not_empty",
  "is_relevant",
] as const;

export type FilterConditionOperator =
  (typeof FILTER_CONDITION_OPERATORS)[number];

/** 不需要填值的操作符（表单里隐藏 value 输入框） */
export const FILTER_OPERATORS_WITHOUT_VALUE: FilterConditionOperator[] = [
  "is_empty",
  "is_not_empty",
  "is_future",
];

/** 日期类操作符（value 是日期或时长，提示文案不同） */
export const FILTER_DATE_FIELDS: FilterConditionField[] = [
  "published_at",
  "is_read",
  "is_starred",
  "has_thumbnail",
];

export interface FilterCondition {
  /** 与前一条的连接词，首条忽略 */
  logic?: "and" | "or";
  negate?: boolean;
  field: FilterConditionField;
  operator: FilterConditionOperator;
  value?: string;
}

/** 正反成对的动作；同一条规则里正反互斥（后端也会拦） */
export interface FilterActions {
  mute?: boolean;
  unmute?: boolean;
  markRead?: boolean;
  markUnread?: boolean;
  star?: boolean;
  unstar?: boolean;
  /** 只保留匹配：条件没命中的条目按静音处理 */
  keepOnly?: boolean;
  /** 打开这条时自动翻译（只打标记，入库时不花 AI token） */
  translate?: boolean;
  /** 打开这条时自动摘要 */
  summarize?: boolean;
  /** 命中后把这一条 POST 给外部地址（要出网） */
  webhook?: boolean;
  webhookUrl?: string;
  /** 命中后推一条到手机（Bark 兼容；要出网） */
  notify?: boolean;
  /** 推送地址；留空 = 跟随「设置 → 通用」里的全局推送地址 */
  notifyUrl?: string;
}

export interface FilterRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  /** rule = 会执行动作的规则（默认）；view = 只筛条目的「保存筛选视图」 */
  kind?: FilterKind;
  scopeType: FilterScopeType;
  scopeId?: string;
  /** 多选订阅（范围 = 订阅时可多选，用户 11-16）；空/缺省 = 用 scopeId 的单个 */
  scopeIds?: string[];
  /** 视图只在哪些内容类型下显示（空 = 都显示，用户 11-5） */
  contentTypes?: ContentType[];
  /** 视图自定义图标：builtin:<key> / emoji:<字符> / data:image/...（用户 11-5） */
  icon?: string;
  conditions: FilterCondition[];
  actions: FilterActions;
  matchCount: number;
  lastMatchedAt?: string;
  /** 最近一次执行失败的原因（webhook 投递失败 / AI 判定失败），成功一次就清掉 */
  lastError?: string;
  lastErrorAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FilterWritePayload {
  name: string;
  enabled?: boolean;
  position?: number;
  kind?: FilterKind;
  scopeType: FilterScopeType;
  scopeId?: string;
  /** 多选订阅（范围 = 订阅时可多选，用户 11-16）；空/缺省 = 用 scopeId 的单个 */
  scopeIds?: string[];
  /** 视图只在哪些内容类型下显示（空 = 都显示，用户 11-5） */
  contentTypes?: ContentType[];
  /** 视图自定义图标：builtin:<key> / emoji:<字符> / data:image/...（用户 11-5） */
  icon?: string;
  conditions: FilterCondition[];
  actions: FilterActions;
}

/** 自然语言建规则的结果：一份可直接填进编辑器的草稿（尚未落库） */
export interface FilterDraft {
  name: string;
  scopeType: FilterScopeType;
  scopeId?: string;
  /** 多选订阅（范围 = 订阅时可多选，用户 11-16） */
  scopeIds?: string[];
  /** 视图只在哪些内容类型下显示（用户 11-5） */
  contentTypes?: ContentType[];
  /** 视图自定义图标（用户 11-5） */
  icon?: string;
  conditions: FilterCondition[];
  actions: FilterActions;
  /** 模型的一句话解释 */
  notes?: string;
  /** 被修正/丢弃的东西（必须显示，别悄悄改语义） */
  warnings?: string[];
}

export interface FilterPreviewItem {
  id: string;
  title: string;
  feedTitle: string;
  publishedAt?: string;
  actions: FilterActions;
}

export interface FilterPreviewResult {
  scanned: number;
  matchedCount: number;
  muteCount: number;
  markReadCount: number;
  starCount: number;
  /** AI 条件：吃了几条已有判定缓存 / 多少条没判成（预览绝不新发起模型调用） */
  aiChecked?: number;
  aiSkipped?: number;
  aiSkipReasons?: string[];
  matched: FilterPreviewItem[];
}

export interface FilterMatch {
  id: string;
  filterId: string;
  entryId: string;
  /** 命中时的条目标题与来源名（条目被删后为空串，日志仍在） */
  entryTitle: string;
  feedTitle: string;
  actions: FilterActions;
  createdAt: string;
}

export interface FilterRevertResult {
  reverted: number;
}

/** 手动回溯的结果：扫了多少条历史条目、实际应用了多少条 */
export interface FilterApplyHistoryResult {
  scanned: number;
  applied: number;
}

/** 规则是否没有任何动作（后端视为无效规则） */
export function hasAnyAction(actions: FilterActions): boolean {
  return Boolean(
    actions.mute ||
      actions.unmute ||
      actions.markRead ||
      actions.markUnread ||
      actions.star ||
      actions.unstar ||
      actions.keepOnly ||
      actions.translate ||
      actions.summarize ||
      actions.webhook,
  );
}

/** 把动作翻成一行摘要（规则表里用） */
export function describeActions(
  actions: FilterActions,
  t: (key: string) => string,
): string {
  const parts: string[] = [];
  if (actions.mute) parts.push(t("automation.action_mute"));
  if (actions.unmute) parts.push(t("automation.action_unmute"));
  if (actions.markRead) parts.push(t("automation.action_mark_read"));
  if (actions.markUnread) parts.push(t("automation.action_mark_unread"));
  if (actions.star) parts.push(t("automation.action_star"));
  if (actions.unstar) parts.push(t("automation.action_unstar"));
  if (actions.keepOnly) parts.push(t("automation.action_keep_only"));
  if (actions.translate) parts.push(t("automation.action_translate"));
  if (actions.summarize) parts.push(t("automation.action_summarize"));
  if (actions.webhook) parts.push(t("automation.action_webhook"));
  return parts.join(" · ");
}

/** 把条件链翻成一行摘要 */
export function describeConditions(
  conditions: FilterCondition[],
  t: (key: string) => string,
): string {
  if (conditions.length === 0) return t("automation.conditions_any");
  return conditions
    .map((condition, index) => {
      const field = t(`automation.field_${condition.field}`);
      const operator = t(`automation.op_${condition.operator}`);
      const negate = condition.negate ? "!" : "";
      const value = condition.value ? ` ${condition.value}` : "";
      const logic =
        index === 0 ? "" : ` ${t(`automation.logic_${condition.logic ?? "and"}`)} `;
      return `${logic}${negate}${field} ${operator}${value}`;
    })
    .join("");
}

/** 撤销影响清单里的一行（用户 11-23：撤销前先看清会动哪些条目） */
export interface FilterImpactItem {
  entryId: string;
  title: string;
  feedTitle: string;
  publishedAt: string;
  read: boolean;
  starred: boolean;
  muted: boolean;
  /** 当初这条规则对它做过什么（撤销会影响到的就是这些） */
  actions: FilterActions;
}

export interface FilterImpactResult {
  items: FilterImpactItem[];
  total: number;
}
