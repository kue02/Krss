import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Fieldset,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { cn } from "@/lib/utils";
import { HeroSwitch } from "@/components/ui/hero-switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { ViewIconPicker } from "@/components/automation/ViewIconPicker";
import { FeedScopePicker } from "@/components/automation/FeedScopePicker";
import { CONTENT_TYPE_ORDER } from "@/lib/content-type-meta";
import type { ContentType } from "@/types/api";
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
  /**
   * 把「这份表单现在长什么样、有没有被改过」告诉外壳（用户 11-9）：
   * 保存成功只提示「已保存」；**有未保存改动时离开**才弹确认 —— 判断留在表单里，
   * 因为只有它知道 kind/trim/视图清空动作这些规范化规则（buildPayload）。
   */
  onPayloadChange?: (payload: FilterWritePayload, dirty: boolean) => void;
  onSubmit: (payload: FilterWritePayload) => void;
  onCancel: () => void;
}

/** 正反成对的动作（勾了正就禁用反，同一条规则里互斥）；xxxUrl 不是开关，排除在外 */
type ActionKey = Exclude<keyof FilterActions, "webhookUrl" | "notifyUrl">;

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
  notify: "action_notify",
};

/** 三态维度（静音 / 已读 / 星标）的行标签 */
const DIMENSION_LABEL_KEYS: Record<string, string> = {
  mute: "dim_mute",
  markRead: "dim_read",
  star: "dim_star",
};

/** 非配对动作（单独开关）：要在打开时花 AI 的 → 出网的 → keepOnly 收尾 */
/** 动作 → 一句说明（放进 tooltip，别铺成一片灰字） */
const ACTION_HINT_KEYS: Record<string, string> = {
  translate: "translate_hint",
  summarize: "summarize_hint",
  webhook: "webhook_hint",
  notify: "notify_hint",
};

const inputClass = cn(
  // text-foreground：HeroUI 抽屉的 .drawer__body 默认是 muted 文字色，输入值要多一层才够黑
  // h-9（36px）：用户 11-4 说条件那里的输入框太小；抽屉里所有输入框统一到这一档
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground",
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
  onPayloadChange,
  onSubmit,
  onCancel,
}: FilterEditorProps) {
  const { t } = useTranslation();
  const { data: feeds } = useFeeds();
  const { data: folders } = useFolders();
  const preview = useFilterPreview();

  const isView = kind === "view";

  const [draft, setDraft] = useState<FilterWritePayload>(initial);

  /** 「只保留匹配」与「静音」互斥：前者已把不匹配的静音，再叠静音等于全静音 */
  const keepOnlyBlocksMute = Boolean(draft.actions.keepOnly);
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

  /** 三维度一律三态：none=不动 / positive=正向 / negative=反向（互斥天然成立） */
  const setActionDimension = (
    positive: ActionKey,
    negative: ActionKey,
    value: "none" | "positive" | "negative",
  ) => {
    setDraft((current) => ({
      ...current,
      actions: {
        ...current.actions,
        [positive]: value === "positive",
        [negative]: value === "negative",
      },
    }));
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
    if (payload.scopeType === "folder" && !payload.scopeId) {
      return t("automation.invalid");
    }
    // 订阅范围：多选（scopeIds）或单选（scopeId）有一个就够
    if (
      payload.scopeType === "feed" &&
      !payload.scopeId &&
      (payload.scopeIds ?? []).length === 0
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

  /**
   * 交给服务端的最终 payload —— **预览与保存必须共用这一份**。
   *
   * 曾经的 bug（用户 11-1「新建视图预览还是失败」）：预览直接把 draft 发出去，而 draft 里没有 kind，
   * 后端就按「规则」校验，视图没有动作 → 400 invalid filter；同一份 body 只要带上 kind:"view" 就是 200。
   */
  const buildPayload = (): FilterWritePayload => ({
    ...draft,
    name: draft.name.trim(),
    kind: isView ? "view" : "rule",
    actions: isView ? {} : draft.actions,
  });

  /**
   * 稳定性指纹：只比「会影响保存结果」的字段，且用固定键序。
   * 直接 stringify 原始对象是不行的 —— store 给的 draft 与规范化后的 payload 键序/多寡都不同，
   * 会把「什么都没改」误判成脏（第一次实现就踩了，测试当场抓到）。
   */
  const signature = (input: FilterWritePayload) =>
    JSON.stringify({
      name: input.name.trim(),
      scopeType: input.scopeType,
      // 多选订阅：顺序不参与比较，否则「换个点选顺序」会被当成改过
      scopeId: input.scopeId ?? "",
      scopeIds: [...(input.scopeIds ?? [])].sort(),
      conditions: (input.conditions ?? []).map((condition) => ({
        logic: condition.logic ?? "and",
        negate: Boolean(condition.negate),
        field: condition.field,
        operator: condition.operator,
        value: condition.value ?? "",
      })),
      actions: Object.fromEntries(
        Object.entries(isView ? {} : (input.actions ?? {}))
          .filter(([, value]) => Boolean(value))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    });
  const initialSignature = signature(initial);
  const payload = buildPayload();
  const payloadSignature = signature(payload);
  const isDirty = payloadSignature !== initialSignature;
  useEffect(() => {
    onPayloadChange?.(payload, isDirty);
    // payload 每次都是新对象，依赖到它的签名上避免每帧上报
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadSignature, isDirty, onPayloadChange]);

  const handlePreview = () => {
    const error = validate(draft);
    setValidationError(error);
    if (error) return;
    preview.mutate(
      { payload: buildPayload() },
      { onSuccess: (result) => setPreviewResult(result) },
    );
  };

  const handleSubmit = () => {
    const error = validate(draft);
    setValidationError(error);
    if (error) return;
    onSubmit(buildPayload());
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
          <div className="contents">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("automation.enabled")}</div>
              <div className="text-xs text-muted-foreground">
                {t("automation.enabled_hint")}
              </div>
            </div>
            <HeroSwitch
              aria-label={t("automation.enabled")}
              isSelected={draft.enabled ?? true}
              onChange={(checked) => update({ enabled: checked })}
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

        {/* 范围 —— 13-1（效果图改法 B）：与下面的动作区共用同一条网格
            （标签列 88px + 控件列 1fr，控件从控件列起点左对齐），范围收成一行 */}
        <section className="border-t border-border pt-4">
          <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-[7px]">
            <span className="text-xs text-muted-foreground">
              {t("automation.scope")}
            </span>
            <div className="flex min-w-0 justify-start">
              <SegmentedControl
                // 改法 B：范围这三段与下面三个三态组同宽（控件列 250px 里的等宽三段）——
                // 原来按内容撑（实测 80/52/52），右缘参差、与三态组的左缘也对不齐
                className="w-full [&_button]:flex-1"
                value={draft.scopeType}
                onValueChange={(value) =>
                  update({
                    scopeType: value,
                    scopeId: value === "all" ? undefined : draft.scopeId,
                  })
                }
                options={scopeOptions}
              />
            </div>
            {draft.scopeType === "folder" && (
              <>
                <span className="text-xs text-muted-foreground">
                  {t("automation.scope_folder")}
                </span>
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
                  className="w-full max-w-[18rem]"
                />
              </>
            )}
            {draft.scopeType === "feed" && (
              <>
                <span className="text-xs text-muted-foreground">
                  {t("automation.scope_feed")}
                </span>
                <div className="min-w-0 space-y-1">
                  {/* 订阅范围可多选（用户 11-16）：勾几个源，规则/视图就作用在这几个源上 */}
                  <FeedScopePicker
                    ariaLabel={t("automation.scope")}
                    values={draft.scopeIds ?? (draft.scopeId ? [draft.scopeId] : [])}
                    onValuesChange={(values) =>
                      update({
                        scopeIds: values,
                        // 多选后不再写单选字段，免得两个字段各说一套
                        scopeId: undefined,
                      })
                    }
                    options={(feeds ?? []).map((feed) => ({
                      value: feed.id,
                      label: feed.title,
                    }))}
                  />
                  <div className="text-xs text-muted-foreground">
                    {t("automation.scope_feed_multi_hint")}
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        {/* 视图专属（用户 11-5）：固定只在某些内容类型下显示 + 自定义图标 */}
        {isView && (
          <section className="space-y-2 border-t border-border pt-4">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t("automation.view_display")}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {t("automation.view_only_in")}
              </span>
              <ToggleButtonGroup
                selectionMode="multiple"
                size="sm"
                selectedKeys={draft.contentTypes ?? []}
                onSelectionChange={(keys) =>
                  update({
                    contentTypes: [...keys].map(String) as ContentType[],
                  })
                }
              >
                {CONTENT_TYPE_ORDER.map((type) => (
                  <ToggleButton key={type} id={type}>
                    {t(`content_type.${type}`)}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {t("automation.view_icon")}
              </span>
              <ViewIconPicker
                value={draft.icon ?? ""}
                onChange={(icon) => update({ icon })}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {t("automation.view_only_in_hint")}
            </div>
          </section>
        )}

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
                  {/* [&_[role=combobox]]:h-9 —— HeroUI Select 的高度长在它自己的 trigger 上，
                      这里用后代选择器把它和 input/按钮一起抬到同一档，别让一行里三种高度 */}
                  <div className="flex flex-wrap items-center gap-1.5 [&_[role=combobox]]:h-9 [&_[role=combobox]]:min-h-9">
                    <button
                      type="button"
                      title={t("automation.negate")}
                      aria-pressed={Boolean(condition.negate)}
                      onClick={() =>
                        updateCondition(index, { negate: !condition.negate })
                      }
                      className={cn(
                        "h-9 w-9 shrink-0 rounded-[var(--radius)] border text-sm font-medium transition-colors",
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
                      className="w-32 shrink-0"
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
                      className="w-28 shrink-0"
                    />
                    {needsValue ? (
                      <input
                        type="text"
                        value={condition.value ?? ""}
                        onChange={(event) =>
                          updateCondition(index, { value: event.target.value })
                        }
                        placeholder={valuePlaceholder(condition)}
                        // min-w：窄抽屉（350px）里原来会被挤成 22px 一条；
                        // 配合上面行的 flex-wrap，空间不够时它整行落到下一行
                        className={cn(inputClass, "min-w-[10rem] flex-1")}
                      />
                    ) : (
                      <div className="flex h-9 flex-1 items-center px-2.5 text-xs text-muted-foreground">
                        {t("automation.condition_value_empty")}
                      </div>
                    )}
                    <button
                      type="button"
                      title={t("automation.remove_condition")}
                      onClick={() => removeCondition(index)}
                      className="h-9 w-9 shrink-0 rounded-[var(--radius)] border border-border text-muted-foreground transition-colors hover:text-destructive"
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
            {/*
              12-12：动作区按用途分三组（用户选定方案）——
              ① 条目状态（静音 / 已读 / 加星 三个互斥维度 + 只保留匹配）
              ② 内容加工（打开时自动翻译 / 自动摘要）
              ③ 对外（推送到手机 / Webhook，各自带地址输入）
              成对的动作仍然用 HeroUI 三态组（不变 / 正向 / 反向）—— 一对动作做成两个开关会允许
              「同时又静音又取消静音」这种自相矛盾的组合；单项动作一律 HeroUI Switch。
            */}

            {/* ① 条目状态 */}
            <Fieldset className="border-t border-border/60 pt-3.5 mt-3.5">
              <Fieldset.Legend className="col-span-2 text-xs font-medium text-foreground">
                {t("automation.action_group_state")}
              </Fieldset.Legend>
            <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-[7px]">
              <Fieldset.Group className="contents">
                {ACTION_PAIRS.map(({ positive, negative }) => {
                  const value = draft.actions[positive]
                    ? "positive"
                    : draft.actions[negative]
                      ? "negative"
                      : "none";
                  // 「只保留匹配」本身会把不匹配的静音，再叠「静音」等于全静音 —— 挡掉这个误操作
                  const muteBlocked = positive === "mute" && keepOnlyBlocksMute;
                  return (
                    // 13-1：行包装用 contents，让「标签 + 控件」直接成为上面那条网格的两格
                    <div
                      key={positive}
                      className="contents"
                    >
                      <span className="text-xs text-muted-foreground">
                        {t(`automation.${DIMENSION_LABEL_KEYS[positive]}`)}
                      </span>
                      <ToggleButtonGroup
                        className="w-full [&_button]:flex-1"
                        selectionMode="single"
                        size="sm"
                        selectedKeys={[value]}
                        onSelectionChange={(keys) => {
                          const next = [...keys][0];
                          setActionDimension(
                            positive,
                            negative,
                            (next ?? "none") as "none" | "positive" | "negative",
                          );
                        }}
                      >
                        <ToggleButton id="none">
                          {t("automation.action_none")}
                        </ToggleButton>
                        <ToggleButton id="positive" isDisabled={muteBlocked}>
                          {t(`automation.${ACTION_LABEL_KEYS[positive]}`)}
                        </ToggleButton>
                        <ToggleButton id="negative">
                          {t(`automation.${ACTION_LABEL_KEYS[negative]}`)}
                        </ToggleButton>
                      </ToggleButtonGroup>
                    </div>
                  );
                })}
              </Fieldset.Group>
              <div className="contents">
                <span
                  className="text-xs text-muted-foreground"
                  title={t("automation.keep_only_hint")}
                >
                  {t("automation.action_keep_only")}
                </span>
                <HeroSwitch
                  aria-label={t("automation.action_keep_only")}
                  isSelected={Boolean(draft.actions.keepOnly)}
                  isDisabled={Boolean(draft.actions.mute)}
                  onChange={(checked: boolean) =>
                    update({
                      actions: { ...draft.actions, keepOnly: checked },
                    })
                  }
                />
              </div>
              {keepOnlyBlocksMute && (
                <div className="col-span-2 text-xs text-muted-foreground">
                  {t("automation.mute_blocked_by_keep_only")}
                </div>
              )}
            </div>
            </Fieldset>

            {/* ② 内容加工 */}
            <Fieldset className="border-t border-border/60 pt-3.5 mt-3.5">
              <Fieldset.Legend className="col-span-2 text-xs font-medium text-foreground">
                {t("automation.action_group_content")}
              </Fieldset.Legend>
            <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-[7px]">
              <div className="contents">
                <span
                  className="text-xs text-muted-foreground"
                  title={t(`automation.${ACTION_HINT_KEYS["translate"]}`)}
                >
                  {t("automation.action_translate")}
                </span>
                <HeroSwitch
                  aria-label={t("automation.action_translate")}
                  isSelected={Boolean(draft.actions.translate)}
                  onChange={(checked) =>
                    update({ actions: { ...draft.actions, translate: checked } })
                  }
                />
              </div>
              <div className="contents">
                <span
                  className="text-xs text-muted-foreground"
                  title={t(`automation.${ACTION_HINT_KEYS["summarize"]}`)}
                >
                  {t("automation.action_summarize")}
                </span>
                <HeroSwitch
                  aria-label={t("automation.action_summarize")}
                  isSelected={Boolean(draft.actions.summarize)}
                  onChange={(checked) =>
                    update({ actions: { ...draft.actions, summarize: checked } })
                  }
                />
              </div>
            </div>
            </Fieldset>

            {/* ③ 对外 */}
            <Fieldset className="border-t border-border/60 pt-3.5 mt-3.5">
              <Fieldset.Legend className="col-span-2 text-xs font-medium text-foreground">
                {t("automation.action_group_external")}
              </Fieldset.Legend>
            <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-[7px]">
              <div className="contents">
                <span
                  className="text-xs text-muted-foreground"
                  title={t(`automation.${ACTION_HINT_KEYS["notify"]}`)}
                >
                  {t("automation.action_notify")}
                </span>
                <HeroSwitch
                  aria-label={t("automation.action_notify")}
                  isSelected={Boolean(draft.actions.notify)}
                  onChange={(checked) =>
                    update({ actions: { ...draft.actions, notify: checked } })
                  }
                />
              </div>
              {draft.actions.notify && (
                <input
                  type="text"
                  value={draft.actions.notifyUrl ?? ""}
                  onChange={(event) =>
                    update({
                      actions: {
                        ...draft.actions,
                        notifyUrl: event.target.value,
                      },
                    })
                  }
                  placeholder={t("automation.notify_url_placeholder")}
                  className={cn(inputClass, "col-start-2")}
                />
              )}
              <div className="contents">
                <span
                  className="text-xs text-muted-foreground"
                  title={t(`automation.${ACTION_HINT_KEYS["webhook"]}`)}
                >
                  {t("automation.action_webhook")}
                </span>
                <HeroSwitch
                  aria-label={t("automation.action_webhook")}
                  isSelected={Boolean(draft.actions.webhook)}
                  onChange={(checked) =>
                    update({ actions: { ...draft.actions, webhook: checked } })
                  }
                />
              </div>
              {draft.actions.webhook && (
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
                  className={cn(inputClass, "col-start-2")}
                />
              )}
            </div>
            </Fieldset>

            {/* 只留一行总说明（其余都进 tooltip） */}
            <div className="text-xs text-muted-foreground">
              {t("automation.actions_hint")}
            </div>
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
            "h-8 rounded-[var(--radius)] border border-border px-3 text-sm font-medium transition-colors",
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
          className="h-8 rounded-[var(--radius)] px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("automation.cancel")}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving}
          className={cn(
            "h-8 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors",
            "hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {saving ? t("automation.saving") : t("automation.save")}
        </button>
      </div>
    </div>
  );
}
