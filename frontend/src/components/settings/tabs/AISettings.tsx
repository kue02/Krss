import { useEffect, useMemo, useRef, useState } from "react";
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

/** 自动保存的防抖间隔（50 批 1：行为区整块自动保存，拍板 ~800ms） */
const AUTO_SAVE_DELAY_MS = 800;

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
  /** 50 批 1：行为区自动保存的状态（行内反馈） */
  const [autoSaveState, setAutoSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  /** 行为区自己的基线：与它的快照一致就不触发自动保存 */
  const behaviorBaselineRef = useRef<string | null>(null);
  /** 提供商表单有没有未保存改动（自动保存读到的是 ref，避免闭包过期） */
  const providerDirtyRef = useRef(false);
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
      setBaseline(
        providerFormSnapshotOf(
          data,
          formatRequestOptions(data.requestOptions),
          list,
        ),
      );
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
    if (id === selectedProviderId) return;
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

  // 50 批 1：「未保存改动」只看提供商表单 —— 行为区自己自动保存，不再算进离开确认
  const providerFormSnapshot = settings
    ? providerFormSnapshotOf(settings, requestOptionsText, providers)
    : null;
  const providerDirty = baseline !== null && providerFormSnapshot !== baseline;
  const aiDirty = providerDirty;
  useSettingsDirty("ai", aiDirty, t("settings.dirty_label_ai"), handleSave);

  useEffect(() => {
    providerDirtyRef.current = providerDirty;
  }, [providerDirty]);

  // ---------- 50 批 1：行为区自动保存（防抖 ~800ms，行内反馈；JSON 非法时不保存） ----------
  const behaviorSnapshot = settings ? behaviorSnapshotOf(settings) : null;
  useEffect(() => {
    if (!settings || !behaviorSnapshot) return;
    const baselineSnapshot = behaviorBaselineRef.current;
    if (
      baselineSnapshot === null ||
      behaviorSnapshot === baselineSnapshot ||
      !requestOptionsResult.ok ||
      providerDirtyRef.current // 提供商表单有半成品：别把它一起带上去
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
  }, [behaviorSnapshot, requestOptionsResult.ok]);

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
  /**
   * 47-3（用户 2026-10-12）：**保存**不能跟着「模型配齐没」一起禁掉。
   *
   * 这一页除了提供商，还有「翻译通道 / 摘要语言 / 自动翻译」这些不依赖模型的设置；
   * 选了免 key 的免费翻译通道（google / youdao）时本来就不需要 key 与模型，
   * 原来保存按钮与测试共用 `canSubmit`，表现就是「选了免费翻译也存不上」。
   * 「测试」要真去打模型，仍然必须配齐（并给出提示，见按钮上的 title）。
   */
  const canSave = !isSaving && !requestOptionsError;
  const canTest = !isTesting && canSubmit;

  /** 分场景模型的下拉选项：跟随 + 已保存的提供商里配了模型的那些（免费通道走「翻译通道」行，不在这里重复） */
  const sceneOptions = [
    { value: "", label: t("ai_settings.scene_follow") },
    ...providers
      .filter((item) => item.model)
      .map((item) => ({
        value: `provider:${item.id}`,
        label: `${item.name || item.provider} · ${item.model}`,
      })),
  ];

  return (
    <div className="space-y-1">
      {/* 已保存的提供商（50 批 1.1：紧凑卡列表，点卡片展开编辑，保存/测试跟在编辑卡底部） */}
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
          <button
            type="button"
            onClick={handleAddProvider}
            className="rounded-[var(--radius)] border border-border px-2.5 py-1 text-xs text-foreground transition-colors duration-200 hover:bg-item-hover"
          >
            + {t("ai_settings.add_provider")}
          </button>
        </div>

        <div className="space-y-1.5">
          {providers.map((item) => {
            const isSelected = item.id === selectedProviderId;
            const isActive = item.id === activeProviderId;
            return (
              <div
                key={item.id}
                className={cn(
                  "rounded-md border transition-colors duration-200",
                  isSelected ? "border-primary" : "border-border",
                )}
              >
                {/* 卡片行：点开编辑（再点已选中的那张不收起，避免误触折叠） */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => handleSelectProvider(item.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={item.baseUrl || item.name}
                  >
                    <svg
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                        isSelected && "rotate-90",
                      )}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                    <span className="max-w-44 truncate text-sm font-medium">
                      {item.name || item.provider}
                    </span>
                    <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                      {item.provider}
                    </span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {item.model || "-"}
                    </span>
                  </button>
                  {isActive && (
                    <span className="shrink-0 text-[10px] text-primary">
                      {t("ai_settings.active_badge")}
                    </span>
                  )}
                  {providers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleDeleteProvider(item.id)}
                      title={t("actions.delete")}
                      className="shrink-0 text-muted-foreground transition-colors duration-200 hover:text-destructive"
                    >
                      ×
                    </button>
                  )}
                </div>

                {/* 展开的编辑表单（同一时刻只有一张卡展开；这些字段只属于这份提供商配置） */}
                {isSelected && (
                  <div className="space-y-2 border-t border-border px-3 pb-3 pt-2">
                    {/* Provider */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        {t("ai_settings.provider")}
                      </span>
                      <Select
                        ariaLabel={t("ai_settings.provider")}
                        value={settings.provider}
                        onChange={(value) =>
                          handleChange("provider", value as AIProvider)
                        }
                        options={PROVIDERS}
                        className="shrink-0 sm:w-48"
                      />
                    </div>

                    {/* API Key */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        {t("ai_settings.api_key")}
                      </span>
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
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        {t("ai_settings.provider_name")}
                      </span>
                      <input
                        type="text"
                        value={
                          providers.find((p) => p.id === selectedProviderId)
                            ?.name ?? ""
                        }
                        onChange={(event) => {
                          const value = event.target.value;
                          setProviders((prev) =>
                            prev.map((p) =>
                              p.id === selectedProviderId
                                ? { ...p, name: value }
                                : p,
                            ),
                          );
                          setSuccessMessage(null);
                        }}
                        placeholder={t("ai_settings.provider_name_placeholder")}
                        className={cn(inputClass, "shrink-0")}
                      />
                    </div>

                    {/* Base URL */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
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
                    </div>
                    {isLoopbackBaseUrl(settings.baseUrl) && (
                      <p className="text-xs text-muted-foreground">
                        {t("ai_settings.loopback_hint")}
                      </p>
                    )}

                    {/* 模型：输入框 + 探测并排；探测结果贴在下面（47 批的重排原样保留） */}
                    <div className="space-y-2">
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
                          {isProbing
                            ? t("ai_settings.probing")
                            : t("ai_settings.probe_models")}
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

                    {/* 请求参数（属于这份提供商配置，随保存一起提交） */}
                    <div className="space-y-2">
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
                          "min-h-24 w-full rounded-field border bg-background px-3 py-2 font-mono text-xs focus:border-primary focus:outline-none",
                          requestOptionsError
                            ? "border-destructive"
                            : "border-border",
                        )}
                        spellCheck={false}
                      />
                      {requestOptionsError && (
                        <p className="text-xs text-destructive">
                          {requestOptionsError}
                        </p>
                      )}
                    </div>

                    {/* 保存 / 测试 / 设为当前使用 —— 只作用于提供商这一块（50 批 1：手动整体提交） */}
                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={!canSave}
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

                      <button
                        type="button"
                        onClick={handleTest}
                        disabled={!canTest}
                        title={canTest ? undefined : t("ai_settings.test_needs_model")}
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

                      {selectedProviderId !== activeProviderId && (
                        <button
                          type="button"
                          onClick={() => handleSetActiveProvider(selectedProviderId)}
                          className="h-8 rounded-[var(--radius)] border border-border px-2.5 text-xs text-foreground transition-colors duration-200 hover:bg-item-hover"
                        >
                          {t("ai_settings.set_active")}
                        </button>
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
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* AI 行为（50 批 1：这一块自动保存，不用找保存按钮） */}
      <div className="pb-1 pt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>AI</span>
          <span
            className={cn(
              "font-normal normal-case tracking-normal",
              autoSaveState === "error" && "text-destructive",
              autoSaveState === "saved" && "text-green-600 dark:text-green-400",
            )}
          >
            {autoSaveState === "saving" && t("ai_settings.autosave_saving")}
            {autoSaveState === "saved" && t("ai_settings.autosave_saved")}
            {autoSaveState === "error" && t("ai_settings.autosave_failed")}
          </span>
        </div>
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



      {/* 分场景模型（50 批 1.2）：翻译 / 摘要 / 自动化各自可用不同的提供商配置，默认跟随当前使用 */}
      <div className="pb-1 pt-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium">
            {t("ai_settings.scene_section")}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("ai_settings.scene_hint")}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="text-sm font-medium">
          {t("ai_settings.scene_translate")}
        </span>
        <Select
          ariaLabel={t("ai_settings.scene_translate")}
          value={settings.sceneTranslate ?? ""}
          onChange={(value) => handleChange("sceneTranslate", value)}
          options={sceneOptions}
          className="w-56 shrink-0"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="text-sm font-medium">
          {t("ai_settings.scene_summary")}
        </span>
        <Select
          ariaLabel={t("ai_settings.scene_summary")}
          value={settings.sceneSummary ?? ""}
          onChange={(value) => handleChange("sceneSummary", value)}
          options={sceneOptions}
          className="w-56 shrink-0"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span className="text-sm font-medium">
          {t("ai_settings.scene_automation")}
        </span>
        <Select
          ariaLabel={t("ai_settings.scene_automation")}
          value={settings.sceneAutomation ?? ""}
          onChange={(value) => handleChange("sceneAutomation", value)}
          options={sceneOptions}
          className="w-56 shrink-0"
        />
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

/** 提供商表单的快照（50 批 1：dirty 只管这块 —— 行为区自己自动保存） */
function providerFormSnapshotOf(
  settings: AISettingsType,
  requestOptionsText: string,
  providers: AIProviderConfig[],
): string {
  return JSON.stringify([
    settings.provider,
    settings.apiKey,
    settings.baseUrl,
    settings.model,
    requestOptionsText,
    providers.map((item) => [
      item.id,
      item.name,
      item.provider,
      item.baseUrl,
      item.model,
      item.apiKey,
      formatRequestOptions(item.requestOptions),
    ]),
  ]);
}

/** 行为区的快照（自动保存的比较对象；只含行为字段，提供商表单改动不触发它） */
function behaviorSnapshotOf(settings: AISettingsType): string {
  return JSON.stringify([
    settings.summaryLanguage,
    settings.translateChannel,
    settings.fallbackToModel,
    settings.autoTranslate,
    settings.autoSummary,
    settings.rateLimit,
    settings.sceneTranslate ?? "",
    settings.sceneSummary ?? "",
    settings.sceneAutomation ?? "",
  ]);
}
