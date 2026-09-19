import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Chip, Tabs, ToggleButton, ToggleButtonGroup } from "@heroui/react";
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
  suggestMCPMapping,
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
  MCP_DEFAULT_MAX_ITEMS,
  MCP_DEFAULT_MAX_PAGES,
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
  MCPSuggestResult,
  MCPToolsResponse,
} from "@/types/mcp";
import { showToast } from "@/stores/toast-store";
import { MCPFailureBlock } from "./MCPFailureBlock";
import { MCPJsonEditor } from "./MCPJsonEditor";

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

interface MCPSubscriptionWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已加载的连接列表（由 AI 栏的 MCP 服务段传进来） */
  servers: MCPServer[];
  /** 建好订阅后的回调（外壳去让订阅列表失效） */
  onCreated?: () => void | Promise<void>;
  /** 从某条连接直接开向导（可选，跳过第一步） */
  presetServerId?: string;
  /** 向导第 1 步「+ 新建连接」：回外壳开连接对话框（向导先关） */
  onNeedConnection?: () => void;
}

/**
 * 「新建 MCP 订阅」向导（16-6 改 3 屏：连接+取什么 / 映射+预览 / 刷新+归类）。
 *
 * 第 2 屏内嵌「预览前 5 条」门禁：没成功预览过就不给创建。
 * 判据不是「点过预览按钮」，而是 `isMCPPreviewReady`：预览结果非空、无 error，
 * 且那次预览的「参数指纹」和现在这份一致 —— 所以预览之后又改了映射（或参数）
 * 必须重新预览，改了映射直接创建这条路是走不通的。
 */
export function MCPSubscriptionWizard({
  open,
  onOpenChange,
  servers,
  onCreated,
  presetServerId,
  onNeedConnection,
}: MCPSubscriptionWizardProps) {
  const { t } = useTranslation();
  const { data: folders = [] } = useFolders();

  const [screen, setScreen] = useState(0);
  const [serverId, setServerId] = useState("");
  const [kind, setKind] = useState<MCPKind>("tool");
  const [toolName, setToolName] = useState("");
  const [resourceUri, setResourceUri] = useState("");
  const [argsText, setArgsText] = useState("");
  const [limit, setLimit] = useState(5);
  // 分页（16-8）：默认只取一页；追历史给双上限
  const [pageMode, setPageMode] = useState<"single" | "history">("single");
  const [maxPages, setMaxPages] = useState(MCP_DEFAULT_MAX_PAGES);
  const [maxItems, setMaxItems] = useState(MCP_DEFAULT_MAX_ITEMS);
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
  /** 「拉更多」看的下一页（不碰主预览的门禁指纹） */
  const [morePages, setMorePages] = useState<MCPInspectResult[]>([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  /** AI 猜映射（第 4 档）：建议只展示，点「用这个映射」才填入，填入后仍须预览 */
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [aiSuggestion, setAiSuggestion] = useState<MCPSuggestResult | null>(
    null,
  );

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

  /** 打开时重置（可选带 presetServerId 直接落在第一屏已选好） */
  useEffect(() => {
    if (!open) return;
    setScreen(0);
    setServerId(presetServerId ?? "");
    setKind("tool");
    setToolName("");
    setResourceUri("");
    setArgsText("");
    setLimit(5);
    setPageMode("single");
    setMaxPages(MCP_DEFAULT_MAX_PAGES);
    setMaxItems(MCP_DEFAULT_MAX_ITEMS);
    setMappingDraft(emptyMappingDraft());
    setTools(null);
    setToolsError(null);
    setSuggestion(null);
    setPreview(null);
    setPreviewSignature(null);
    setPreviewError(null);
    setMorePages([]);
    setIsSuggesting(false);
    setSuggestError(null);
    setAiSuggestion(null);
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
        // 默认选上第一个（选错随时改）
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
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return { ok: false };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch {
      return { ok: false };
    }
  }, [argsText]);

  const mapping = useMemo(() => mappingFromDraft(mappingDraft), [mappingDraft]);

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

  /** 进第 2 屏时自动预填映射（只跑一次，用户点「重新推断」可以再跑） */
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
          arguments:
            kind === "tool" && parsedArgs.ok ? parsedArgs.value : undefined,
          limit: kind === "tool" ? limit : undefined,
        }),
      );
      setSuggestion(result);
      setMappingDraft(mappingDraftFromMapping(result.mapping));
      if (result.error) setPreviewError(result.error);
    } catch (err) {
      setPreviewError(
        err instanceof Error
          ? err.message
          : t("ai_settings.mcp_inspect_failed"),
      );
    } finally {
      setIsInspecting(false);
    }
  }, [selectedServer, targetName, kind, toolName, resourceUri, parsedArgs, limit, t]);

  useEffect(() => {
    if (!open) return;
    if (screen !== 1) return;
    if (suggestion || isInspecting) return;
    void runSuggestion();
  }, [open, screen, suggestion, isInspecting, runSuggestion]);

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
      setMorePages([]);
      if (result.error) setPreviewError(result.error);
    } catch (err) {
      setPreview(null);
      setPreviewSignature(null);
      setPreviewError(
        err instanceof Error
          ? err.message
          : t("ai_settings.mcp_inspect_failed"),
      );
    } finally {
      setIsInspecting(false);
    }
  }, [selectedServer, currentRequest, t]);

  /** 拉更多：用回传的游标看下一页（只追加展示，不碰主预览门禁） */
  const handleLoadMore = useCallback(async () => {
    if (!selectedServer || !preview?.nextCursor || !preview?.cursorParam) return;
    setIsLoadingMore(true);
    try {
      const base =
        parsedArgs.ok && parsedArgs.value ? { ...parsedArgs.value } : {};
      base[preview.cursorParam] = preview.nextCursor;
      const result = await inspectMCPServer(
        selectedServer.id,
        buildInspectRequest({
          kind,
          toolName: kind === "tool" ? toolName : undefined,
          resourceUri: kind === "resource" ? resourceUri : undefined,
          arguments: base,
          limit: kind === "tool" ? limit : undefined,
          mapping,
        }),
      );
      setMorePages((prev) => [...prev, result]);
    } catch (err) {
      setPreviewError(
        err instanceof Error
          ? err.message
          : t("ai_settings.mcp_inspect_failed"),
      );
    } finally {
      setIsLoadingMore(false);
    }
  }, [selectedServer, preview, parsedArgs, kind, toolName, resourceUri, limit, mapping, t]);

  /** AI 猜映射（第 4 档）：一次调用，只展示，点「用这个映射」才填入 */
  const handleSuggest = useCallback(async () => {
    if (!selectedServer) return;
    setIsSuggesting(true);
    setSuggestError(null);
    try {
      const result = await suggestMCPMapping(selectedServer.id, {
        kind,
        toolName: kind === "tool" ? toolName : undefined,
        resourceUri: kind === "resource" ? resourceUri : undefined,
        arguments:
          kind === "tool" && parsedArgs.ok ? parsedArgs.value : undefined,
        limit: kind === "tool" ? limit : undefined,
      });
      setAiSuggestion(result);
    } catch (err) {
      setSuggestError(
        err instanceof Error ? err.message : t("ai_settings.mcp_ai_failed"),
      );
    } finally {
      setIsSuggesting(false);
    }
  }, [selectedServer, kind, toolName, resourceUri, parsedArgs, limit, t]);

  /** 用 AI 的映射：填入表单（仍须预览确认后才生效，门禁指纹会变） */
  const applyAiSuggestion = useCallback(() => {
    if (!aiSuggestion) return;
    setMappingDraft(mappingDraftFromMapping(aiSuggestion.mapping));
    setAiSuggestion(null);
  }, [aiSuggestion]);

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
          arguments:
            kind === "tool" && parsedArgs.ok ? parsedArgs.value : undefined,
          limit: kind === "tool" ? limit : undefined,
          mapping,
          tier: preview?.tier,
          keyLevel: preview?.keyLevel,
          pagination:
            kind === "tool" && pageMode === "history"
              ? {
                  mode: "history",
                  maxPages,
                  maxItems,
                }
              : undefined,
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
          err instanceof Error
            ? err.message
            : t("ai_settings.mcp_create_failed"),
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
    pageMode,
    maxPages,
    maxItems,
    onCreated,
    onOpenChange,
    t,
  ]);

  const screenTitles = [
    t("ai_settings.mcp_screen_1"),
    t("ai_settings.mcp_screen_2"),
    t("ai_settings.mcp_screen_3"),
  ];

  const canGoNext =
    (screen === 0 &&
      Boolean(serverId) &&
      Boolean(targetName) &&
      parsedArgs.ok) ||
    (screen === 1 && previewReady);

  const canCreate = previewReady && Boolean(
    (titleTouched ? title : defaultTitle).trim(),
  );

  const isTextTier = (suggestion?.tier ?? preview?.tier) === "text";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="p-4">
          <DialogTitle>{t("ai_settings.mcp_new_subscription")}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[72vh] space-y-4 overflow-y-auto px-4 pb-4">
          {/* 步骤条：3 屏 */}
          <ol className="flex flex-wrap items-center gap-2">
            {screenTitles.map((label, index) => (
              <li key={label} className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-xs tabular-nums",
                    index === screen
                      ? "bg-primary text-primary-foreground"
                      : index < screen
                        ? "bg-secondary text-foreground"
                        : "bg-secondary/60 text-muted-foreground",
                  )}
                >
                  {index + 1}
                </span>
                <span
                  className={cn(
                    "text-xs",
                    index === screen
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
                {index < screenTitles.length - 1 && (
                  <span className="text-xs text-muted-foreground">→</span>
                )}
              </li>
            ))}
          </ol>

          {/* 第 1 屏 · 连接 + 取什么（工具/资源 + 参数 + 分页） */}
          {screen === 0 && (
            <div className="space-y-3">
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
                    onChange={(value) => {
                      if (value === "__new__") {
                        onNeedConnection?.();
                        return;
                      }
                      setServerId(value);
                    }}
                    placeholder={t("ai_settings.mcp_choose_server")}
                    options={[
                      ...selectable.map((server) => ({
                        value: server.id,
                        label: server.name,
                        hint: server.url,
                      })),
                      {
                        value: "__new__",
                        label: t("ai_settings.mcp_wizard_new_connection"),
                      },
                    ]}
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  {t("ai_settings.mcp_step_server_hint")}
                </p>
              </div>

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
                <p className="pt-1 text-[11px] text-muted-foreground">
                  {t("ai_settings.mcp_prompts_note")}
                </p>

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
                        <span className="text-xs text-muted-foreground">
                          {t("ai_settings.mcp_arguments")}
                        </span>
                        <MCPJsonEditor
                          value={argsText}
                          onChange={setArgsText}
                          ariaLabel={t("ai_settings.mcp_arguments")}
                          rows={3}
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
                          max={200}
                          value={limit}
                          onChange={(e) => setLimit(Number(e.target.value))}
                          className={cn(inputClass, "w-24")}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("ai_settings.mcp_limit_hint")}
                        </p>
                      </div>
                      {/* 分页（16-8）：默认一页，可选追历史 + 双上限 */}
                      <div className="space-y-1.5">
                        <span className="text-xs text-muted-foreground">
                          {t("ai_settings.mcp_page_mode")}
                        </span>
                        <ToggleButtonGroup
                          selectionMode="single"
                          size="sm"
                          selectedKeys={new Set([pageMode])}
                          onSelectionChange={(keys) => {
                            const first = [...keys].map(String)[0];
                            if (first === "single" || first === "history") {
                              setPageMode(first);
                            }
                          }}
                        >
                          <ToggleButton id="single">
                            {t("ai_settings.mcp_page_single")}
                          </ToggleButton>
                          <ToggleButton id="history">
                            {t("ai_settings.mcp_page_history")}
                          </ToggleButton>
                        </ToggleButtonGroup>
                        {pageMode === "history" && (
                          <div className="flex flex-wrap items-center gap-3">
                            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              {t("ai_settings.mcp_page_max_pages")}
                              <input
                                type="number"
                                min={1}
                                max={20}
                                value={maxPages}
                                onChange={(e) =>
                                  setMaxPages(Number(e.target.value))
                                }
                                className={cn(inputClass, "h-8 w-20")}
                              />
                            </label>
                            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              {t("ai_settings.mcp_page_max_items")}
                              <input
                                type="number"
                                min={1}
                                max={2000}
                                value={maxItems}
                                onChange={(e) =>
                                  setMaxItems(Number(e.target.value))
                                }
                                className={cn(inputClass, "h-8 w-24")}
                              />
                            </label>
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t("ai_settings.mcp_page_history_hint")}
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

          {/* 第 2 屏 · 映射 + 预览（门禁内嵌） */}
          {screen === 1 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {t("ai_settings.mcp_step_mapping")}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
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
                  <Chip
                    size="sm"
                    variant="tertiary"
                    className="border border-border"
                  >
                    {t(mcpTierLabelKey(suggestion.tier))}
                  </Chip>
                  <Chip
                    size="sm"
                    variant="tertiary"
                    className="border border-border"
                  >
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

              {/* 第 4 档黄条：纯文本 → 手动或 AI 兜底 */}
              {isTextTier && (
                <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                  <p className="text-xs text-muted-foreground">
                    {t("ai_settings.mcp_text_tier_hint")}
                  </p>
                  {!aiSuggestion && (
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={isSuggesting || !canPreview}
                      onPress={() => void handleSuggest()}
                    >
                      {isSuggesting ? (
                        <>
                          <RefreshCw className="size-3.5 animate-spin" />
                          {t("ai_settings.mcp_ai_suggesting")}
                        </>
                      ) : (
                        t("ai_settings.mcp_ai_suggest")
                      )}
                    </Button>
                  )}
                  {suggestError && (
                    <p className="break-all text-xs text-destructive">
                      {suggestError}
                    </p>
                  )}
                  {aiSuggestion && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">
                        {t("ai_settings.mcp_ai_suggested", {
                          model: aiSuggestion.model || "?",
                          tokens: aiSuggestion.estimatedTokens,
                        })}
                      </p>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={applyAiSuggestion}
                      >
                        {t("ai_settings.mcp_ai_apply")}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* 预览前 5 条（门禁，不给跳过） */}
              <div className="space-y-2 border-t border-border pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {t("ai_settings.mcp_preview")}
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

                {previewError && !preview?.failure && (
                  <div className="break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {previewError}
                  </div>
                )}
                {preview?.failure && (
                  <MCPFailureBlock failure={preview.failure} />
                )}

                {!previewReady && (
                  <p className="rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                    {t("ai_settings.mcp_preview_required")}
                  </p>
                )}

                {preview && preview.preview.length > 0 && (
                  <PreviewTable preview={preview} />
                )}

                {/* 拉更多：下一页追加展示 */}
                {morePages.map((page, index) => (
                  <PreviewTable
                    key={`more-${index}`}
                    preview={page}
                    moreIndex={index}
                  />
                ))}
                {preview?.nextCursor && preview.cursorParam && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">
                      {t("ai_settings.mcp_load_more_hint")}
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={isLoadingMore || !canPreview}
                      onPress={() => void handleLoadMore()}
                    >
                      {isLoadingMore ? (
                        <>
                          <RefreshCw className="size-3.5 animate-spin" />
                          {t("ai_settings.mcp_previewing")}
                        </>
                      ) : (
                        t("ai_settings.mcp_load_more")
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 第 3 屏 · 刷新 + 归类 → 创建 */}
          {screen === 2 && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <span className="text-sm font-medium">
                  {t("ai_settings.mcp_fetch_timing")}
                </span>
                {/* 只读展示连接的取数时机（改去连接编辑框，不在这里另起一套） */}
                <p className="rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                  {selectedServer?.useGlobalFetch
                    ? t("ai_settings.mcp_fetch_global")
                    : t("ai_settings.mcp_refresh_interval_hint", {
                        min: 15,
                        timeout:
                          selectedServer?.fetchTimeoutSeconds ?? 15,
                        concurrency:
                          selectedServer?.fetchConcurrency ?? 4,
                        interval:
                          selectedServer?.refreshIntervalMinutes ?? 15,
                      })}
                </p>
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="mcp-feed-title"
                  className="text-sm font-medium"
                >
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
            isDisabled={screen === 0}
            onPress={() => setScreen((prev) => Math.max(0, prev - 1))}
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
            {screen < 2 && (
              <Button
                size="sm"
                isDisabled={!canGoNext}
                onPress={() => setScreen((prev) => Math.min(2, prev + 1))}
              >
                {t("ai_settings.mcp_next")}
              </Button>
            )}
            {screen === 2 && (
              <Button
                size="sm"
                isDisabled={!canCreate || isCreating}
                onPress={() => void handleCreate()}
              >
                {isCreating
                  ? t("settings.saving")
                  : t("ai_settings.mcp_create")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 预览表：标题 / 时间 / 去重键（改了映射或参数必须重新预览，门禁指纹卡） */
function PreviewTable({
  preview,
  moreIndex,
}: {
  preview: MCPInspectResult;
  moreIndex?: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {moreIndex === undefined && (
          <Chip size="sm" variant="tertiary" className="border border-border">
            {t("ai_settings.mcp_preview_total", { count: preview.total })}
          </Chip>
        )}
        {moreIndex !== undefined && (
          <Chip size="sm" variant="tertiary" className="border border-border">
            {t("ai_settings.mcp_load_more")} {moreIndex + 1}
          </Chip>
        )}
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
          <div
            key={`${item.key}-${index}`}
            className="grid grid-cols-[minmax(0,1fr)_150px_170px] gap-2 px-3 py-2"
          >
            <div className="truncate text-sm text-foreground">
              {item.title || t("ai_settings.mcp_preview_untitled")}
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              {item.publishedAt || "—"}
            </div>
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
  );
}
