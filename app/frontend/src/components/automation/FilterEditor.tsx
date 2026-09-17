import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { useFeeds } from "@/hooks/useFeeds";
import { useFolders } from "@/hooks/useFolders";
import { useFilterPreview } from "@/hooks/useFilters";
import {
  FILTER_CONDITION_FIELDS,
  FILTER_CONDITION_OPERATORS,
  FILTER_OPERATORS_WITHOUT_VALUE,
  hasAnyAction,
  type FilterActions,
  type FilterCondition,
  type FilterConditionField,
  type FilterConditionOperator,
  type FilterKind,
  type FilterPreviewResult,
  type FilterScopeType,
  type FilterWritePayload,
} from "@/types/filters";

interface FilterEditorProps {
  initial: FilterWritePayload;
  /** view = 「保存筛选视图」：同一套范围 + 条件，但没有动作区 */
  kind?: FilterKind;
  /** 自然语言建规则给出的解释（刚生成时显示一次） */
  notes?: string | null;
  /** 自然语言建规则被修正/丢弃的东西（必须显示出来） */
  warnings?: string[];
  saving?: boolean;
  saveError?: string | null;
  onSubmit: (payload: FilterWritePayload) => void;
  onCancel: () => void;
}

/** 正反成对的动作（勾了正就禁用反，同一条规则里互斥）；webhookUrl 不是开关，排除在外 */
type ActionKey = Exclude<keyof FilterActions, "webhookUrl">;

const ACTION_PAIRS: { positive: ActionKey; negative: ActionKey }[] = [
  { positive: "mute", negative: "unmute" },
  { positive: "markRead", negative: "markUnread" },
  { positive: "star", negative: "unstar" },
];

/** 动作 → i18n 键（新增动作只改这里 + 语言文件） */
const ACTION_LABEL_KEYS: Record<string, string> = {
  mute: "action_mute",
  unmute: "action_unmute",
  markRead: "action_mark_read",
  markUnread: "action_mark_unread",
  star: "action_star",
  unstar: "action_unstar",
  keepOnly: "action_keep_only",
  translate: "action_translate",
  summarize: "action_summarize",
  webhook: "action_webhook",
};

/** 动作区的按钮顺序：本地标记 → 要在打开时花 AI 的 → 出网的 → keepOnly 收尾 */
const ACTION_ORDER: ActionKey[] = [
  "mute",
  "unmute",
  "markRead",
  "markUnread",
  "star",
  "unstar",
  "translate",
  "summarize",
  "webhook",
  "keepOnly",
];

const inputClass = cn(
  // text-foreground：HeroUI 抽屉的 .drawer__body 默认是 muted 文字色，输入值要多一层才够黑
  "h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground",
  "placeholder:text-muted-foreground/50",
  "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
);

function emptyCondition(): FilterCondition {
  return { field: "title", operator: "contains", value: "" };
}

/**
 * 规则编辑器（范围 → 条件 → 动作 → 预览）。
 *
 * 紧凑高密度：条件是一行行 field×operator×value，行间是可点击切换的 and/or 胶囊，
 * 每行带「取反」；动作正反成对；底部常驻「预览影响」（干跑，不写库）。
 */
export function FilterEditor({
  initial,
  kind = "rule",
  notes = null,
  warnings = [],
  saving = false,
  saveError = null,
  onSubmit,
  onCancel,
}: FilterEditorProps) {
  const { t } = useTranslation();
  const { data: feeds } = useFeeds();
  const { data: folders } = useFolders();
  const preview = useFilterPreview();

  const isView = kind === "view";

  const [draft, setDraft] = useState<FilterWritePayload>(initial);
  const [previewResult, setPreviewResult] =
    useState<FilterPreviewResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const update = (patch: Partial<FilterWritePayload>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setPreviewResult(null);
  };

  const updateCondition = (index: number, patch: Partial<FilterCondition>) => {
    setDraft((current) => {
      const conditions = current.conditions.map((condition, i) =>
        i === index ? { ...condition, ...patch } : condition,
      );
      return { ...current, conditions };
    });
    setPreviewResult(null);
  };

  const addCondition = () => {
    setDraft((current) => ({
      ...current,
      conditions: [...current.conditions, emptyCondition()],
    }));
    setPreviewResult(null);
  };

  const removeCondition = (index: number) => {
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.filter((_, i) => i !== index),
    }));
    setPreviewResult(null);
  };

  const toggleAction = (key: ActionKey) => {
    setDraft((current) => {
      const actions: FilterActions = { ...current.actions };
      const next = !actions[key];
      actions[key] = next;
      if (next) {
        // 正反互斥：勾了「静音」就取消「取消静音」
        for (const pair of ACTION_PAIRS) {
          if (pair.positive === key) actions[pair.negative] = false;
          if (pair.negative === key) actions[pair.positive] = false;
        }
      }
      return { ...current, actions };
    });
    setPreviewResult(null);
  };

  const scopeOptions = useMemo(
    () => [
      { value: "all" as FilterScopeType, label: t("automation.scope_all") },
      { value: "folder" as FilterScopeType, label: t("automation.scope_folder") },
      { value: "feed" as FilterScopeType, label: t("automation.scope_feed") },
    ],
    [t],
  );

  const fieldOptions = useMemo(
    () =>
      FILTER_CONDITION_FIELDS.map((field) => ({
        value: field,
        label: t(`automation.field_${field}`),
      })),
    [t],
  );

  const operatorOptions = useMemo(
    () =>
      FILTER_CONDITION_OPERATORS.map((operator) => ({
        value: operator,
        label: t(`automation.op_${operator}`),
      })),
    [t],
  );

  const validate = (payload: FilterWritePayload): string | null => {
    if (!payload.name.trim()) return t("automation.invalid");
    if (isView) {
      // 视图只筛条目：必须有条件，且不带任何动作
      if (payload.conditions.length === 0) return t("automation.view_needs_condition");
    } else {
      if (!hasAnyAction(payload.actions)) return t("automation.invalid");
      if (payload.actions.webhook && !(payload.actions.webhookUrl ?? "").trim()) {
        return t("automation.webhook_needs_url");
      }
    }
    if (
      (payload.scopeType === "feed" || payload.scopeType === "folder") &&
      !payload.scopeId
    ) {
      return t("automation.invalid");
    }
    for (const condition of payload.conditions) {
      const needsValue = !FILTER_OPERATORS_WITHOUT_VALUE.includes(
        condition.operator,
      );
      if (needsValue && !(condition.value ?? "").trim()) {
        return t("automation.invalid");
      }
    }
    return null;
  };

  const handlePreview = () => {
    const error = validate(draft);
    setValidationError(error);
    if (error) return;
    preview.mutate(
      { payload: draft },
      { onSuccess: (result) => setPreviewResult(result) },
    );
  };

  const handleSubmit = () => {
    const error = validate(draft);
    setValidationError(error);
    if (error) return;
    onSubmit({
      ...draft,
      name: draft.name.trim(),
      kind: isView ? "view" : "rule",
      actions: isView ? {} : draft.actions,
    });
  };

  const valuePlaceholder = (condition: FilterCondition): string => {
    if (condition.field === "ai_relevance") {
      return t("automation.value_hint_ai");
    }
    if (condition.field === "published_at") {
      return condition.operator === "older_than"
        ? t("automation.value_hint_duration")
        : t("automation.value_hint_date");
    }
    if (
      condition.field === "is_read" ||
      condition.field === "is_starred" ||
      condition.field === "has_thumbnail"
    ) {
      return t("automation.value_hint_bool");
    }
    return t("automation.condition_value_placeholder");
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-foreground">
      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 py-4">
        {/* 名称 + 启用 */}
        <section className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {t("automation.name")}
            </label>
            <input
              type="text"
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder={t("automation.name_placeholder")}
              className={cn(inputClass, "mt-1 h-9")}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("automation.enabled")}</div>
              <div className="text-xs text-muted-foreground">
                {t("automation.enabled_hint")}
              </div>
            </div>
            <Switch
              checked={draft.enabled ?? true}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
          </div>
        </section>

        {/* 自然语言建规则：模型的一句话解释 + 被修正/丢弃的东西（绝不悄悄改） */}
        {(notes || warnings.length > 0) && (
          <section className="space-y-1 rounded-md border border-border bg-secondary/20 px-3 py-2">
            <div className="text-xs font-medium">
              {t("automation.nl_draft_title")}
            </div>
            {notes && (
              <div className="text-xs text-muted-foreground">{notes}</div>
            )}
            {warnings.map((warning, index) => (
              <div key={index} className="text-xs text-destructive">
                {warning}
              </div>
            ))}
          </section>
        )}

        {/* 范围 */}
        <section className="space-y-2 border-t border-border pt-4">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("automation.scope")}
          </div>
          <SegmentedControl
            value={draft.scopeType}
            onValueChange={(value) =>
              update({
                scopeType: value,
                scopeId: value === "all" ? undefined : draft.scopeId,
              })
            }
            options={scopeOptions}
          />
          {draft.scopeType === "folder" && (
            <Select
              ariaLabel={t("automation.scope")}
              value={draft.scopeId ?? ""}
              onChange={(value) => update({ scopeId: value })}
              options={[
                {
                  value: "",
                  label: t("automation.scope_folder_placeholder"),
                },
                ...(folders ?? []).map((folder) => ({
                  value: folder.id,
                  label: folder.name,
                })),
              ]}
              className="w-full"
            />
          )}
          {draft.scopeType === "feed" && (
            <Select
              ariaLabel={t("automation.scope")}
              value={draft.scopeId ?? ""}
              onChange={(value) => update({ scopeId: value })}
              options={[
                { value: "", label: t("automation.scope_feed_placeholder") },
                ...(feeds ?? []).map((feed) => ({
                  value: feed.id,
                  label: feed.title,
                })),
              ]}
              className="w-full"
            />
          )}
        </section>

        {/* 条件 */}
        <section className="space-y-2 border-t border-border pt-4">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t("automation.conditions")}
            </div>
            <button
              type="button"
              onClick={addCondition}
              className="text-xs text-primary hover:underline"
            >
              + {t("automation.add_condition")}
            </button>
          </div>

          {draft.conditions.length === 0 && (
            <div className="text-xs text-muted-foreground">
              {t("automation.conditions_any")}
            </div>
          )}

          <div className="space-y-1.5">
            {draft.conditions.map((condition, index) => {
              const needsValue = !FILTER_OPERATORS_WITHOUT_VALUE.includes(
                condition.operator,
              );
              return (
                <div key={index} className="space-y-1">
                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        updateCondition(index, {
                          logic: condition.logic === "or" ? "and" : "or",
                        })
                      }
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                        condition.logic === "or"
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(`automation.logic_${condition.logic ?? "and"}`)}
                    </button>
                  )}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      title={t("automation.negate")}
                      aria-pressed={Boolean(condition.negate)}
                      onClick={() =>
                        updateCondition(index, { negate: !condition.negate })
                      }
                      className={cn(
                        "h-8 w-8 shrink-0 rounded-md border text-sm font-medium transition-colors",
                        condition.negate
                          ? "border-destructive/40 bg-destructive/10 text-destructive"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      !
                    </button>
                    <Select
                      ariaLabel={t("automation.conditions")}
                      value={condition.field}
                      onChange={(value) => {
                        const nextField = value as FilterConditionField;
                        // AI 相关性只配 is_relevant（后端也拦）；换回普通字段时把操作符复位
                        if (nextField === "ai_relevance") {
                          updateCondition(index, {
                            field: nextField,
                            operator: "is_relevant",
                          });
                          return;
                        }
                        updateCondition(index, {
                          field: nextField,
                          operator:
                            condition.operator === "is_relevant"
                              ? "contains"
                              : condition.operator,
                        });
                      }}
                      options={fieldOptions}
                      className="w-28 shrink-0"
                    />
                    <Select
                      ariaLabel={t("automation.conditions")}
                      value={condition.operator}
                      onChange={(value) =>
                        updateCondition(index, {
                          operator: value as FilterConditionOperator,
                        })
                      }
                      options={operatorOptions}
                      className="w-24 shrink-0"
                    />
                    {needsValue ? (
                      <input
                        type="text"
                        value={condition.value ?? ""}
                        onChange={(event) =>
                          updateCondition(index, { value: event.target.value })
                        }
                        placeholder={valuePlaceholder(condition)}
                        className={inputClass}
                      />
                    ) : (
                      <div className="flex h-8 flex-1 items-center px-2 text-xs text-muted-foreground">
                        {t("automation.condition_value_empty")}
                      </div>
                    )}
                    <button
                      type="button"
                      title={t("automation.remove_condition")}
                      onClick={() => removeCondition(index)}
                      className="h-8 w-8 shrink-0 rounded-md border border-border text-muted-foreground transition-colors hover:text-destructive"
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 动作（视图没有动作区：它只筛条目、不写数据） */}
        {isView ? (
          <section className="space-y-2 border-t border-border pt-4">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t("automation.view_kind")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("automation.view_actions_hint")}
            </div>
          </section>
        ) : (
          <section className="space-y-2 border-t border-border pt-4">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t("automation.actions")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ACTION_ORDER.map((key) => {
                const active = Boolean(draft.actions[key]);
                const disabled = ACTION_PAIRS.some(
                  (pair) =>
                    (pair.positive === key &&
                      Boolean(draft.actions[pair.negative])) ||
                    (pair.negative === key &&
                      Boolean(draft.actions[pair.positive])),
                );
                // 「只保留匹配」本身就会把不匹配的静音，再叠一个「静音」等于全静音 —— 挡掉这个误操作
                const conflictsKeepOnly =
                  key === "mute" && Boolean(draft.actions.keepOnly);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    disabled={disabled || conflictsKeepOnly}
                    onClick={() => toggleAction(key)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                      active
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                      (disabled || conflictsKeepOnly) &&
                        "cursor-not-allowed opacity-40",
                      key === "keepOnly" && "ml-auto",
                    )}
                  >
                    {t(`automation.${ACTION_LABEL_KEYS[key] ?? "actions"}`)}
                  </button>
                );
              })}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("automation.actions_hint")}
            </div>
            {draft.actions.translate && (
              <div className="text-xs text-muted-foreground">
                {t("automation.translate_hint")}
              </div>
            )}
            {draft.actions.summarize && (
              <div className="text-xs text-muted-foreground">
                {t("automation.summarize_hint")}
              </div>
            )}
            {draft.actions.webhook && (
              <div className="space-y-1">
                <input
                  type="text"
                  value={draft.actions.webhookUrl ?? ""}
                  onChange={(event) =>
                    update({
                      actions: {
                        ...draft.actions,
                        webhookUrl: event.target.value,
                      },
                    })
                  }
                  placeholder={t("automation.webhook_url_placeholder")}
                  className={inputClass}
                />
                <div className="text-xs text-muted-foreground">
                  {t("automation.webhook_hint")}
                </div>
              </div>
            )}
            {draft.actions.keepOnly && (
              <div className="text-xs text-muted-foreground">
                {t("automation.keep_only_hint")}
              </div>
            )}
          </section>
        )}

        {/* 预览结果 */}
        {previewResult && (
          <section className="space-y-1 rounded-md border border-border bg-secondary/20 px-3 py-2">
            <div className="text-xs font-medium">
              {t("automation.preview_summary", {
                scanned: previewResult.scanned,
                matched: previewResult.matchedCount,
              })}
            </div>
            {previewResult.matchedCount === 0 ? (
              <div className="text-xs text-muted-foreground">
                {t("automation.preview_empty", {
                  scanned: previewResult.scanned,
                })}
              </div>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                {previewResult.muteCount > 0 && (
                  <span>
                    {t("automation.preview_mute", {
                      count: previewResult.muteCount,
                    })}
                  </span>
                )}
                {previewResult.markReadCount > 0 && (
                  <span>
                    {t("automation.preview_mark_read", {
                      count: previewResult.markReadCount,
                    })}
                  </span>
                )}
                {previewResult.starCount > 0 && (
                  <span>
                    {t("automation.preview_star", {
                      count: previewResult.starCount,
                    })}
                  </span>
                )}
              </div>
            )}
            {/* AI 条件在预览里只吃已有判定缓存：这里把「没判成多少条」说清楚 */}
            {(previewResult.aiSkipped ?? 0) > 0 && (
              <div className="text-xs text-muted-foreground">
                {t("automation.preview_ai_skipped", {
                  count: previewResult.aiSkipped ?? 0,
                })}
                {(previewResult.aiSkipReasons ?? []).length > 0
                  ? ` — ${(previewResult.aiSkipReasons ?? []).join("；")}`
                  : ""}
              </div>
            )}
            {previewResult.matched.length > 0 && (
              <ul className="max-h-40 space-y-0.5 overflow-auto pt-1">
                {previewResult.matched.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-baseline gap-2 text-xs text-muted-foreground"
                  >
                    <span className="shrink-0 text-[11px] opacity-70">
                      {item.feedTitle}
                    </span>
                    <span className="truncate text-foreground">
                      {item.title}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {(validationError || saveError || preview.isError) && (
          <div className="text-xs text-destructive">
            {validationError ??
              saveError ??
              (preview.isError ? t("automation.preview_failed") : null)}
          </div>
        )}
      </div>

      {/* 底部常驻操作区 */}
      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <button
          type="button"
          onClick={handlePreview}
          disabled={preview.isPending}
          className={cn(
            "h-8 rounded-md border border-border px-3 text-sm font-medium transition-colors",
            "hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {preview.isPending
            ? t("automation.preview_running")
            : t("automation.preview")}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("automation.cancel")}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving}
          className={cn(
            "h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors",
            "hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {saving ? t("automation.saving") : t("automation.save")}
        </button>
      </div>
    </div>
  );
}
