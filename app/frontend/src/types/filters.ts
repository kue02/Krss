/**
 * 过滤规则（自动化）—— 后端 /api/filters 的契约。
 *
 * 规则 = 作用域（全部/分类/订阅）+ 条件链 + 动作；
 * 执行点在抓取入库之后，只改自己库里的标记（muted / read / starred）。
 * 语义：按 position 自上而下，**首个命中即停**，一条规则内可带正反成对的动作。
 * 字段与操作符的取值必须与后端白名单一致（internal/model/filter.go）。
 */

export type FilterScopeType = "all" | "folder" | "feed";

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
}

export interface FilterRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  scopeType: FilterScopeType;
  scopeId?: string;
  conditions: FilterCondition[];
  actions: FilterActions;
  matchCount: number;
  lastMatchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FilterWritePayload {
  name: string;
  enabled?: boolean;
  position?: number;
  scopeType: FilterScopeType;
  scopeId?: string;
  conditions: FilterCondition[];
  actions: FilterActions;
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
      actions.keepOnly,
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
