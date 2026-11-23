import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Checkbox,
  Input,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import {
  Eye,
  ListFilter,
  PenLine,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import {
  GroupLabel,
  SectionCard,
  SettingRow,
} from "@/components/settings/settings-primitives";
import { HeroSwitch } from "@/components/ui/hero-switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { ViewIconPicker } from "@/components/automation/ViewIconPicker";
import { FeedScopePicker } from "@/components/automation/FeedScopePicker";
import { PluginActionFields } from "@/components/automation/PluginActionFields";
import { PluginSlot } from "@/plugins/PluginSlot";
import { CONTENT_TYPE_ORDER } from "@/lib/content-type-meta";
import type { ContentType } from "@/types/api";
import { useFeeds } from "@/hooks/useFeeds";
import { useFolders } from "@/hooks/useFolders";
import { useFilterPreview } from "@/hooks/useFilters";
import { fetchPlugins } from "@/plugins/api";
import type { PluginActionMeta, PluginMeta } from "@/plugins/types";
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
  /**
   * 正在编辑的那条规则的 id（56-14）。新建时为 undefined。
   *
   * 编辑器要靠它决定两件事：底栏插件按钮的 selection 带不带 `filterId`、
   * 以及点击时要不要先保存（没有 id 的草稿直接推 = 推一条没有规则的推送）。
   * 它不在 `FilterWritePayload` 里 —— 那份形状是**原样发给后端**的写请求，多一个 id 就多一个脏字段。
   */
  filterId?: string;
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
  /**
   * 保存。可以返回**保存后的规则 id**（56-14）：底栏的插件按钮要「先保存再调用」，
   * 新建规则时正是靠这个返回值拿到刚生成 id 去推。同步返回 void / 什么都不返回 = 老行为。
   * 失败请 reject（调用方会把异常收掉，错误照旧由 `saveError` 显示）。
   */
  onSubmit: (
    payload: FilterWritePayload,
  ) => Promise<string | void> | string | void;
  onCancel: () => void;
}

/** 正反成对的动作（勾了正就禁用反，同一条规则里互斥）；xxxUrl / 插件动作不是开关，排除在外 */
type ActionKey = Exclude<
  keyof FilterActions,
  "webhookUrl" | "pluginActions"
>;

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
};

function emptyCondition(): FilterCondition {
  // 用户 11-23：自动化规则里的条件默认从「且」改成「或」。
  // 新建条件直接带上 logic:"or"，保存到后端的 payload 一定带 "or"（不靠展示兜底）。
  return { field: "title", operator: "contains", value: "", logic: "or" };
}

/**
 * 规则编辑器（范围 → 条件 → 动作 → 预览）。
 *
 * 紧凑高密度：条件是一行行 field×operator×value，行间是可点击切换的 and/or 胶囊，
 * 每行带「取反」；动作正反成对；底部常驻「预览影响」（干跑，不写库）。
 */
export function FilterEditor({
  initial,
  filterId,
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

  /**
   * 55-14：插件贡献的动作。清单来自 `GET /api/plugins` —— 只把**已启用插件里已启用的动作**
   * 拿出来渲染（停用即不在编辑器里出现，这是插件契约，不是这里额外加的守卫）。
   */
  const [plugins, setPlugins] = useState<PluginMeta[]>([]);
  /** 保存时被判为「必填却空着」的字段：键 `${pluginId}/${actionId}` → 字段键数组（标红用） */
  const [invalidPluginFields, setInvalidPluginFields] = useState<
    Record<string, string[]>
  >({});

  useEffect(() => {
    let alive = true;
    fetchPlugins()
      .then((list) => {
        if (alive) setPlugins(list);
      })
      // 清单拿不到不能让整张表单崩：插件动作区就是不出现，规则其余部分照常编辑/保存
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // 依赖 initial：抽屉关掉后编辑器仍挂在那儿，重新打开（新草稿）必须重拉一次 ——
    // 否则「刚刚停用某个插件」后编辑器还在列出它的动作（真机踩到，只有刷新页面才消失）
  }, [initial]);

  const pluginActions = useMemo(
    () =>
      plugins.flatMap((plugin) =>
        plugin.enabled ? plugin.actions.filter((action) => action.enabled) : [],
      ),
    [plugins],
  );

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

  /** 插件动作在界面里的唯一键（同一 (plugin, action) 只允许一条引用） */
  const pluginActionKey = (action: PluginActionMeta) =>
    `${action.pluginId}/${action.actionId}`;

  const findPluginAction = (pluginId: string, actionId: string) =>
    pluginActions.find(
      (action) => action.pluginId === pluginId && action.actionId === actionId,
    );

  /** 勾选 / 取消勾选一个插件动作：勾上建一条空 config 的引用，取消就从数组里摘掉 */
  const togglePluginAction = (action: PluginActionMeta, next: boolean) => {
    setDraft((current) => {
      const rest = (current.actions.pluginActions ?? []).filter(
        (item) =>
          !(item.plugin === action.pluginId && item.action === action.actionId),
      );
      return {
        ...current,
        actions: {
          ...current.actions,
          pluginActions: next
            ? [
                ...rest,
                {
                  plugin: action.pluginId,
                  action: action.actionId,
                  config: {},
                },
              ]
            : rest,
        },
      };
    });
    setInvalidPluginFields({});
    setPreviewResult(null);
  };

  /** 改某个动作的一个字段（不会影响其它动作的同名字段） */
  const setPluginActionField = (
    action: PluginActionMeta,
    key: string,
    value: string,
  ) => {
    setDraft((current) => ({
      ...current,
      actions: {
        ...current.actions,
        pluginActions: (current.actions.pluginActions ?? []).map((item) =>
          item.plugin === action.pluginId && item.action === action.actionId
            ? { ...item, config: { ...item.config, [key]: value } }
            : item,
        ),
      },
    }));
    setInvalidPluginFields({});
    setPreviewResult(null);
  };

  /**
   * 插件动作里「声明必填却空着」的字段。保存与预览共用这一份判定 ——
   * 校验只看插件自己声明的 required，本体不认识任何具体插件字段。
   */
  const pluginFieldIssues = (payload: FilterWritePayload) => {
    const issues: { action: PluginActionMeta; field: string; label: string }[] =
      [];
    for (const ref of payload.actions.pluginActions ?? []) {
      const action = findPluginAction(ref.plugin, ref.action);
      if (!action) continue;
      for (const field of action.fields) {
        if (field.required && !(ref.config?.[field.key] ?? "").trim()) {
          issues.push({ action, field: field.key, label: field.label });
        }
      }
    }
    return issues;
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

  /**
   * 52-6（用户第 6 条「创建自动化时，如果没有输入标题，也是可以预览的」）：
   * `requireName` 缺省 true（保存必须有名称），预览传 false —— 名称对 dry-run 没有任何意义，
   * 条件/动作/范围这些「会影响命中结果」的校验一条都不能少。
   */
  const validate = (
    payload: FilterWritePayload,
    options?: { requireName?: boolean },
  ): string | null => {
    if (options?.requireName !== false && !payload.name.trim()) {
      return t("automation.invalid");
    }
    if (isView) {
      // 视图只筛条目：必须有条件，且不带任何动作
      if (payload.conditions.length === 0) return t("automation.view_needs_condition");
    } else {
      if (!hasAnyAction(payload.actions)) return t("automation.invalid");
      if (payload.actions.webhook && !(payload.actions.webhookUrl ?? "").trim()) {
        return t("automation.webhook_needs_url");
      }
      // 插件动作的必填字段：文案里带字段名，用户不用猜是哪一栏
      const pluginIssue = pluginFieldIssues(payload)[0];
      if (pluginIssue) {
        return t("automation.plugin_action_field_required", {
          field: pluginIssue.label,
        });
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
        logic: condition.logic ?? "or",
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
    // 52-6：预览不要求名称（后端 /filters/preview 同步放开，见 ValidateFilterParamsBody）
    const error = validate(draft, { requireName: false });
    setValidationError(error);
    if (error) return;
    preview.mutate(
      { payload: buildPayload() },
      { onSuccess: (result) => setPreviewResult(result) },
    );
  };

  /**
   * 校验 + 标红，返回「有没有问题」。保存按钮与底栏插件按钮（先保存）共用这一份，
   * 两处口径必须一致，否则会出现「保存能过、推送被拦」这种自相矛盾。
   */
  const checkBeforeSave = (): boolean => {
    const error = validate(draft);
    setValidationError(error);
    // 必填却空着的那几栏标红（错误文案在底部，红框指到具体字段）
    const grouped: Record<string, string[]> = {};
    for (const issue of pluginFieldIssues(draft)) {
      const key = pluginActionKey(issue.action);
      grouped[key] = [...(grouped[key] ?? []), issue.field];
    }
    setInvalidPluginFields(grouped);
    return Boolean(error);
  };

  const handleSubmit = () => {
    if (checkBeforeSave()) return;
    // 保存失败由 onSubmit 自己报（saveError）；这里只把 rejection 收掉，
    // 不让一次点击变成未捕获的 Promise 拒绝（56-14 起 onSubmit 可能返回 Promise）
    void Promise.resolve(onSubmit(buildPayload())).catch(() => undefined);
  };

  /**
   * 底栏插件按钮的「先保存」（56-14）：确保这份草稿有一条落库的规则，返回它的 id。
   *
   * - 已经有 id（编辑既有规则）→ 直接用它，**不重复保存**；
   * - 新建 → 校验后保存，id 取自 `onSubmit` 的返回值（外壳用 mutateAsync 拿得到）；
   * - 校验不过 / 保存失败 → 抛错，`PluginSlot` 会因此放弃调用插件动作
   *   （错误已经显示在表单里，不需要第二个提示）。
   */
  const saveDraft = async (): Promise<string | null> => {
    if (filterId) return filterId;
    if (checkBeforeSave()) throw new Error("invalid filter draft");
    const savedId = await onSubmit(buildPayload());
    return typeof savedId === "string" && savedId ? savedId : null;
  };

  /** 插件动作的 selection：id 原样传字符串（int64 走 JS number 会丢精度，后端 Selection 两种都认） */
  const filterSelection = (id: string | null | undefined) => (id ? { filterId: id } : {});

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
      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-5">
        {/* 基本信息：名称 + 启用 */}
        <SectionCard
          icon={<PenLine className="size-4" />}
          title={t("automation.section_basic")}
        >
          <div className="divide-y divide-border/50">
            <div className="px-1 py-2.5">
              <div className="mb-2 text-sm text-foreground">
                {t("automation.name")}
              </div>
              <Input
                type="text"
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder={t("automation.name_placeholder")}
                aria-label={t("automation.name")}
                className="w-full"
              />
            </div>
            <SettingRow
              label={t("automation.enabled")}
              hint={t("automation.enabled_hint")}
            >
              <HeroSwitch
                aria-label={t("automation.enabled")}
                isSelected={draft.enabled ?? true}
                onChange={(checked) => update({ enabled: checked })}
              />
            </SettingRow>
          </div>
        </SectionCard>

        {/* 自然语言建规则：模型的一句话解释 + 被修正/丢弃的东西（绝不悄悄改） */}
        {(notes || warnings.length > 0) && (
          <SectionCard
            icon={<Sparkles className="size-4" />}
            title={t("automation.nl_draft_title")}
          >
            <div className="space-y-1 px-1 py-2.5">
              {notes && (
                <div className="text-xs leading-relaxed text-muted-foreground">
                  {notes}
                </div>
              )}
              {warnings.map((warning, index) => (
                <div key={index} className="text-xs text-destructive">
                  {warning}
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        {/* 范围 */}
        <SectionCard
          icon={<Target className="size-4" />}
          title={t("automation.scope")}
        >
          <div className="divide-y divide-border/50">
            {/* 范围三段：卡片标题已经写明「范围」，这一行不再重复标签，直接铺满 */}
            <div className="px-1 py-3">
              <SegmentedControl
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
              <SettingRow label={t("automation.scope_folder")}>
                <Select
                  ariaLabel={t("automation.scope_folder")}
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
                  className="w-56"
                />
              </SettingRow>
            )}
            {draft.scopeType === "feed" && (
              <SettingRow
                label={t("automation.scope_feed")}
                hint={t("automation.scope_feed_multi_hint")}
              >
                {/* 订阅范围可多选（用户 11-16）：勾几个源，规则/视图就作用在这几个源上 */}
                <FeedScopePicker
                  ariaLabel={t("automation.scope_feed")}
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
              </SettingRow>
            )}
          </div>
        </SectionCard>

        {/* 视图专属（用户 11-5）：固定只在某些内容类型下显示 + 自定义图标 */}
        {isView && (
          <SectionCard
            icon={<Eye className="size-4" />}
            title={t("automation.view_display")}
            description={t("automation.view_only_in_hint")}
          >
            <div className="divide-y divide-border/50">
              <SettingRow label={t("automation.view_only_in")}>
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
              </SettingRow>
              <SettingRow label={t("automation.view_icon")}>
                <ViewIconPicker
                  value={draft.icon ?? ""}
                  onChange={(icon) => update({ icon })}
                />
              </SettingRow>
            </div>
          </SectionCard>
        )}

        {/* 条件 */}
        <SectionCard
          icon={<ListFilter className="size-4" />}
          title={t("automation.conditions")}
          description={isView ? t("automation.view_needs_condition") : undefined}
          action={
            <Button size="sm" variant="outline" onPress={addCondition}>
              <Plus className="size-3.5" />
              {t("automation.add_condition")}
            </Button>
          }
        >
          <div className="px-1 py-2.5">
            {draft.conditions.length === 0 ? (
              <div className="rounded-[var(--radius)] border border-dashed border-border/70 px-3 py-6 text-center text-xs text-muted-foreground">
                {t("automation.conditions_any")}
              </div>
            ) : (
              <div className="space-y-1.5">
                {draft.conditions.map((condition, index) => {
                  const needsValue = !FILTER_OPERATORS_WITHOUT_VALUE.includes(
                    condition.operator,
                  );
                  return (
                    <div key={index} className="space-y-1.5">
                      {index > 0 && (
                        <div className="flex items-center gap-2 pl-1">
                          {/* 连接词用 HeroUI ToggleButton。选中态刻意不用 accent：
                              这套主题的 --accent 是黑白，暗色下会变成黑底黑字；
                              用 foreground 派生色，两套主题都翻得过来 */}
                          <ToggleButton
                            size="sm"
                            variant="ghost"
                            isSelected={(condition.logic ?? "or") === "or"}
                            onChange={() =>
                              updateCondition(index, {
                                logic:
                                  condition.logic === "or" ? "and" : "or",
                              })
                            }
                            // 按下态表示「当前是或」，读屏只会念出「已按下」容易误解，
                            // 所以 aria-label 直接写清当前值和点一下会变成什么
                            aria-label={`${t("automation.condition_logic")} ${index + 1}: ${t(
                              `automation.logic_${condition.logic ?? "or"}`,
                            )} → ${t(
                              `automation.logic_${(condition.logic ?? "or") === "or" ? "and" : "or"}`,
                            )}`}
                            className="h-6 min-h-6 rounded-full border border-border/60 px-2 text-[11px] font-medium text-muted-foreground data-[selected=true]:bg-foreground/10 data-[selected=true]:text-foreground"
                          >
                            {t(`automation.logic_${condition.logic ?? "or"}`)}
                          </ToggleButton>
                          <span className="h-px flex-1 bg-border/50" />
                        </div>
                      )}
                      {/* [&_[role=combobox]]:h-9 —— HeroUI Select 的高度长在它自己的 trigger 上，
                          这里用后代选择器把它和 input/按钮一起抬到同一档，别让一行里三种高度 */}
                      <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius)] border border-border/60 bg-card/40 p-1.5 [&_[role=combobox]]:h-9 [&_[role=combobox]]:min-h-9">
                        {/* 取反：HeroUI ToggleButton，选中时走 destructive 的底色，
                            一眼能看出这条条件是「不满足」 */}
                        <ToggleButton
                          isIconOnly
                          size="sm"
                          variant="ghost"
                          isSelected={Boolean(condition.negate)}
                          onChange={() =>
                            updateCondition(index, { negate: !condition.negate })
                          }
                          aria-label={t("automation.negate")}
                          className="size-9 min-w-9 shrink-0 rounded-[var(--radius)] border border-border/70 text-sm font-medium text-muted-foreground data-[selected=true]:border-destructive/40 data-[selected=true]:bg-destructive/10 data-[selected=true]:text-destructive"
                        >
                          !
                        </ToggleButton>
                        <Select
                          ariaLabel={`${t("automation.condition_field")} ${index + 1}`}
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
                          ariaLabel={`${t("automation.condition_operator")} ${index + 1}`}
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
                          <Input
                            type="text"
                            value={condition.value ?? ""}
                            onChange={(event) =>
                              updateCondition(index, {
                                value: event.target.value,
                              })
                            }
                            placeholder={valuePlaceholder(condition)}
                            aria-label={`${t("automation.condition_value")} ${index + 1}`}
                            // min-w：窄抽屉里原来会被挤成 22px 一条；
                            // 配合上面行的 flex-wrap，空间不够时它整行落到下一行
                            className="min-w-[10rem] flex-1"
                          />
                        ) : (
                          <div className="flex h-9 flex-1 items-center px-2.5 text-xs text-muted-foreground">
                            {t("automation.condition_value_empty")}
                          </div>
                        )}
                        <Button
                          isIconOnly
                          size="sm"
                          variant="ghost"
                          aria-label={t("automation.remove_condition")}
                          onPress={() => removeCondition(index)}
                          className="size-9 min-w-9 shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </SectionCard>

        {/* 动作（视图没有动作区：它只筛条目、不写数据） */}
        {isView ? (
          /* 视图没有动作区：与其空着，不如说清「它是什么、建好之后在哪」——
             这两句都不重复标题下的那句「视图不执行动作」 */
          <SectionCard
            icon={<SlidersHorizontal className="size-4" />}
            title={t("automation.view_kind")}
            description={t("automation.view_actions_hint")}
          >
            <div className="px-1 py-2.5 text-xs leading-relaxed text-muted-foreground">
              {t("automation.views_hint")}
            </div>
          </SectionCard>
        ) : (
          <SectionCard
            icon={<SlidersHorizontal className="size-4" />}
            title={t("automation.actions")}
            description={t("automation.actions_hint")}
          >
            {/*
              12-12：动作区按用途分三组（用户选定方案）——
              ① 条目状态（静音 / 已读 / 加星 三个互斥维度 + 只保留匹配）
              ② 内容加工（打开时自动翻译 / 自动摘要）
              ③ 对外（推送到手机 / Webhook，各自带地址输入）
              成对的动作仍然用 HeroUI 三态组（不变 / 正向 / 反向）—— 一对动作做成两个开关会允许
              「同时又静音又取消静音」这种自相矛盾的组合；单项动作一律 HeroUI Switch。
            */}
            <GroupLabel>{t("automation.action_group_state")}</GroupLabel>
            <div className="divide-y divide-border/50">
              {ACTION_PAIRS.map(({ positive, negative }) => {
                const value = draft.actions[positive]
                  ? "positive"
                  : draft.actions[negative]
                    ? "negative"
                    : "none";
                // 「只保留匹配」本身会把不匹配的静音，再叠「静音」等于全静音 —— 挡掉这个误操作
                const muteBlocked = positive === "mute" && keepOnlyBlocksMute;
                return (
                  <SettingRow
                    key={positive}
                    label={t(`automation.${DIMENSION_LABEL_KEYS[positive]}`)}
                  >
                    <ToggleButtonGroup
                      className="w-60 [&_button]:flex-1"
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
                  </SettingRow>
                );
              })}
              <SettingRow
                label={t("automation.action_keep_only")}
                hint={
                  keepOnlyBlocksMute
                    ? t("automation.mute_blocked_by_keep_only")
                    : t("automation.keep_only_hint")
                }
              >
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
              </SettingRow>
            </div>

            <GroupLabel>{t("automation.action_group_content")}</GroupLabel>
            <div className="divide-y divide-border/50">
              <SettingRow
                label={t("automation.action_translate")}
                hint={t(`automation.${ACTION_HINT_KEYS["translate"]}`)}
              >
                <HeroSwitch
                  aria-label={t("automation.action_translate")}
                  isSelected={Boolean(draft.actions.translate)}
                  onChange={(checked) =>
                    update({ actions: { ...draft.actions, translate: checked } })
                  }
                />
              </SettingRow>
              <SettingRow
                label={t("automation.action_summarize")}
                hint={t(`automation.${ACTION_HINT_KEYS["summarize"]}`)}
              >
                <HeroSwitch
                  aria-label={t("automation.action_summarize")}
                  isSelected={Boolean(draft.actions.summarize)}
                  onChange={(checked) =>
                    update({ actions: { ...draft.actions, summarize: checked } })
                  }
                />
              </SettingRow>
            </div>

            <GroupLabel>{t("automation.action_group_external")}</GroupLabel>
            <div className="divide-y divide-border/50">
              <SettingRow
                label={t("automation.action_webhook")}
                hint={t(`automation.${ACTION_HINT_KEYS["webhook"]}`)}
              >
                <HeroSwitch
                  aria-label={t("automation.action_webhook")}
                  isSelected={Boolean(draft.actions.webhook)}
                  onChange={(checked) =>
                    update({ actions: { ...draft.actions, webhook: checked } })
                  }
                />
              </SettingRow>
              {draft.actions.webhook && (
                <div className="px-1 py-2.5">
                  <Input
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
                    aria-label={t("automation.action_webhook")}
                    className="w-full"
                  />
                </div>
              )}
            </div>

            {/* ④ 插件动作（55-14）：字段形状由插件声明，这里只按声明画；
                停用的插件/动作不渲染 —— 想用就去 设置 → 插件 打开它 */}
            {pluginActions.length > 0 && (
              <>
                <GroupLabel>{t("automation.plugin_actions")}</GroupLabel>
                <div className="space-y-2 px-1 pb-2.5 pt-1">
                  {pluginActions.map((action) => {
                    const ref = draft.actions.pluginActions?.find(
                      (item) =>
                        item.plugin === action.pluginId &&
                        item.action === action.actionId,
                    );
                    const checked = Boolean(ref);
                    return (
                      <div key={pluginActionKey(action)} className="space-y-2">
                        <Checkbox
                          isSelected={checked}
                          onChange={(next: boolean) =>
                            togglePluginAction(action, next)
                          }
                          className="flex flex-row items-center gap-2"
                        >
                          <Checkbox.Control className="shrink-0">
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <Checkbox.Content className="min-w-0">
                            {/* 标签与来源整体可换行：窄抽屉里来源不会被拆到一半 */}
                            <span className="flex flex-wrap items-baseline gap-x-2">
                              <span className="text-sm text-foreground">
                                {action.label}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {t("automation.plugin_action_from", {
                                  name: action.pluginName,
                                })}
                              </span>
                            </span>
                          </Checkbox.Content>
                        </Checkbox>
                        {checked && (
                          <div className="pl-6">
                            <PluginActionFields
                              fields={action.fields}
                              config={ref?.config}
                              invalidKeys={
                                invalidPluginFields[pluginActionKey(action)]
                              }
                              onChange={(key, value) =>
                                setPluginActionField(action, key, value)
                              }
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="text-xs text-muted-foreground">
                    {t("automation.plugin_actions_hint")}
                  </div>
                </div>
              </>
            )}
          </SectionCard>
        )}

        {/* 预览结果：一次性结果卡，跟着设置页的卡片语言走（不抢 SectionCard 的标题栏） */}
        {previewResult && (
          <section className="rounded-2xl border border-border/60 bg-card/30 p-3 shadow-nf-sm">
            <div className="text-sm font-semibold text-foreground">
              {t("automation.preview_summary", {
                scanned: previewResult.scanned,
                matched: previewResult.matchedCount,
              })}
            </div>
            {previewResult.matchedCount === 0 ? (
              <div className="mt-1 text-xs text-muted-foreground">
                {t("automation.preview_empty", {
                  scanned: previewResult.scanned,
                })}
              </div>
            ) : (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
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
              <div className="mt-1 text-xs text-muted-foreground">
                {t("automation.preview_ai_skipped", {
                  count: previewResult.aiSkipped ?? 0,
                })}
                {(previewResult.aiSkipReasons ?? []).length > 0
                  ? ` — ${(previewResult.aiSkipReasons ?? []).join("；")}`
                  : ""}
              </div>
            )}
            {previewResult.matched.length > 0 && (
              <ul className="mt-2 max-h-40 space-y-0.5 overflow-auto border-t border-border/50 pt-2">
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
          <div className="rounded-[var(--radius)] border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {validationError ??
              saveError ??
              (preview.isError ? t("automation.preview_failed") : null)}
          </div>
        )}
      </div>

      {/* 底部常驻操作区 */}
      <div className="flex items-center gap-2 border-t border-border/60 bg-card/30 px-5 py-3">
        <Button
          size="sm"
          variant="outline"
          isDisabled={preview.isPending}
          onPress={handlePreview}
        >
          {preview.isPending
            ? t("automation.preview_running")
            : t("automation.preview")}
        </Button>
        <div className="flex-1" />
        {/* 56-14：插件往底栏加的按钮（这个挂点没有贡献就不占位）。
            点击先走 beforeInvoke 保存这份草稿：新建规则时还没 id，直接推就是一条
            「没有规则的推送」；保存成功才继续调用，返回的新 id 补进 selection。 */}
        <PluginSlot
          surface="filter.editor.footer"
          variant="toolbar"
          selection={filterSelection(filterId)}
          beforeInvoke={async () => filterSelection(await saveDraft())}
        />
        <Button size="sm" variant="ghost" onPress={onCancel}>
          {t("automation.cancel")}
        </Button>
        <Button size="sm" variant="primary" isDisabled={saving} onPress={handleSubmit}>
          {saving ? t("automation.saving") : t("automation.save")}
        </Button>
      </div>
    </div>
  );
}
