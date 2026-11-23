import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Layers,
  Plus,
  Radar,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@heroui/react";
import { useSettingsDirty } from "@/stores/settings-dirty-store";
import {
  getAISettings,
  updateAISettings,
  testAIConnection,
  listAIModels,
  ApiError,
} from "@/api";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import type { SelectOption } from "@/components/ui/select";
import {
  SectionCard,
  SettingRow,
} from "@/components/settings/settings-primitives";
import { MCPServersSection } from "@/components/settings/tabs/MCPServersSection";
import type {
  AIProvider,
  AIProviderConfig,
  AISettings as AISettingsType,
  RequestOptions,
} from "@/types/settings";
import { showToast } from "@/stores/toast-store";

/** 免 key 免费翻译通道（可轮询的顺序由用户配置） */
const FREE_TRANSLATE_CHANNELS = ["google", "youdao"] as const;

/** 自动保存的防抖间隔（行为区整块自动保存，拍板 ~800ms） */
const AUTO_SAVE_DELAY_MS = 800;

function formatRequestOptions(
  value: RequestOptions | null | undefined,
): string {
  if (!value || Object.keys(value).length === 0) return "";
  return JSON.stringify(value, null, 2);
}

function parseRequestOptions(
  value: string,
): { ok: true; value: RequestOptions } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: {} };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return { ok: false, error: "request options must be a JSON object" };
    }
    return { ok: true, value: parsed as RequestOptions };
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
}

/** 本机地址：容器化部署时后端的 127.0.0.1 指的是容器自己（后端会自动改用 host.docker.internal） */
function isLoopbackBaseUrl(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return (
    value.includes("//localhost") ||
    value.includes("//127.0.0.1") ||
    value.includes("//[::1]") ||
    value.includes("//::1")
  );
}

/** 某份提供商可用的模型库：优先 models，老数据没有就退回默认模型。 */
function providerModels(entry: AIProviderConfig): string[] {
  if (entry.models && entry.models.length > 0) return entry.models;
  return entry.model ? [entry.model] : [];
}

/** 去重、去空白；保证默认模型在库里（有的话）。 */
function normalizeModels(defaultModel: string, models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string) => {
    const v = value.trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  const def = defaultModel.trim();
  if (def) push(def);
  models.forEach(push);
  return out;
}

/** 提供商编辑草稿（新建时 id 为 null） */
interface ProviderDraft {
  id: string | null;
  name: string;
  provider: AIProvider;
  baseUrl: string;
  apiKey: string;
  /** 默认模型：当前使用该提供商、或分场景只写到 provider:<id> 时用它 */
  model: string;
  /** 模型库（含默认模型） */
  models: string[];
  requestOptionsText: string;
}

function draftOf(entry: AIProviderConfig): ProviderDraft {
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    model: entry.model,
    models: providerModels(entry),
    requestOptionsText: formatRequestOptions(entry.requestOptions),
  };
}

function emptyDraft(defaultName: string): ProviderDraft {
  return {
    id: null,
    name: defaultName,
    provider: "compatible",
    baseUrl: "",
    apiKey: "",
    model: "",
    models: [],
    requestOptionsText: "",
  };
}

/** 提供商草稿快照（dirty 判定） */
function draftSnapshot(draft: ProviderDraft): string {
  return JSON.stringify([
    draft.id,
    draft.name,
    draft.provider,
    draft.baseUrl,
    draft.apiKey,
    draft.model,
    draft.models,
    draft.requestOptionsText,
  ]);
}

/** 行为区快照（自动保存的比较对象；只含行为字段，提供商表单改动不触发它） */
function behaviorSnapshotOf(settings: AISettingsType): string {
  return JSON.stringify([
    settings.summaryLanguage,
    settings.translateChannel,
    settings.translateChannels ?? [],
    settings.fallbackToModel,
    settings.autoTranslate,
    settings.autoSummary,
    settings.rateLimit,
    settings.sceneTranslate ?? "",
    settings.sceneSummary ?? "",
    settings.sceneAutomation ?? "",
  ]);
}

export function AISettings() {
  const { t } = useTranslation();

  const PROVIDERS: { value: AIProvider; label: string }[] = useMemo(
    () => [
      { value: "openai", label: t("ai_settings.provider_openai") },
      { value: "anthropic", label: t("ai_settings.provider_anthropic") },
      { value: "compatible", label: t("ai_settings.provider_compatible") },
    ],
    [t],
  );

  const SUMMARY_LANGUAGE_OPTIONS: { value: string; label: string }[] = useMemo(
    () => [
      { value: "zh-CN", label: t("ai_settings.lang_zh_cn") },
      { value: "zh-TW", label: t("ai_settings.lang_zh_tw") },
      { value: "en-US", label: t("ai_settings.lang_en") },
      { value: "ja", label: t("ai_settings.lang_ja") },
      { value: "ko", label: t("ai_settings.lang_ko") },
      { value: "es", label: t("ai_settings.lang_es") },
      { value: "fr", label: t("ai_settings.lang_fr") },
      { value: "de", label: t("ai_settings.lang_de") },
    ],
    [t],
  );

  const [settings, setSettings] = useState<AISettingsType | null>(null);
  const [providers, setProviders] = useState<AIProviderConfig[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string>("");
  /** 正在编辑的提供商草稿：null = 没有任何表单展开；id=null 表示新建 */
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<string | null>(null);
  const [probeChoices, setProbeChoices] = useState<string[] | null>(null);
  const [newModelInput, setNewModelInput] = useState("");
  const [isProbing, setIsProbing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message?: string;
    error?: string;
  } | null>(null);
  /** 行为区自动保存的状态（行内反馈） */
  const [autoSaveState, setAutoSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const behaviorBaselineRef = useRef<string | null>(null);
  const providerDirtyRef = useRef(false);

  const realProviders = providers.filter((item) => !item.placeholder);
  const activeProvider =
    realProviders.find((item) => item.id === activeProviderId) ?? null;
  const noUsableActive = !activeProviderId || !activeProvider;
  const hasUsableModel = !!settings?.model.trim();

  const draftRequestOptions = draft
    ? parseRequestOptions(draft.requestOptionsText)
    : ({ ok: true, value: {} } as const);
  const draftRequestOptionsError = draftRequestOptions.ok
    ? null
    : t("ai_settings.request_options_invalid");

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSettings = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getAISettings();
      setSettings(data);

      const list =
        data.providers && data.providers.length > 0
          ? data.providers
          : [
              {
                id: "default",
                name: data.provider,
                provider: data.provider,
                baseUrl: data.baseUrl,
                model: data.model,
                apiKey: data.apiKey,
                requestOptions: data.requestOptions,
                placeholder: true,
              },
            ];
      const active = data.activeProviderId || "";
      setProviders(list);
      setActiveProviderId(active);
      setDraft(null);
      behaviorBaselineRef.current = behaviorSnapshotOf(data);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t("ai_settings.failed_to_load"));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (
    field: keyof AISettingsType,
    value: string | boolean | number | RequestOptions | string[],
  ) => {
    if (!settings) return;
    setSettings({ ...settings, [field]: value } as AISettingsType);
    setSuccessMessage(null);
    setTestResult(null);
  };

  // 免费翻译通道轮询列表：顺序即轮询顺序，全部失败后再回退模型
  const translateChannels = settings?.translateChannels ?? [];
  const availableTranslateChannels = FREE_TRANSLATE_CHANNELS.filter(
    (channel) => !translateChannels.includes(channel),
  );
  const channelLabel = (channel: string) =>
    channel === "google"
      ? t("ai_settings.translate_channel_google")
      : channel === "youdao"
        ? t("ai_settings.translate_channel_youdao")
        : channel;
  const setTranslateChannels = (next: string[]) => {
    if (!settings) return;
    setSettings({
      ...settings,
      translateChannels: next,
      translateChannel: next[0] ?? "",
    } as AISettingsType);
    setSuccessMessage(null);
    setTestResult(null);
  };
  const addTranslateChannel = (channel: string) => {
    if (translateChannels.includes(channel)) return;
    setTranslateChannels([...translateChannels, channel]);
  };
  const removeTranslateChannel = (channel: string) => {
    setTranslateChannels(translateChannels.filter((item) => item !== channel));
  };
  const moveTranslateChannel = (index: number, delta: number) => {
    const target = index + delta;
    const moved = translateChannels[index];
    if (moved === undefined || target < 0 || target >= translateChannels.length)
      return;
    const next = translateChannels.filter((_, i) => i !== index);
    next.splice(target, 0, moved);
    setTranslateChannels(next);
  };

  // ---------- 提供商编辑 ----------

  const openDraft = (entry: AIProviderConfig) => {
    const next = draftOf(entry);
    setDraft(next);
    setDraftBaseline(draftSnapshot(next));
    setProbeChoices(null);
    setNewModelInput("");
    setTestResult(null);
    setSuccessMessage(null);
  };

  const handleSelectProvider = (id: string) => {
    if (draft?.id === id) {
      setDraft(null);
      setDraftBaseline(null);
      return;
    }
    const entry = providers.find((item) => item.id === id);
    if (!entry) return;
    openDraft(entry);
  };

  const handleStartCreate = () => {
    const next = emptyDraft(t("ai_settings.new_provider"));
    setDraft(next);
    setDraftBaseline(draftSnapshot(next));
    setProbeChoices(null);
    setNewModelInput("");
    setTestResult(null);
    setSuccessMessage(null);
  };

  const handleCancelDraft = () => {
    setDraft(null);
    setDraftBaseline(null);
    setProbeChoices(null);
    setNewModelInput("");
    setTestResult(null);
  };

  const patchDraft = (patch: Partial<ProviderDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setSuccessMessage(null);
    setTestResult(null);
  };

  const addModel = (model: string) => {
    if (!draft) return;
    const value = model.trim();
    if (!value || draft.models.includes(value)) return;
    patchDraft({
      models: [...draft.models, value],
      model: draft.model || value,
    });
  };

  const removeModel = (model: string) => {
    if (!draft) return;
    const models = draft.models.filter((m) => m !== model);
    patchDraft({
      models,
      model: draft.model === model ? (models[0] ?? "") : draft.model,
    });
  };

  const toggleProbeModel = (model: string) => {
    if (!draft) return;
    if (draft.models.includes(model)) {
      removeModel(model);
    } else {
      addModel(model);
    }
  };

  const addModelFromInput = () => {
    if (!newModelInput.trim()) return;
    addModel(newModelInput);
    setNewModelInput("");
  };

  const handleProbeModels = async () => {
    if (!draft) return;
    setIsProbing(true);
    setProbeChoices(null);
    try {
      const result = await listAIModels({
        provider: draft.provider,
        apiKey: draft.apiKey,
        baseUrl: draft.baseUrl,
      });
      setProbeChoices(result.models);
    } catch (err) {
      setTestResult({
        success: false,
        error:
          err instanceof Error ? err.message : t("ai_settings.probe_failed"),
      });
    } finally {
      setIsProbing(false);
    }
  };

  /**
   * 把一份提供商列表落库：平铺字段始终同步成「当前使用」那份（后端 AI 请求读的就是它）。
   * 成功返回 saved，失败抛错前已把 error 写好。
   */
  const persistProviders = async (
    list: AIProviderConfig[],
    activeId: string,
  ): Promise<AISettingsType | null> => {
    if (!settings) return null;
    const clean = list.filter((item) => !item.placeholder);
    const active = clean.find((item) => item.id === activeId) ?? null;
    const payload: AISettingsType = {
      ...settings,
      provider: active ? active.provider : settings.provider,
      apiKey: active ? active.apiKey : "",
      baseUrl: active ? active.baseUrl : "",
      model: active ? active.model : "",
      requestOptions: active ? (active.requestOptions ?? {}) : {},
      providers: clean,
      activeProviderId: active ? active.id : undefined,
    };
    setIsSaving(true);
    setError(null);
    try {
      const saved = await updateAISettings(payload);
      setSettings(saved);
      setProviders(
        saved.providers && saved.providers.length > 0
          ? saved.providers
          : clean,
      );
      setActiveProviderId(saved.activeProviderId || "");
      behaviorBaselineRef.current = behaviorSnapshotOf(saved);
      return saved;
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t("ai_settings.failed_to_save"));
      }
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!draft) return;
    const ro = parseRequestOptions(draft.requestOptionsText);
    if (!ro.ok) {
      setError(t("ai_settings.request_options_invalid"));
      return;
    }
    const isNew = draft.id === null;
    const id = draft.id ?? `provider-${Date.now()}`;
    const models = normalizeModels(draft.model, draft.models);
    const entry: AIProviderConfig = {
      id,
      name: draft.name.trim() || draft.provider,
      provider: draft.provider,
      baseUrl: draft.baseUrl.trim(),
      model: models[0] ?? "",
      models,
      apiKey: draft.apiKey,
      requestOptions: ro.value,
    };
    const list = isNew
      ? [...realProviders, entry]
      : realProviders.map((item) => (item.id === id ? entry : item));
    const nextActive = isNew ? id : activeProviderId;
    const saved = await persistProviders(list, nextActive);
    if (!saved) return;
    setSuccessMessage(t("ai_settings.settings_saved"));
    setDraft(null);
    setDraftBaseline(null);
    setProbeChoices(null);
    setNewModelInput("");
  };

  const handleDeleteProvider = async (id: string) => {
    const remaining = realProviders.filter((item) => item.id !== id);
    const nextActive =
      activeProviderId === id
        ? (remaining.find((item) => item.model)?.id ?? "")
        : activeProviderId;
    if (draft?.id === id) {
      setDraft(null);
      setDraftBaseline(null);
    }
    await persistProviders(remaining, nextActive);
    setSuccessMessage(null);
  };

  const handleSetActiveProvider = async (id: string) => {
    const saved = await persistProviders(realProviders, id);
    if (!saved) return;
    setSuccessMessage(t("ai_settings.settings_saved"));
    showToast(t("ai_settings.active_provider_changed"));
  };

  const handleTestDraft = async () => {
    if (!draft) return;
    const ro = parseRequestOptions(draft.requestOptionsText);
    if (!ro.ok) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await testAIConnection({
        provider: draft.provider,
        apiKey: draft.apiKey,
        baseUrl: draft.baseUrl,
        model: draft.model,
        requestOptions: ro.value,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : "Test failed",
      });
    } finally {
      setIsTesting(false);
    }
  };

  const buildSettingsPayload = (activeIdOverride?: string): AISettingsType | null => {
    if (!settings) return null;
    const activeId = activeIdOverride ?? activeProviderId;
    const active =
      realProviders.find((item) => item.id === activeId) ?? null;
    return {
      ...settings,
      provider: active ? active.provider : settings.provider,
      apiKey: active ? active.apiKey : "",
      baseUrl: active ? active.baseUrl : "",
      model: active ? active.model : "",
      requestOptions: active ? (active.requestOptions ?? {}) : {},
      providers: realProviders,
      activeProviderId: active ? active.id : undefined,
    };
  };

  // 未保存改动只看提供商草稿；行为区自己自动保存
  const providerDirty =
    draft !== null &&
    draftBaseline !== null &&
    draftSnapshot(draft) !== draftBaseline;
  useSettingsDirty("ai", providerDirty, t("settings.dirty_label_ai"), () => {
    void handleSaveDraft();
  });

  useEffect(() => {
    providerDirtyRef.current = providerDirty;
  }, [providerDirty]);

  // ---------- 行为区自动保存（防抖 ~800ms，行内反馈） ----------
  const behaviorSnapshot = settings ? behaviorSnapshotOf(settings) : null;
  useEffect(() => {
    if (!settings || !behaviorSnapshot) return;
    const baselineSnapshot = behaviorBaselineRef.current;
    if (
      baselineSnapshot === null ||
      behaviorSnapshot === baselineSnapshot ||
      providerDirtyRef.current
    ) {
      return;
    }
    const timer = setTimeout(async () => {
      const payload = buildSettingsPayload();
      if (!payload) return;
      setAutoSaveState("saving");
      try {
        const saved = await updateAISettings(payload);
        setSettings(saved);
        behaviorBaselineRef.current = behaviorSnapshotOf(saved);
        setAutoSaveState("saved");
        setTimeout(() => {
          setAutoSaveState((state) => (state === "saved" ? "idle" : state));
        }, 1500);
      } catch {
        setAutoSaveState("error");
      }
    }, AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [behaviorSnapshot]);

  if (isLoading) {
    return (
      <div className="space-y-5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-2xl border border-border/60 bg-card/30"
          />
        ))}
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error || t("ai_settings.failed_to_load")}
      </div>
    );
  }

  const inputClass =
    "h-9 w-full min-w-0 rounded-md border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none";

  /** 分场景下拉：跟随当前使用 + 每家提供商库里的每个模型 */
  const sceneOptions: SelectOption[] = [
    { value: "", label: t("ai_settings.scene_follow") },
    ...realProviders.flatMap((item) => {
      const models = providerModels(item);
      return models.map((model) => ({
        value: `provider:${item.id}#${model}`,
        label: `${item.name || item.provider} · ${model}`,
      }));
    }),
  ];
  const sceneValueOptions = (current?: string): SelectOption[] => {
    if (!current) return sceneOptions;
    if (sceneOptions.some((option) => option.value === current)) {
      return sceneOptions;
    }
    // 旧值 provider:<id>（不带模型）或提供商被删：保留原值，标出可读名，别悄悄清空
    let label = current;
    if (current.startsWith("provider:")) {
      const [id, model] = current.slice("provider:".length).split("#");
      const found = realProviders.find((item) => item.id === id);
      if (found) {
        label = `${found.name || found.provider} · ${
          model || found.model || t("ai_settings.scene_default_model")
        }`;
      }
    }
    return [{ value: current, label }, ...sceneOptions];
  };

  const isBaseURLRequiredDraft =
    draft?.provider === "openai" || draft?.provider === "compatible";
  const canSaveDraft =
    draft !== null && draftRequestOptions.ok && !isSaving;
  const canTestDraft =
    draft !== null &&
    !isTesting &&
    !!draft.apiKey.trim() &&
    !!draft.model.trim() &&
    (!isBaseURLRequiredDraft || !!draft.baseUrl.trim()) &&
    draftRequestOptions.ok;

  const currentProviderText = noUsableActive
    ? t("ai_settings.current_provider_none")
    : t("ai_settings.current_provider", {
        name: activeProvider?.name || activeProvider?.provider || "-",
        model: activeProvider?.model || "-",
      });

  /** 提供商表单：新建与编辑共用同一套字段（所以新建时也能探测模型 —— 需求 2） */
  const renderProviderForm = (isNew: boolean) => {
    if (!draft) return null;
    return (
      <div className="space-y-2 border-t border-border/60 px-1 pb-3 pt-3">
        <SettingRow label={t("ai_settings.provider")}>
          <Select
            ariaLabel={t("ai_settings.provider")}
            value={draft.provider}
            onChange={(value) =>
              patchDraft({ provider: value as AIProvider })
            }
            options={PROVIDERS}
            className="shrink-0 sm:w-56"
          />
        </SettingRow>

        <SettingRow label={t("ai_settings.api_key")}>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(e) => patchDraft({ apiKey: e.target.value })}
            placeholder={
              draft.provider === "openai"
                ? "sk-..."
                : draft.provider === "anthropic"
                  ? "sk-ant-..."
                  : t("ai_settings.enter_api_key")
            }
            className={cn(inputClass, "shrink-0 sm:w-56")}
          />
        </SettingRow>

        <SettingRow label={t("ai_settings.provider_name")}>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => patchDraft({ name: e.target.value })}
            placeholder={t("ai_settings.provider_name_placeholder")}
            className={cn(inputClass, "shrink-0 sm:w-56")}
          />
        </SettingRow>

        <SettingRow
          label={t("ai_settings.base_url")}
          hint={
            isBaseURLRequiredDraft
              ? t("ai_settings.required")
              : t("ai_settings.optional")
          }
        >
          <input
            type="text"
            value={draft.baseUrl}
            onChange={(e) => patchDraft({ baseUrl: e.target.value })}
            placeholder={
              draft.provider === "compatible"
                ? "https://openrouter.ai/api/v1"
                : draft.provider === "openai"
                  ? "https://api.openai.com/v1"
                  : t("ai_settings.leave_empty_for_default")
            }
            className={cn(inputClass, "shrink-0 sm:w-56")}
          />
        </SettingRow>
        {isLoopbackBaseUrl(draft.baseUrl) && (
          <p className="px-1 text-xs text-muted-foreground">
            {t("ai_settings.loopback_hint")}
          </p>
        )}

        {/* 模型库：同一提供商下可挂多个模型（翻译/摘要各选其一） */}
        <div className="space-y-2 rounded-[var(--radius)] bg-secondary/30 px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="text-sm font-medium">
                {t("ai_settings.models_library")}
              </span>
              <p className="text-xs text-muted-foreground">
                {t("ai_settings.models_library_hint")}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              isDisabled={isProbing || !draft.baseUrl.trim()}
              onPress={() => void handleProbeModels()}
            >
              {isProbing ? (
                <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Radar className="size-3.5" />
              )}
              {isProbing
                ? t("ai_settings.probing")
                : t("ai_settings.probe_models")}
            </Button>
          </div>

          {draft.models.length === 0 ? (
            <p className="rounded-[var(--radius)] border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
              {t("ai_settings.models_library_empty")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {draft.models.map((model) => (
                <span
                  key={model}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                    model === draft.model
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border bg-card text-foreground",
                  )}
                >
                  {model}
                  <button
                    type="button"
                    onClick={() => removeModel(model)}
                    title={t("actions.delete")}
                    className="text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* 手动补充一个探测不到的模型名 */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newModelInput}
              onChange={(e) => setNewModelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addModelFromInput();
                }
              }}
              placeholder={t("ai_settings.model_example", {
                example: "deepseek-chat",
              })}
              className={cn(inputClass, "flex-1")}
            />
            <Button
              size="sm"
              variant="outline"
              isDisabled={!newModelInput.trim()}
              onPress={addModelFromInput}
            >
              <Plus className="size-3.5" />
              {t("ai_settings.add_model")}
            </Button>
          </div>

          {probeChoices && probeChoices.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {t("ai_settings.probe_result", {
                    count: probeChoices.length,
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const merged = normalizeModels(draft.model, [
                      ...draft.models,
                      ...probeChoices,
                    ]);
                    patchDraft({
                      models: merged,
                      model: draft.model || merged[0] || "",
                    });
                  }}
                  className="text-xs text-primary transition-colors hover:underline"
                >
                  {t("ai_settings.probe_add_all")}
                </button>
              </div>
              <div className="max-h-44 overflow-y-auto rounded-[var(--radius)] border border-border/60 bg-background p-1">
                {probeChoices.map((model) => {
                  const picked = draft.models.includes(model);
                  return (
                    <button
                      key={model}
                      type="button"
                      onClick={() => toggleProbeModel(model)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-item-hover"
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border",
                          picked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border",
                        )}
                      >
                        {picked && <Check className="size-3" />}
                      </span>
                      <span className="min-w-0 truncate">{model}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 默认模型：从模型库里挑一个，供「当前使用」与分场景默认值 */}
        <SettingRow
          label={t("ai_settings.default_model")}
          hint={t("ai_settings.default_model_hint")}
        >
          <Select
            ariaLabel={t("ai_settings.default_model")}
            value={draft.model}
            onChange={(value) => patchDraft({ model: value })}
            options={draft.models.map((model) => ({
              value: model,
              label: model,
            }))}
            placeholder={t("ai_settings.models_library_empty")}
            disabled={draft.models.length === 0}
            className="shrink-0 sm:w-56"
          />
        </SettingRow>

        {/* 请求参数 */}
        <div className="space-y-2 px-1 pt-1">
          <div className="min-w-0">
            <span className="text-sm font-medium">
              {t("ai_settings.request_options")}
            </span>
            <p className="text-xs text-muted-foreground">
              {t("ai_settings.request_options_hint")}
            </p>
          </div>
          <textarea
            value={draft.requestOptionsText}
            onChange={(e) => patchDraft({ requestOptionsText: e.target.value })}
            placeholder={JSON.stringify({ key: "value" }, null, 2)}
            className={cn(
              "min-h-20 w-full rounded-field border bg-background px-3 py-2 font-mono text-xs focus:border-primary focus:outline-none",
              draftRequestOptionsError ? "border-destructive" : "border-border",
            )}
            spellCheck={false}
          />
          {draftRequestOptionsError && (
            <p className="text-xs text-destructive">{draftRequestOptionsError}</p>
          )}
        </div>

        {/* 保存 / 测试 / 设为当前使用 */}
        <div className="flex flex-wrap items-center gap-3 px-1 pt-1">
          <Button
            size="sm"
            isDisabled={!canSaveDraft}
            onPress={() => void handleSaveDraft()}
          >
            {isSaving ? (
              <>
                <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {t("ai_settings.saving")}
              </>
            ) : (
              t("ai_settings.save")
            )}
          </Button>

          <Button
            size="sm"
            variant="outline"
            isDisabled={!canTestDraft}
            onPress={() => void handleTestDraft()}
          >
            {isTesting ? (
              <>
                <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {t("ai_settings.testing")}
              </>
            ) : (
              t("ai_settings.test")
            )}
          </Button>

          {!isNew && draft.id !== activeProviderId && (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={isSaving}
              onPress={() => void handleSetActiveProvider(draft.id as string)}
            >
              {t("ai_settings.set_active")}
            </Button>
          )}

          {isNew && (
            <Button size="sm" variant="ghost" onPress={handleCancelDraft}>
              {t("actions.cancel")}
            </Button>
          )}

          {testResult && (
            <span
              className={cn(
                "text-sm",
                testResult.success
                  ? "text-green-600 dark:text-green-400"
                  : "text-destructive",
              )}
            >
              {testResult.success
                ? t("ai_settings.test_success") + "!"
                : testResult.error}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {/* 提供商（连接）：一个提供商可挂多个模型 */}
      <SectionCard
        icon={<Sparkles className="size-4" />}
        title={t("ai_settings.providers")}
        description={currentProviderText}
        action={
          <Button size="sm" variant="outline" onPress={handleStartCreate}>
            <Plus className="size-3.5" />
            {t("ai_settings.add_provider")}
          </Button>
        }
      >
        <div className="divide-y divide-border/50">
          {realProviders.length === 0 && !draft && (
            <div className="px-1 py-6 text-center text-sm text-muted-foreground">
              {t("ai_settings.providers_empty")}
            </div>
          )}

          {realProviders.map((item) => {
            const isOpen = draft?.id === item.id;
            const isActive = item.id === activeProviderId;
            const models = providerModels(item);
            return (
              <div key={item.id}>
                <div className="flex items-center gap-2 px-1 py-2.5">
                  <button
                    type="button"
                    onClick={() => handleSelectProvider(item.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={item.baseUrl || item.name}
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                        isOpen && "rotate-90",
                      )}
                    />
                    <span className="max-w-44 truncate text-sm font-medium">
                      {item.name || item.provider}
                    </span>
                    <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                      {item.provider}
                    </span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {item.model || "-"}
                    </span>
                    {models.length > 1 && (
                      <span className="shrink-0 rounded-full bg-secondary px-1.5 py-px text-[10px] text-muted-foreground">
                        {t("ai_settings.model_count", { count: models.length })}
                      </span>
                    )}
                  </button>
                  {isActive && (
                    <span className="shrink-0 text-[10px] text-primary">
                      {t("ai_settings.active_badge")}
                    </span>
                  )}
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={t("actions.delete")}
                    onPress={() => void handleDeleteProvider(item.id)}
                  >
                    <Trash2 className="size-3.5 text-muted-foreground" />
                  </Button>
                </div>
                {isOpen && renderProviderForm(false)}
              </div>
            );
          })}
        </div>

        {/* 内联新建表单：保存成功前不落库 */}
        {draft && draft.id === null && (
          <div className="mt-1 rounded-[var(--radius)] border border-primary border-dashed">
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="rounded-full border border-primary/40 bg-primary/5 px-1.5 py-px text-[10px] text-primary">
                {t("ai_settings.creating_badge")}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("ai_settings.creating_hint")}
              </span>
            </div>
            {renderProviderForm(true)}
          </div>
        )}
      </SectionCard>

      {/* AI 行为（这一块自动保存） */}
      <SectionCard
        icon={<SlidersHorizontal className="size-4" />}
        title={t("ai_settings.behavior_section")}
        action={
          <span
            className={cn(
              "text-xs",
              autoSaveState === "error" && "text-destructive",
              autoSaveState === "saved" && "text-green-600 dark:text-green-400",
              autoSaveState === "idle" && "text-muted-foreground",
            )}
          >
            {autoSaveState === "saving" && t("ai_settings.autosave_saving")}
            {autoSaveState === "saved" && t("ai_settings.autosave_saved")}
            {autoSaveState === "error" && t("ai_settings.autosave_failed")}
          </span>
        }
      >
        <div className="divide-y divide-border/50">
          <SettingRow
            label={t("ai_settings.summary_language")}
            hint={t("ai_settings.summary_language_hint")}
          >
            <Select
              ariaLabel={t("ai_settings.summary_language")}
              value={settings.summaryLanguage}
              onChange={(value) => handleChange("summaryLanguage", value)}
              options={SUMMARY_LANGUAGE_OPTIONS}
              className="w-40 shrink-0"
            />
          </SettingRow>

          {/* 翻译通道：免 key 通道按顺序轮询 */}
          <div className="px-1 py-2.5">
            <div className="min-w-0">
              <span className="text-sm font-medium">
                {t("ai_settings.translate_channel")}
              </span>
              <p className="text-xs text-muted-foreground">
                {t("ai_settings.translate_channel_hint")}
              </p>
            </div>
            <div className="mt-2 space-y-1.5">
              {translateChannels.length === 0 ? (
                <p className="rounded-[var(--radius)] border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
                  {t("ai_settings.translate_channels_empty")}
                </p>
              ) : (
                translateChannels.map((channel, index) => (
                  <div
                    key={channel}
                    className="flex items-center gap-2 rounded-[var(--radius)] border border-border/60 bg-card/40 px-2.5 py-1.5"
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-medium text-primary">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {channelLabel(channel)}
                    </span>
                    <button
                      type="button"
                      onClick={() => moveTranslateChannel(index, -1)}
                      disabled={index === 0}
                      title={t("ai_settings.translate_channel_up")}
                      className="shrink-0 text-muted-foreground transition-colors duration-200 hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveTranslateChannel(index, 1)}
                      disabled={index === translateChannels.length - 1}
                      title={t("ai_settings.translate_channel_down")}
                      className="shrink-0 text-muted-foreground transition-colors duration-200 hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeTranslateChannel(channel)}
                      title={t("ai_settings.translate_channel_remove")}
                      className="shrink-0 text-muted-foreground transition-colors duration-200 hover:text-destructive"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))
              )}
              {availableTranslateChannels.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {availableTranslateChannels.map((channel) => (
                    <button
                      key={channel}
                      type="button"
                      onClick={() => addTranslateChannel(channel)}
                      className="flex items-center gap-1 rounded-[var(--radius)] border border-border px-2.5 py-1 text-xs text-foreground transition-colors duration-200 hover:bg-item-hover"
                    >
                      <Plus className="size-3.5" /> {channelLabel(channel)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <SettingRow
            label={t("ai_settings.fallback_to_model")}
            hint={t("ai_settings.fallback_to_model_hint")}
          >
            <Switch
              className="shrink-0"
              checked={settings.fallbackToModel !== false}
              onCheckedChange={(checked) =>
                handleChange("fallbackToModel", checked)
              }
            />
          </SettingRow>

          <SettingRow
            label={t("ai_settings.auto_translate")}
            hint={t("ai_settings.auto_translate_hint")}
          >
            <Switch
              checked={settings.autoTranslate}
              onCheckedChange={(checked) =>
                handleChange("autoTranslate", checked)
              }
              className="shrink-0"
            />
          </SettingRow>

          <SettingRow
            label={t("ai_settings.auto_summary")}
            hint={t("ai_settings.auto_summary_hint")}
            disabled={!hasUsableModel}
          >
            <Switch
              checked={settings.autoSummary}
              onCheckedChange={(checked) =>
                handleChange("autoSummary", checked)
              }
              disabled={!hasUsableModel}
              title={hasUsableModel ? undefined : t("ai_settings.needs_model_hint")}
              className="shrink-0"
            />
          </SettingRow>

          <SettingRow
            label={t("ai_settings.rate_limit_label")}
            hint={t("ai_settings.rate_limit_hint")}
          >
            <input
              type="number"
              value={settings.rateLimit}
              onChange={(e) =>
                handleChange("rateLimit", parseInt(e.target.value) || 10)
              }
              min={1}
              max={100}
              className={cn(inputClass, "w-20 shrink-0")}
            />
          </SettingRow>
        </div>
      </SectionCard>

      {/* 分场景模型：翻译 / 摘要 / 自动化各可用不同提供商的某个模型 */}
      <SectionCard
        icon={<Layers className="size-4" />}
        title={t("ai_settings.scene_section")}
        description={t("ai_settings.scene_hint")}
      >
        <div className="divide-y divide-border/50">
          <SettingRow label={t("ai_settings.scene_translate")}>
            <Select
              ariaLabel={t("ai_settings.scene_translate")}
              value={settings.sceneTranslate ?? ""}
              onChange={(value) => handleChange("sceneTranslate", value)}
              options={sceneValueOptions(settings.sceneTranslate)}
              className="w-64 shrink-0"
            />
          </SettingRow>
          <SettingRow
            label={t("ai_settings.scene_summary")}
            disabled={!hasUsableModel}
          >
            <Select
              ariaLabel={t("ai_settings.scene_summary")}
              value={settings.sceneSummary ?? ""}
              onChange={(value) => handleChange("sceneSummary", value)}
              options={sceneValueOptions(settings.sceneSummary)}
              disabled={!hasUsableModel}
              className="w-64 shrink-0"
            />
          </SettingRow>
          <SettingRow
            label={t("ai_settings.scene_automation")}
            disabled={!hasUsableModel}
          >
            <Select
              ariaLabel={t("ai_settings.scene_automation")}
              value={settings.sceneAutomation ?? ""}
              onChange={(value) => handleChange("sceneAutomation", value)}
              options={sceneValueOptions(settings.sceneAutomation)}
              disabled={!hasUsableModel}
              className="w-64 shrink-0"
            />
          </SettingRow>
        </div>
      </SectionCard>

      {/* 消息 */}
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:bg-green-500/20 dark:text-green-400">
          {successMessage}
        </div>
      )}

      {/* MCP 服务：连接管理 + 「新建 MCP 订阅」向导入口 */}
      <MCPServersSection />
    </div>
  );
}
