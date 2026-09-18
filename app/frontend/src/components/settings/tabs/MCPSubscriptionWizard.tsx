import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Chip, Tabs } from "@heroui/react";
import { RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ApiError,
  createMCPFeed,
  inspectMCPServer,
  listMCPServerTools,
} from "@/api";
import { useFolders } from "@/hooks/useFolders";
import {
  buildInspectRequest,
  buildMCPFeedConfig,
  defaultMCPFeedTitle,
  emptyMappingDraft,
  feedSelectableServers,
  isMCPPreviewReady,
  MAPPING_FIELD_ORDER,
  mappingDraftFromMapping,
  mappingFromDraft,
  mcpErrorMessage,
  mcpInspectSignature,
  mcpKeyLevelLabelKey,
  mcpTierLabelKey,
  type MCPMappingDraft,
} from "@/lib/mcp";
import type {
  MCPEntryMapping,
  MCPInspectResult,
  MCPKind,
  MCPServer,
  MCPToolsResponse,
} from "@/types/mcp";
import { showToast } from "@/stores/toast-store";

const inputClass = cn(
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground",
  "placeholder:text-muted-foreground/60",
  "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
);

/** 映射字段 → i18n 键（顺序即表单顺序，和 lib 的 MAPPING_FIELD_ORDER 对齐） */
const MAPPING_FIELD_KEYS: Record<keyof MCPEntryMapping, string> = {
  listPath: "ai_settings.mcp_mapping_list_path",
  title: "ai_settings.mcp_mapping_title",
  url: "ai_settings.mcp_mapping_url",
  content: "ai_settings.mcp_mapping_content",
  publishedAt: "ai_settings.mcp_mapping_published",
  author: "ai_settings.mcp_mapping_author",
  id: "ai_settings.mcp_mapping_id",
  thumbnail: "ai_settings.mcp_mapping_thumbnail",
};

const STEP_COUNT = 5;

interface MCPSubscriptionWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已加载的连接列表（由 AI 栏的 MCP 服务段传进来） */
  servers: MCPServer[];
  /** 建好订阅后的回调（外壳去让订阅列表失效） */
  onCreated?: () => void | Promise<void>;
  /** 从某条连接直接开向导（可选，跳过第一步） */
  presetServerId?: string;
}

/**
 * 「新建 MCP 订阅」向导（方案 §4.5 / 效果图第三步）。
 *
 * 五步：选连接 → 选工具或资源 → 映射（自动预填，可改）→ **强制预览前 5 条** → 填标题与文件夹建源。
 *
 * 硬要求：**没成功预览过就不给创建**。判据不是「点过预览按钮」，而是
 * `isMCPPreviewReady`：预览结果非空、无 error，且那次预览的「参数指纹」和现在这份一致 ——
 * 所以预览之后又改了映射（或参数）必须重新预览，改了映射直接创建这条路是走不通的。
 */
export function MCPSubscriptionWizard({
  open,
  onOpenChange,
  servers,
  onCreated,
  presetServerId,
}: MCPSubscriptionWizardProps) {
  const { t } = useTranslation();
  const { data: folders = [] } = useFolders();

  const [step, setStep] = useState(0);
  const [serverId, setServerId] = useState("");
  const [kind, setKind] = useState<MCPKind>("tool");
  const [toolName, setToolName] = useState("");
  const [resourceUri, setResourceUri] = useState("");
  const [argsText, setArgsText] = useState("");
  const [limit, setLimit] = useState(5);
  const [mappingDraft, setMappingDraft] =
    useState<MCPMappingDraft>(emptyMappingDraft);

  const [tools, setTools] = useState<MCPToolsResponse | null>(null);
  const [isLoadingTools, setIsLoadingTools] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);

  const [isInspecting, setIsInspecting] = useState(false);
  /** 自动推断的映射结果（tier / notes / keyLevel） */
  const [suggestion, setSuggestion] = useState<MCPInspectResult | null>(null);
  /** 真正预览过的结果 + 那次预览的指纹 */
  const [preview, setPreview] = useState<MCPInspectResult | null>(null);
  const [previewSignature, setPreviewSignature] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [folderId, setFolderId] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const selectable = useMemo(() => feedSelectableServers(servers), [servers]);
  const selectedServer = useMemo(
    () => selectable.find((server) => server.id === serverId) ?? null,
    [selectable, serverId],
  );

  /** 打开时重置（可选带 presetServerId 直接落在第一步已选好） */
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setServerId(presetServerId ?? "");
    setKind("tool");
    setToolName("");
    setResourceUri("");
    setArgsText("");
    setLimit(5);
    setMappingDraft(emptyMappingDraft());
    setTools(null);
    setToolsError(null);
    setSuggestion(null);
    setPreview(null);
    setPreviewSignature(null);
    setPreviewError(null);
    setTitle("");
    setTitleTouched(false);
    setFolderId("");
    setCreateError(null);
  }, [open, presetServerId]);

  /** 选了连接就拉工具/资源清单 */
  useEffect(() => {
    if (!open || !serverId) return;
    let cancelled = false;
    setIsLoadingTools(true);
    setToolsError(null);
    setTools(null);
    void (async () => {
      try {
        const data = await listMCPServerTools(serverId);
        if (cancelled) return;
        setTools(data);
        // 默认选上第一个，用户点「下一步」就能看到映射（选错随时改）
        setToolName(data.tools[0]?.name ?? "");
        setResourceUri(data.resources[0]?.uri ?? "");
      } catch (err) {
        if (cancelled) return;
        // 只存原文（空串 = 没原文，渲染时退回「拉工具清单失败」）：别把 t 放进依赖
        setToolsError(mcpErrorMessage(err));
      } finally {
        if (!cancelled) setIsLoadingTools(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, serverId]);

  /** 参数 JSON（工具参数）—— 非法 JSON 时不允许预览/创建 */
  const parsedArgs = useMemo(():
    | { ok: true; value: Record<string, unknown> | undefined }
    | { ok: false } => {
    const trimmed = argsText.trim();
    if (!trimmed) return { ok: true, value: undefined };
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch {
      return { ok: false };
    }
  }, [argsText]);

  const mapping = useMemo(
    () => mappingFromDraft(mappingDraft),
    [mappingDraft],
  );

  /** 现在这份参数对应的 inspect 请求（干跑 / 预览共用同一个拼装函数） */
  const currentRequest = useMemo(
    () =>
      buildInspectRequest({
        kind,
        toolName: kind === "tool" ? toolName : undefined,
        resourceUri: kind === "resource" ? resourceUri : undefined,
        arguments: kind === "tool" && parsedArgs.ok ? parsedArgs.value : undefined,
        limit: kind === "tool" ? limit : undefined,
        mapping,
      }),
    [kind, toolName, resourceUri, parsedArgs, limit, mapping],
  );
  const currentSignature = useMemo(
    () => mcpInspectSignature(currentRequest),
    [currentRequest],
  );

  const targetName = kind === "tool" ? toolName : resourceUri;
  const canPreview =
    Boolean(selectedServer) &&
    Boolean(targetName) &&
    parsedArgs.ok &&
    !isInspecting;

  const previewReady = isMCPPreviewReady({
    result: preview,
    previewSignature,
    currentSignature,
  });

  const defaultTitle = selectedServer
    ? defaultMCPFeedTitle(selectedServer.name, kind, targetName)
    : "";

  /** 进第二步时自动预填映射（只跑一次，用户点「重新推断」可以再跑） */
  const runSuggestion = useCallback(async () => {
    if (!selectedServer || !targetName) return;
    setIsInspecting(true);
    setPreviewError(null);
    try {
      const result = await inspectMCPServer(
        selectedServer.id,
        buildInspectRequest({
          kind,
          toolName: kind === "tool" ? toolName : undefined,
          resourceUri: kind === "resource" ? resourceUri : undefined,
          arguments: kind === "tool" && parsedArgs.ok ? parsedArgs.value : undefined,
          limit: kind === "tool" ? limit : undefined,
        }),
      );
      setSuggestion(result);
      setMappingDraft(mappingDraftFromMapping(result.mapping));
      if (result.error) setPreviewError(result.error);
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : t("ai_settings.mcp_inspect_failed"),
      );
    } finally {
      setIsInspecting(false);
    }
  }, [selectedServer, targetName, kind, toolName, resourceUri, parsedArgs, limit, t]);

  useEffect(() => {
    if (!open) return;
    if (step !== 2) return;
    if (suggestion || isInspecting) return;
    void runSuggestion();
  }, [open, step, suggestion, isInspecting, runSuggestion]);

  const handlePreview = useCallback(async () => {
    if (!selectedServer) return;
    setIsInspecting(true);
    setPreviewError(null);
    const signature = mcpInspectSignature(currentRequest);
    try {
      const result = await inspectMCPServer(selectedServer.id, currentRequest);
      setPreview(result);
      setPreviewSignature(signature);
      setSuggestion((prev) => prev ?? result);
      if (result.error) setPreviewError(result.error);
    } catch (err) {
      setPreview(null);
      setPreviewSignature(null);
      setPreviewError(
        err instanceof Error ? err.message : t("ai_settings.mcp_inspect_failed"),
      );
    } finally {
      setIsInspecting(false);
    }
  }, [selectedServer, currentRequest, t]);

  const handleCreate = useCallback(async () => {
    if (!selectedServer || !previewReady) return;
    const feedTitle = (titleTouched ? title : defaultTitle).trim();
    if (!feedTitle) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      await createMCPFeed({
        title: feedTitle,
        folderId: folderId || undefined,
        mcpConfig: buildMCPFeedConfig({
          serverId: selectedServer.id,
          kind,
          toolName: kind === "tool" ? toolName : undefined,
          resourceUri: kind === "resource" ? resourceUri : undefined,
          arguments: kind === "tool" && parsedArgs.ok ? parsedArgs.value : undefined,
          limit: kind === "tool" ? limit : undefined,
          mapping,
          tier: preview?.tier,
          keyLevel: preview?.keyLevel,
        }),
      });
      await onCreated?.();
      showToast(t("ai_settings.mcp_feed_created", { title: feedTitle }));
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.message === "feed_exists") {
        setCreateError(t("ai_settings.mcp_feed_exists"));
      } else {
        setCreateError(
          err instanceof Error ? err.message : t("ai_settings.mcp_create_failed"),
        );
      }
    } finally {
      setIsCreating(false);
    }
  }, [
    selectedServer,
    previewReady,
    title,
    titleTouched,
    defaultTitle,
    folderId,
    kind,
    toolName,
    resourceUri,
    parsedArgs,
    limit,
    mapping,
    preview,
    onCreated,
    onOpenChange,
    t,
  ]);

  const stepTitles = [
    t("ai_settings.mcp_step_server"),
    t("ai_settings.mcp_step_object"),
    t("ai_settings.mcp_step_mapping"),
    t("ai_settings.mcp_step_preview"),
    t("ai_settings.mcp_step_finish"),
  ];

  const canGoNext =
    (step === 0 && Boolean(serverId)) ||
    (step === 1 && Boolean(targetName) && parsedArgs.ok) ||
    (step === 2 && Boolean(targetName)) ||
    (step === 3 && previewReady) ||
    step === 4;

  const canCreate = previewReady && Boolean(
    (titleTouched ? title : defaultTitle).trim(),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="p-4">
          <DialogTitle>{t("ai_settings.mcp_new_subscription")}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[72vh] space-y-4 overflow-y-auto px-4 pb-4">
          {/* 步骤条：序号 + 当前步文案（组件库没有 stepper，这里只做序号指示） */}
          <ol className="flex flex-wrap items-center gap-2">
            {stepTitles.map((label, index) => (
              <li key={label} className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-xs tabular-nums",
                    index === step
                      ? "bg-primary text-primary-foreground"
                      : index < step
                        ? "bg-secondary text-foreground"
                        : "bg-secondary/60 text-muted-foreground",
                  )}
                >
                  {index + 1}
                </span>
                <span
                  className={cn(
                    "text-xs",
                    index === step ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
                {index < stepTitles.length - 1 && (
                  <span className="text-xs text-muted-foreground">→</span>
                )}
              </li>
            ))}
          </ol>

          {/* ① 选连接 */}
          {step === 0 && (
            <div className="space-y-2">
              <span className="text-sm font-medium">
                {t("ai_settings.mcp_step_server")}
              </span>
              {selectable.length === 0 ? (
                <p className="rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                  {t("ai_settings.mcp_no_servers_for_feed")}
                </p>
              ) : (
                <Select
                  ariaLabel={t("ai_settings.mcp_step_server")}
                  value={serverId}
                  onChange={setServerId}
                  placeholder={t("ai_settings.mcp_choose_server")}
                  options={selectable.map((server) => ({
                    value: server.id,
                    label: server.name,
                    hint: server.url,
                  }))}
                />
              )}
              <p className="text-xs text-muted-foreground">
                {t("ai_settings.mcp_step_server_hint")}
              </p>
            </div>
          )}

          {/* ② 选工具或资源 */}
          {step === 1 && (
            <div className="space-y-3">
              <Tabs.Root
                selectedKey={kind}
                onSelectionChange={(key) => setKind(String(key) as MCPKind)}
              >
                <Tabs.List>
                  <Tabs.Tab id="tool">
                    {t("ai_settings.mcp_kind_tool")}
                  </Tabs.Tab>
                  <Tabs.Tab id="resource">
                    {t("ai_settings.mcp_kind_resource")}
                  </Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel id="tool" className="space-y-3 pt-3">
                  {isLoadingTools && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <RefreshCw className="size-3.5 animate-spin" />
                      {t("ai_settings.mcp_loading")}
                    </div>
                  )}

                  {toolsError !== null && (
                    <div className="break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {toolsError || t("ai_settings.mcp_tools_failed")}
                    </div>
                  )}

                  {tools && (
                    <>
                      <Select
                        ariaLabel={t("ai_settings.mcp_tool")}
                        value={toolName}
                        onChange={setToolName}
                        placeholder={t("ai_settings.mcp_choose_tool")}
                        options={tools.tools.map((tool) => ({
                          value: tool.name,
                          label: tool.title || tool.name,
                          hint: tool.title ? tool.name : undefined,
                        }))}
                      />
                      {tools.tools.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          {t("ai_settings.mcp_no_tools")}
                        </p>
                      )}
                      <div className="space-y-1.5">
                        <label
                          htmlFor="mcp-args"
                          className="text-xs text-muted-foreground"
                        >
                          {t("ai_settings.mcp_arguments")}
                        </label>
                        <textarea
                          id="mcp-args"
                          value={argsText}
                          onChange={(e) => setArgsText(e.target.value)}
                          rows={3}
                          placeholder={'{"query": "关键词"}'}
                          className={cn(
                            "min-h-20 w-full resize-y rounded-md border bg-background px-2.5 py-2 font-mono text-xs text-foreground",
                            parsedArgs.ok ? "border-border" : "border-destructive",
                            "focus:outline-none focus:ring-2 focus:ring-primary/20",
                          )}
                          spellCheck={false}
                        />
                        {!parsedArgs.ok && (
                          <p className="text-xs text-destructive">
                            {t("ai_settings.mcp_arguments_invalid")}
                          </p>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        <label
                          htmlFor="mcp-limit"
                          className="text-xs text-muted-foreground"
                        >
                          {t("ai_settings.mcp_limit")}
                        </label>
                        <input
                          id="mcp-limit"
                          type="number"
                          min={1}
                          max={50}
                          value={limit}
                          onChange={(e) => setLimit(Number(e.target.value))}
                          className={cn(inputClass, "w-24")}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("ai_settings.mcp_limit_hint")}
                        </p>
                      </div>
                    </>
                  )}
                </Tabs.Panel>

                <Tabs.Panel id="resource" className="space-y-2 pt-3">
                  {isLoadingTools && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <RefreshCw className="size-3.5 animate-spin" />
                      {t("ai_settings.mcp_loading")}
                    </div>
                  )}

                  {toolsError !== null && (
                    <div className="break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {toolsError || t("ai_settings.mcp_tools_failed")}
                    </div>
                  )}

                  {tools && (
                    <>
                      <Select
                        ariaLabel={t("ai_settings.mcp_resource")}
                        value={resourceUri}
                        onChange={setResourceUri}
                        placeholder={t("ai_settings.mcp_choose_resource")}
                        options={tools.resources.map((resource) => ({
                          value: resource.uri,
                          label: resource.name || resource.uri,
                          hint: resource.mimeType,
                        }))}
                      />
                      {tools.resources.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          {t("ai_settings.mcp_no_resources")}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {t("ai_settings.mcp_resource_hint")}
                      </p>
                    </>
                  )}
                </Tabs.Panel>
              </Tabs.Root>
            </div>
          )}

          {/* ③ 映射（自动预填，可改） */}
          {step === 2 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {t("ai_settings.mcp_step_mapping")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={isInspecting || !targetName}
                  onPress={() => void runSuggestion()}
                >
                  <RefreshCw className="size-3.5" />
                  {t("ai_settings.mcp_reinfer_mapping")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("ai_settings.mcp_mapping_hint")}
              </p>

              {suggestion && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Chip size="sm" variant="tertiary" className="border border-border">
                    {t(mcpTierLabelKey(suggestion.tier))}
                  </Chip>
                  <Chip size="sm" variant="tertiary" className="border border-border">
                    {t("ai_settings.mcp_key_level", {
                      level: t(mcpKeyLevelLabelKey(suggestion.keyLevel)),
                    })}
                  </Chip>
                </div>
              )}

              {suggestion && suggestion.notes.length > 0 && (
                <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                  {suggestion.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}

              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                {MAPPING_FIELD_ORDER.map((field) => (
                  <div key={field} className="space-y-1.5">
                    <label
                      htmlFor={`mcp-mapping-${field}`}
                      className="text-xs text-muted-foreground"
                    >
                      {t(MAPPING_FIELD_KEYS[field])}
                    </label>
                    <input
                      id={`mcp-mapping-${field}`}
                      type="text"
                      value={mappingDraft[field]}
                      onChange={(e) =>
                        setMappingDraft((prev) => ({
                          ...prev,
                          [field]: e.target.value,
                        }))
                      }
                      placeholder={
                        field === "listPath" ? "data.items" : "title"
                      }
                      className={cn(inputClass, "font-mono text-xs")}
                    />
                  </div>
                ))}
              </div>

              <p className="text-xs text-muted-foreground">
                {t("ai_settings.mcp_mapping_key_hint")}
              </p>
            </div>
          )}

          {/* ④ 强制预览前 5 条 */}
          {step === 3 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {t("ai_settings.mcp_step_preview")}
                </span>
                <Button
                  size="sm"
                  isDisabled={!canPreview}
                  onPress={() => void handlePreview()}
                >
                  {isInspecting ? (
                    <>
                      <RefreshCw className="size-3.5 animate-spin" />
                      {t("ai_settings.mcp_previewing")}
                    </>
                  ) : (
                    t("ai_settings.mcp_preview")
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("ai_settings.mcp_preview_hint")}
              </p>

              {previewError && (
                <div className="break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {previewError}
                </div>
              )}

              {!previewReady && (
                <p className="rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                  {t("ai_settings.mcp_preview_required")}
                </p>
              )}

              {preview && preview.preview.length > 0 && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Chip size="sm" variant="tertiary" className="border border-border">
                      {t("ai_settings.mcp_preview_total", {
                        count: preview.total,
                      })}
                    </Chip>
                    <Chip size="sm" variant="tertiary" className="border border-border">
                      {t("ai_settings.mcp_key_level", {
                        level: t(mcpKeyLevelLabelKey(preview.keyLevel)),
                      })}
                    </Chip>
                    {preview.truncated && (
                      <span>{t("ai_settings.mcp_preview_truncated")}</span>
                    )}
                  </div>
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {preview.preview.slice(0, 5).map((item, index) => (
                      <div key={`${item.key}-${index}`} className="space-y-0.5 px-3 py-2">
                        <div className="truncate text-sm text-foreground">
                          {item.title || t("ai_settings.mcp_preview_untitled")}
                        </div>
                        {item.url && (
                          <div
                            className="truncate font-mono text-xs text-muted-foreground"
                            title={item.url}
                          >
                            {item.url}
                          </div>
                        )}
                        <div
                          className="truncate font-mono text-xs text-muted-foreground"
                          title={item.key}
                        >
                          {t("ai_settings.mcp_preview_key", {
                            key: item.key,
                            level: t(mcpKeyLevelLabelKey(item.keyLevel)),
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ⑤ 标题 + 文件夹 → 创建 */}
          {step === 4 && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="mcp-feed-title" className="text-sm font-medium">
                  {t("ai_settings.mcp_feed_title")}
                </label>
                <input
                  id="mcp-feed-title"
                  type="text"
                  value={titleTouched ? title : defaultTitle}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleTouched(true);
                  }}
                  className={inputClass}
                />
              </div>
              <div className="space-y-1.5">
                <span className="text-sm font-medium">
                  {t("ai_settings.mcp_feed_folder")}
                </span>
                <Select
                  ariaLabel={t("ai_settings.mcp_feed_folder")}
                  value={folderId}
                  onChange={setFolderId}
                  placeholder={t("ai_settings.mcp_no_folder")}
                  options={[
                    { value: "", label: t("ai_settings.mcp_no_folder") },
                    ...folders.map((folder) => ({
                      value: folder.id,
                      label: folder.name,
                    })),
                  ]}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("ai_settings.mcp_feed_hint")}
              </p>

              {!previewReady && (
                <p className="rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                  {t("ai_settings.mcp_preview_required")}
                </p>
              )}

              {createError && (
                <div className="break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {createError}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-4">
          <Button
            size="sm"
            variant="ghost"
            isDisabled={step === 0}
            onPress={() => setStep((prev) => Math.max(0, prev - 1))}
          >
            {t("ai_settings.mcp_prev")}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onPress={() => onOpenChange(false)}
            >
              {t("actions.cancel")}
            </Button>
            {step < STEP_COUNT - 1 && (
              <Button
                size="sm"
                isDisabled={!canGoNext}
                onPress={() => setStep((prev) => Math.min(STEP_COUNT - 1, prev + 1))}
              >
                {t("ai_settings.mcp_next")}
              </Button>
            )}
            {step === STEP_COUNT - 1 && (
              <Button
                size="sm"
                isDisabled={!canCreate || isCreating}
                onPress={() => void handleCreate()}
              >
                {isCreating ? t("settings.saving") : t("ai_settings.mcp_create")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
