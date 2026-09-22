import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { MCPServersSection } from "@/components/settings/tabs/MCPServersSection";
import type {
  AIProvider,
  AIProviderConfig,
  AISettings as AISettingsType,
  RequestOptions,
} from "@/types/settings";
import { showToast } from "@/stores/toast-store";

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
  const [activeProviderId, setActiveProviderId] = useState("default");
  const [selectedProviderId, setSelectedProviderId] = useState("default");
  const [isProbing, setIsProbing] = useState(false);
  const [modelChoices, setModelChoices] = useState<string[] | null>(null);
  const [requestOptionsText, setRequestOptionsText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 12-7：加载/保存成功时的快照，用来判断「有没有未保存的改动」 */
  const [baseline, setBaseline] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message?: string;
    error?: string;
  } | null>(null);
  const isBaseURLRequired = settings
    ? settings.provider === "openai" || settings.provider === "compatible"
    : false;
  const hasBaseURL = settings ? settings.baseUrl.trim().length > 0 : false;
  const requestOptionsResult = useMemo(
    () => parseRequestOptions(requestOptionsText),
    [requestOptionsText],
  );
  const requestOptionsError = requestOptionsResult.ok
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
      setRequestOptionsText(formatRequestOptions(data.requestOptions));
      setBaseline(
        JSON.stringify([data, formatRequestOptions(data.requestOptions)]),
      );

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
              },
            ];
      const active = data.activeProviderId || list[0]?.id || "default";
      setProviders(list);
      setActiveProviderId(active);
      setSelectedProviderId(active);
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
    value: string | boolean | number | RequestOptions,
  ) => {
    if (!settings) return;
    setSettings({ ...settings, [field]: value } as AISettingsType);
    setSuccessMessage(null);
    setTestResult(null);
  };

  /** 把某个提供商配置灌进表单 */
  const applyProviderToForm = (
    base: AISettingsType,
    entry: AIProviderConfig,
  ): AISettingsType => ({
    ...base,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: entry.apiKey,
    requestOptions: entry.requestOptions ?? {},
  });

  const handleSelectProvider = (id: string) => {
    if (!settings) return;
    const entry = providers.find((item) => item.id === id);
    if (!entry) return;

    setSelectedProviderId(id);
    setSettings(applyProviderToForm(settings, entry));
    setRequestOptionsText(formatRequestOptions(entry.requestOptions));
    setModelChoices(null);
    setSuccessMessage(null);
    setTestResult(null);
  };

  const handleAddProvider = () => {
    if (!settings) return;
    const id = `provider-${Date.now()}`;
    const entry: AIProviderConfig = {
      id,
      name: t("ai_settings.new_provider"),
      provider: "compatible",
      baseUrl: "",
      model: "",
      apiKey: "",
      requestOptions: {},
    };
    setProviders([...providers, entry]);
    setSelectedProviderId(id);
    setSettings(applyProviderToForm(settings, entry));
    setRequestOptionsText("");
    setModelChoices(null);
    setSuccessMessage(null);
    setTestResult(null);
  };

  const handleDeleteProvider = (id: string) => {
    if (!settings || providers.length <= 1) return;
    const remaining = providers.filter((item) => item.id !== id);
    const nextActive =
      activeProviderId === id ? (remaining[0]?.id ?? activeProviderId) : activeProviderId;
    const nextSelected = selectedProviderId === id ? nextActive : selectedProviderId;

    setProviders(remaining);
    setActiveProviderId(nextActive);
    setSelectedProviderId(nextSelected);

    const target = remaining.find((item) => item.id === nextSelected);
    if (target) {
      setSettings(applyProviderToForm(settings, target));
      setRequestOptionsText(formatRequestOptions(target.requestOptions));
    }
    setSuccessMessage(null);
  };

  /**
   * 设为「当前使用」。
   *
   * 原来是只改本地 state、等用户再点保存 —— 用户看到「已是当前使用」就直接关掉弹窗，
   * 下次打开又被打回原样（实测就是这个现象）。所以这里直接落库：切换即保存，
   * 同时把该提供商的 provider/baseUrl/model/key 同步到后端的平铺字段（AI 请求实际读的是那几个）。
   */
  const handleSetActiveProvider = async (id: string) => {
    const payload = buildSettingsPayload(id);
    if (!payload) return;

    setActiveProviderId(id);
    setSuccessMessage(null);
    setIsSaving(true);
    setError(null);
    try {
      const saved = await updateAISettings(payload);
      setSettings(saved);
      if (saved.providers && saved.providers.length > 0) {
        setProviders(saved.providers);
      }
      setActiveProviderId(saved.activeProviderId || id);
      setSuccessMessage(t("ai_settings.settings_saved"));
      showToast(t("ai_settings.active_provider_changed"));
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t("ai_settings.failed_to_save"));
      }
    } finally {
      setIsSaving(false);
    }
  };

  /** 表单里的编辑合并回列表后再提交（当前编辑的那份用表单值，其余保持原样） */
  const collectProviders = (): AIProviderConfig[] => {
    if (!settings) return providers;
    return providers.map((item) =>
      item.id === selectedProviderId
        ? {
            ...item,
            provider: settings.provider,
            baseUrl: settings.baseUrl,
            model: settings.model,
            apiKey: settings.apiKey,
            requestOptions: requestOptionsResult.ok
              ? requestOptionsResult.value
              : item.requestOptions,
          }
        : item,
    );
  };

  const handleProbeModels = async () => {
    if (!settings) return;
    setIsProbing(true);
    setModelChoices(null);
    try {
      const result = await listAIModels({
        provider: settings.provider,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
      });
      setModelChoices(result.models);
    } catch (err) {
      setTestResult({
        success: false,
        error: err instanceof Error ? err.message : t("ai_settings.probe_failed"),
      });
    } finally {
      setIsProbing(false);
    }
  };

  const buildSettingsPayload = (
    activeIdOverride?: string,
  ): AISettingsType | null => {
    if (!settings || !requestOptionsResult.ok) return null;

    const list = collectProviders();
    const activeId = activeIdOverride ?? activeProviderId;
    const active =
      list.find((item) => item.id === activeId) ?? list[0] ?? null;

    return {
      ...settings,
      // 后端把平铺字段当作「当前使用」的那份配置
      provider: active ? active.provider : settings.provider,
      apiKey: active ? active.apiKey : settings.apiKey,
      baseUrl: active ? active.baseUrl : settings.baseUrl,
      model: active ? active.model : settings.model,
      requestOptions: active
        ? (active.requestOptions ?? {})
        : requestOptionsResult.value,
      providers: list,
      activeProviderId: activeId,
    };
  };

  const handleTest = async () => {
    const payload = buildSettingsPayload();
    if (!payload) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await testAIConnection({
        provider: payload.provider,
        apiKey: payload.apiKey,
        baseUrl: payload.baseUrl,
        model: payload.model,
        requestOptions: payload.requestOptions,
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

  const handleSave = async () => {
    const payload = buildSettingsPayload();
    if (!payload) return;
    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const saved = await updateAISettings(payload);
      setSettings(saved);
      setRequestOptionsText(formatRequestOptions(saved.requestOptions));
      setBaseline(
        JSON.stringify([saved, formatRequestOptions(saved.requestOptions)]),
      );
      if (saved.providers && saved.providers.length > 0) {
        setProviders(saved.providers);
        const active =
          saved.activeProviderId || saved.providers[0]?.id || "default";
        setActiveProviderId(active);
        if (!saved.providers.some((item) => item.id === selectedProviderId)) {
          setSelectedProviderId(active);
        }
      }
      setSuccessMessage(t("ai_settings.settings_saved"));
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t("ai_settings.failed_to_save"));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const aiDirty =
    baseline !== null &&
    settings !== null &&
    JSON.stringify([settings, requestOptionsText]) !== baseline;
  useSettingsDirty("ai", aiDirty, t("settings.dirty_label_ai"), handleSave);

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
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
    "h-9 w-full sm:w-48 rounded-md border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none";
  // 顶部那句「当前使用：××（模型）」用
  const activeProvider =
    providers.find((item) => item.id === activeProviderId) ?? providers[0] ?? null;

  const canSubmit = Boolean(
    settings.apiKey &&
    settings.model &&
    (!isBaseURLRequired || hasBaseURL) &&
    !requestOptionsError,
  );

  return (
    <div className="space-y-1">
      {/* 已保存的提供商 */}
      <div className="space-y-2 pb-2 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">
            {t("ai_settings.providers")}
          </span>
          {/* 平铺字段（真正发给模型的那份）由「当前使用」决定，所以这里明确写出来 */}
          {activeProvider && (
            <span className="text-xs text-muted-foreground">
              {t("ai_settings.current_provider", {
                name: activeProvider.name || activeProvider.provider,
                model: activeProvider.model || "-",
              })}
            </span>
          )}
          <div className="flex items-center gap-2">
            {selectedProviderId !== activeProviderId && (
              <button
                type="button"
                onClick={() => handleSetActiveProvider(selectedProviderId)}
                className="rounded-[var(--radius)] border border-border px-2.5 py-1 text-xs text-foreground transition-colors duration-200 hover:bg-item-hover"
              >
                {t("ai_settings.set_active")}
              </button>
            )}
            <button
              type="button"
              onClick={handleAddProvider}
              className="rounded-[var(--radius)] border border-border px-2.5 py-1 text-xs text-foreground transition-colors duration-200 hover:bg-item-hover"
            >
              + {t("ai_settings.add_provider")}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {providers.map((item) => {
            const isSelected = item.id === selectedProviderId;
            const isActive = item.id === activeProviderId;
            return (
              <span
                key={item.id}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors duration-200",
                  isSelected
                    ? "border-primary text-foreground"
                    : "border-border text-muted-foreground hover:bg-item-hover",
                )}
              >
                <button
                  type="button"
                  onClick={() => handleSelectProvider(item.id)}
                  className="max-w-40 truncate"
                  title={item.baseUrl || item.name}
                >
                  {item.name || item.provider}
                </button>
                {isActive && (
                  <span className="text-[10px] text-primary">
                    {t("ai_settings.active_badge")}
                  </span>
                )}
                {providers.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleDeleteProvider(item.id)}
                    title={t("actions.delete")}
                    className="text-muted-foreground transition-colors duration-200 hover:text-destructive"
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* Provider */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="text-sm font-medium">{t("ai_settings.provider")}</span>
        <Select
          ariaLabel={t("ai_settings.provider")}
          value={settings.provider}
          onChange={(value) => handleChange("provider", value as AIProvider)}
          options={PROVIDERS}
          className="shrink-0 sm:w-48"
        />
      </div>

      {/* API Key */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="text-sm font-medium">{t("ai_settings.api_key")}</span>
        <input
          type="password"
          value={settings.apiKey}
          onChange={(e) => handleChange("apiKey", e.target.value)}
          placeholder={
            settings.provider === "openai"
              ? "sk-..."
              : settings.provider === "anthropic"
                ? "sk-ant-..."
                : t("ai_settings.enter_api_key")
          }
          className={cn(inputClass, "shrink-0")}
        />
      </div>

      {/* 名称 */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="text-sm font-medium">
          {t("ai_settings.provider_name")}
        </span>
        <input
          type="text"
          value={providers.find((item) => item.id === selectedProviderId)?.name ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            setProviders((prev) =>
              prev.map((item) =>
                item.id === selectedProviderId ? { ...item, name: value } : item,
              ),
            );
            setSuccessMessage(null);
          }}
          placeholder={t("ai_settings.provider_name_placeholder")}
          className={cn(inputClass, "shrink-0")}
        />
      </div>

      {/* Base URL */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-sm font-medium">
            {t("ai_settings.base_url")}
          </span>
          {isBaseURLRequired ? (
            <span className="text-xs text-destructive">
              {t("ai_settings.required")}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("ai_settings.optional")}
            </span>
          )}
        </div>
        <input
          type="text"
          value={settings.baseUrl}
          onChange={(e) => handleChange("baseUrl", e.target.value)}
          placeholder={
            settings.provider === "compatible"
              ? "https://openrouter.ai/api/v1"
              : settings.provider === "openai"
                ? "https://api.openai.com/v1"
                : t("ai_settings.leave_empty_for_default")
          }
          className={cn(inputClass, "shrink-0")}
        />
        {isLoopbackBaseUrl(settings.baseUrl) && (
          <p className="text-xs text-muted-foreground">
            {t("ai_settings.loopback_hint")}
          </p>
        )}
      </div>

      {/* Model：标签单独一行，「输入框 + 探测模型」并排成一行（输入框吃剩余宽度），
          探测结果紧贴在输入框下面，不再跟标签挤在一行里换行 */}
      <div className="space-y-2 py-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium">{t("ai_settings.model")}</span>
          <span className="text-xs text-muted-foreground">
            {t("ai_settings.model_hint")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={settings.model}
            onChange={(e) => handleChange("model", e.target.value)}
            placeholder={
              settings.provider === "openai"
                ? "gpt-4o"
                : settings.provider === "anthropic"
                  ? "claude-sonnet-4-20250514"
                  : t("ai_settings.model_example", {
                      example: "anthropic/claude-3.5-sonnet",
                    })
            }
            className={cn(inputClass, "min-w-0 flex-1 sm:w-auto")}
          />
          <button
            type="button"
            onClick={handleProbeModels}
            disabled={isProbing || !settings.baseUrl.trim()}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius)] border border-border px-3 text-xs text-foreground transition-colors duration-200 hover:bg-item-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isProbing && (
              <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
            )}
            {isProbing ? t("ai_settings.probing") : t("ai_settings.probe_models")}
          </button>
        </div>
        {modelChoices && modelChoices.length > 0 && (
          <div className="max-h-40 overflow-y-auto rounded-md border border-border p-1">
            {modelChoices.map((model) => (
              <button
                key={model}
                type="button"
                onClick={() => {
                  handleChange("model", model);
                  setModelChoices(null);
                }}
                className={cn(
                  "block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors duration-200 hover:bg-item-hover",
                  model === settings.model
                    ? "text-primary"
                    : "text-muted-foreground",
                )}
              >
                {model}
              </button>
            ))}
          </div>
        )}
      </div>


      <div className="space-y-2 py-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {t("ai_settings.request_options")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("ai_settings.request_options_hint")}
          </p>
        </div>
        <textarea
          value={requestOptionsText}
          onChange={(e) => {
            setRequestOptionsText(e.target.value);
            setSuccessMessage(null);
            setTestResult(null);
          }}
          placeholder={JSON.stringify({ key: "value" }, null, 2)}
          className={cn(
            "min-h-32 w-full rounded-field border bg-background px-3 py-2 font-mono text-xs focus:border-primary focus:outline-none",
            requestOptionsError ? "border-destructive" : "border-border",
          )}
          spellCheck={false}
        />
        {requestOptionsError && (
          <p className="text-xs text-destructive">{requestOptionsError}</p>
        )}
      </div>

      {/* AI Behavior Section */}
      <div className="pb-1 pt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        AI
      </div>

      {/* Summary Language */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {t("ai_settings.summary_language")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("ai_settings.summary_language_hint")}
          </p>
        </div>
        <Select
          ariaLabel={t("ai_settings.summary_language")}
          value={settings.summaryLanguage}
          onChange={(value) => handleChange("summaryLanguage", value)}
          options={SUMMARY_LANGUAGE_OPTIONS}
          className="w-40 shrink-0"
        />
      </div>

      {/* 翻译通道：不想配模型也能用（免 key） */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {t("ai_settings.translate_channel")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("ai_settings.translate_channel_hint")}
          </p>
        </div>
        <Select
          ariaLabel={t("ai_settings.translate_channel")}
          value={settings.translateChannel ?? ""}
          onChange={(value) => handleChange("translateChannel", value)}
          options={[
            { value: "", label: t("ai_settings.translate_channel_model") },
            { value: "google", label: t("ai_settings.translate_channel_google") },
            { value: "youdao", label: t("ai_settings.translate_channel_youdao") },
          ]}
          className="w-52 shrink-0"
        />
      </div>

      {/* 免费通道失败是否自动切回模型（只在选了免费通道时有意义） */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {t("ai_settings.fallback_to_model")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("ai_settings.fallback_to_model_hint")}
          </p>
        </div>
        <Switch
          className="shrink-0"
          checked={settings.fallbackToModel !== false}
          onCheckedChange={(checked) => handleChange("fallbackToModel", checked)}
        />
      </div>

      {/* Auto Translate */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {t("ai_settings.auto_translate")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("ai_settings.auto_translate_hint")}
          </p>
        </div>
        <Switch
          checked={settings.autoTranslate}
          onCheckedChange={(checked) => handleChange("autoTranslate", checked)}
          className="shrink-0"
        />
      </div>

      {/* Auto Summary */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {t("ai_settings.auto_summary")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("ai_settings.auto_summary_hint")}
          </p>
        </div>
        <Switch
          checked={settings.autoSummary}
          onCheckedChange={(checked) => handleChange("autoSummary", checked)}
          className="shrink-0"
        />
      </div>

      {/* Rate Limit */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {t("ai_settings.rate_limit_label")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("ai_settings.rate_limit_hint")}
          </p>
        </div>
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
      </div>

      {/* Test & Save Buttons */}
      <div className="flex flex-wrap items-center gap-3 pt-4">
        <button
          type="button"
          onClick={handleTest}
          disabled={isTesting || !canSubmit}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius)] px-4 text-sm font-medium transition-colors",
            "bg-secondary hover:bg-secondary/80",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {isTesting ? (
            <>
              <div className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span>{t("ai_settings.testing")}</span>
            </>
          ) : (
            <>
              <svg
                className="size-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
              <span>{t("ai_settings.test")}</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || !canSubmit}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius)] px-4 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {isSaving ? (
            <>
              <div className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span>{t("ai_settings.saving")}</span>
            </>
          ) : (
            <span>{t("ai_settings.save")}</span>
          )}
        </button>

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

      {/* Messages */}
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="rounded-md bg-green-500/10 dark:bg-green-500/20 px-3 py-2 text-sm text-green-600 dark:text-green-400">
          {successMessage}
        </div>
      )}

      {/* MCP 服务：连接管理 + 「新建 MCP 订阅」向导入口（同一份连接两种用途） */}
      <MCPServersSection />
    </div>
  );
}
