import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AlertDialog, Button, Chip, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HeroSwitch } from "@/components/ui/hero-switch";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ApiError,
  createMCPServer,
  deleteMCPServer,
  listMCPServers,
  testMCPServer,
  updateMCPServer,
} from "@/api";
import {
  applyPresetToDraft,
  buildMCPServerPayload,
  emptyMCPServerDraft,
  MCP_DEFAULT_CONCURRENCY,
  MCP_DEFAULT_REFRESH_INTERVAL_MINUTES,
  MCP_DEFAULT_TIMEOUT_SECONDS,
  MCP_MASK,
  MCP_MIN_REFRESH_INTERVAL_MINUTES,
  MCP_SERVER_PRESETS,
  mcpDraftFromServer,
  mcpErrorMessage,
  validateMCPServerDraft,
  type MCPHeaderDraft,
  type MCPServerDraft,
  type MCPServerPreset,
} from "@/lib/mcp";
import type { MCPPurpose, MCPServer, MCPTestResult } from "@/types/mcp";
import { showToast } from "@/stores/toast-store";
import { MCPSubscriptionWizard } from "./MCPSubscriptionWizard";

const inputClass = cn(
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground",
  "placeholder:text-muted-foreground/60",
  "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
);

const labelClass = "text-sm font-medium text-foreground";

/**
 * AI 设置栏的「MCP 服务」段（用户方案 §4.5 / 效果图 mcp-as-feed.html）。
 *
 * 三件事在这里：连接列表（名称 / 传输 / 连接状态 / 用途 / 行内操作）、
 * 预设卡片（点一下把名称与地址填进新建表单）、新建/编辑弹窗。
 * 建源向导是另一个组件（`MCPSubscriptionWizard`），由这里的「+ 新建 MCP 订阅」开。
 */
export function MCPServersSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [servers, setServers] = useState<MCPServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 弹窗状态：editing 为 null = 新建 */
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MCPServer | null>(null);
  const [presetDraft, setPresetDraft] = useState<MCPServerDraft | null>(null);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, MCPTestResult>>(
    {},
  );

  const [pendingDelete, setPendingDelete] = useState<MCPServer | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [wizardOpen, setWizardOpen] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      setServers(await listMCPServers());
    } catch (err) {
      // 只存原文；空串表示没有可显示的原文，渲染时退回「加载失败」
      setLoadError(mcpErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 挂载时拉一次连接列表（load 与 t/语言无关，所以不进依赖）
  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = useCallback(
    (preset?: MCPServerPreset) => {
      const base = emptyMCPServerDraft();
      setEditing(null);
      setPresetDraft(
        preset
          ? applyPresetToDraft(base, preset, t(preset.nameKey))
          : base,
      );
      setFormOpen(true);
    },
    [t],
  );

  const openEdit = useCallback((server: MCPServer) => {
    setEditing(server);
    setPresetDraft(null);
    setFormOpen(true);
  }, []);

  const handleSaved = useCallback(
    async (server: MCPServer, created: boolean) => {
      setFormOpen(false);
      setEditing(null);
      setPresetDraft(null);
      await load();
      showToast(
        t(
          created
            ? "ai_settings.mcp_created_toast"
            : "ai_settings.mcp_updated_toast",
          { name: server.name },
        ),
      );
    },
    [load, t],
  );

  const handleTest = useCallback(
    async (server: MCPServer) => {
      setTestingId(server.id);
      try {
        const result = await testMCPServer(server.id);
        setTestResults((prev) => ({ ...prev, [server.id]: result }));
        // 连接状态/工具数会变，顺手刷一遍列表
        await load();
      } catch (err) {
        setTestResults((prev) => ({
          ...prev,
          [server.id]: {
            connected: false,
            toolCount: 0,
            resourceCount: 0,
            error: mcpErrorMessage(err),
          },
        }));
      } finally {
        setTestingId(null);
      }
    },
    [load],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deleteMCPServer(pendingDelete.id);
      setPendingDelete(null);
      await load();
    } catch (err) {
      // 后端 409 会带一句「还有 N 条订阅在用这个连接」——原样显示，不许吞
      setDeleteError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : t("ai_settings.mcp_delete_failed"),
      );
    } finally {
      setIsDeleting(false);
    }
  }, [pendingDelete, load, t]);

  const handleFeedCreated = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["feeds"] });
    await queryClient.invalidateQueries({ queryKey: ["entries"] });
    await queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
  }, [queryClient]);

  return (
    <section className="space-y-3 border-t border-border pt-4">
      {/* 段头：说明 + 两个入口 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">
            {t("ai_settings.mcp_servers")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("ai_settings.mcp_servers_hint")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onPress={() => openCreate()}
          >
            <Plus className="size-4" />
            {t("ai_settings.mcp_add_connection")}
          </Button>
          <Button size="sm" onPress={() => setWizardOpen(true)}>
            <Plus className="size-4" />
            {t("ai_settings.mcp_new_subscription")}
          </Button>
        </div>
      </div>

      {/* 预设卡片：点一下把名称与地址填进新建表单 */}
      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">
          {t("ai_settings.mcp_presets")}
        </span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {MCP_SERVER_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              variant="outline"
              size="sm"
              className="h-auto w-full flex-col items-start gap-0.5 px-2.5 py-2 text-left"
              aria-label={t(preset.nameKey)}
              onPress={() => openCreate(preset)}
            >
              <span className="w-full truncate text-xs font-medium">
                {t(preset.nameKey)}
              </span>
              <span
                className="w-full truncate font-mono text-[10px] text-muted-foreground"
                title={preset.url}
              >
                {preset.url}
              </span>
            </Button>
          ))}
        </div>
      </div>

      {/* 连接列表 */}
      {isLoading && (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <RefreshCw className="size-3.5 animate-spin" />
          {t("ai_settings.mcp_loading")}
        </div>
      )}

      {loadError !== null && (
        <div className="break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {loadError || t("ai_settings.mcp_load_failed")}
        </div>
      )}

      {!isLoading && loadError === null && servers.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("ai_settings.mcp_empty")}
        </div>
      )}

      {servers.length > 0 && (
        <div className="divide-y divide-border rounded-lg border border-border">
          {servers.map((server) => {
            const result = testResults[server.id];
            return (
              <div
                key={server.id}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm text-foreground">
                      {server.name}
                    </span>
                    <Chip size="sm" variant="tertiary" className="border border-border">
                      {server.transport}
                    </Chip>
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          server.isConnected
                            ? "bg-emerald-500"
                            : "bg-muted-foreground/50",
                        )}
                      />
                      {server.isConnected
                        ? t("ai_settings.mcp_connected_tools", {
                            count: server.toolCount,
                          })
                        : t("ai_settings.mcp_disconnected")}
                    </span>
                    {!server.enabled && (
                      <Chip size="sm" variant="tertiary" className="border border-border">
                        {t("ai_settings.mcp_disabled")}
                      </Chip>
                    )}
                  </div>
                  <div
                    className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
                    title={server.url}
                  >
                    {server.url}
                  </div>
                  {!server.isConnected && server.lastError && (
                    <div className="mt-0.5 break-all text-xs text-destructive">
                      {server.lastError}
                    </div>
                  )}
                  {result && (
                    <div
                      className={cn(
                        "mt-0.5 break-all text-xs",
                        result.connected
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-destructive",
                      )}
                    >
                      {result.connected
                        ? t("ai_settings.mcp_test_ok", {
                            count: result.toolCount,
                            resources: result.resourceCount,
                          })
                        : result.error || t("ai_settings.mcp_test_failed")}
                    </div>
                  )}
                </div>

                {/* 用途标记：同一份连接两种用途可以并存 */}
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {server.purposes.map((purpose) => (
                    <Chip
                      key={purpose}
                      size="sm"
                      variant="tertiary"
                      color={purpose === "feed" ? "accent" : "default"}
                      className="border border-border"
                    >
                      {t(
                        purpose === "feed"
                          ? "ai_settings.mcp_purpose_feed"
                          : "ai_settings.mcp_purpose_ai",
                      )}
                    </Chip>
                  ))}
                </div>

                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={testingId === server.id}
                    aria-label={t("ai_settings.mcp_test")}
                    onPress={() => void handleTest(server)}
                  >
                    <RefreshCw
                      className={cn(
                        "size-3.5",
                        testingId === server.id && "animate-spin",
                      )}
                    />
                    {t("ai_settings.mcp_test")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label={t("ai_settings.mcp_edit")}
                    onPress={() => openEdit(server)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label={t("ai_settings.mcp_delete")}
                    onPress={() => {
                      setDeleteError(null);
                      setPendingDelete(server);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <MCPServerFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) {
            setEditing(null);
            setPresetDraft(null);
          }
        }}
        server={editing}
        initialDraft={presetDraft}
        onSaved={handleSaved}
      />

      <MCPSubscriptionWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        servers={servers}
        onCreated={handleFeedCreated}
      />

      {/* 删除确认（照 DataControl 那处 AlertDialog 用法） */}
      <AlertDialog>
        <Button className="hidden" aria-hidden />
        <AlertDialog.Backdrop
          isOpen={pendingDelete !== null}
          onOpenChange={(open) => {
            if (!open) {
              setPendingDelete(null);
              setDeleteError(null);
            }
          }}
        >
          <AlertDialog.Container>
            <AlertDialog.Dialog className="max-w-lg">
              <AlertDialog.Header>
                <AlertDialog.Heading>
                  {t("ai_settings.mcp_delete_confirm_title")}
                </AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <div className="text-sm text-muted-foreground">
                  {t("ai_settings.mcp_delete_confirm_body", {
                    name: pendingDelete?.name ?? "",
                  })}
                </div>
                {deleteError && (
                  <div className="mt-2 break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {deleteError}
                  </div>
                )}
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    setPendingDelete(null);
                    setDeleteError(null);
                  }}
                >
                  {t("actions.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  isDisabled={isDeleting}
                  onPress={() => void handleConfirmDelete()}
                >
                  {t("actions.delete")}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </section>
  );
}

interface MCPServerFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新建 */
  server: MCPServer | null;
  /** 预设卡片预填的草稿（新建时用） */
  initialDraft: MCPServerDraft | null;
  onSaved: (server: MCPServer, created: boolean) => void;
}

function MCPServerFormDialog({
  open,
  onOpenChange,
  server,
  initialDraft,
  onSaved,
}: MCPServerFormDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MCPServerDraft>(emptyMCPServerDraft);
  const [showErrors, setShowErrors] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 打开时重置表单：编辑回填连接，新建用预设草稿（或空草稿）
  useEffect(() => {
    if (!open) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setDraft(
      server
        ? mcpDraftFromServer(server)
        : (initialDraft ?? emptyMCPServerDraft()),
    );
    setShowErrors(false);
    setSaveError(null);
  }, [open, server, initialDraft]);

  const errors = useMemo(() => validateMCPServerDraft(draft), [draft]);

  const transportOptions = useMemo(
    () => [
      { value: "streamable-http", label: "streamable-http" },
      {
        value: "sse",
        label: "sse",
        hint: t("ai_settings.mcp_transport_sse_unsupported"),
        disabled: true,
      },
    ],
    [t],
  );

  const authOptions = useMemo(
    () => [
      { value: "none", label: t("ai_settings.mcp_auth_none") },
      { value: "header", label: t("ai_settings.mcp_auth_header") },
    ],
    [t],
  );

  const fetchOptions = useMemo(
    () => [
      { value: "global", label: t("ai_settings.mcp_fetch_global") },
      { value: "custom", label: t("ai_settings.mcp_fetch_custom") },
    ],
    [t],
  );

  const patch = (changes: Partial<MCPServerDraft>) => {
    setDraft((prev) => ({ ...prev, ...changes }));
    setSaveError(null);
  };

  const patchHeader = (index: number, changes: Partial<MCPHeaderDraft>) => {
    setDraft((prev) => ({
      ...prev,
      headers: prev.headers.map((header, i) =>
        i === index ? { ...header, ...changes } : header,
      ),
    }));
    setSaveError(null);
  };

  const handleSave = async () => {
    if (errors.length > 0) {
      setShowErrors(true);
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      const payload = buildMCPServerPayload(draft);
      const saved = server
        ? await updateMCPServer(server.id, payload)
        : await createMCPServer(payload);
      onSaved(saved, !server);
    } catch (err) {
      // 后端的原话（409/400 都带具体原因）直接显示，不留「保存失败」这种空话
      setSaveError(
        err instanceof Error ? err.message : t("ai_settings.mcp_save_failed"),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0">
        <DialogHeader className="p-4">
          <DialogTitle>
            {server
              ? t("ai_settings.mcp_edit_connection")
              : t("ai_settings.mcp_create_connection")}
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 pb-4">
          {/* 名称 */}
          <div className="space-y-1.5">
            <label htmlFor="mcp-name" className={labelClass}>
              {t("ai_settings.mcp_name")}
            </label>
            <input
              id="mcp-name"
              type="text"
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder={t("ai_settings.mcp_name_placeholder")}
              className={inputClass}
              autoFocus
            />
          </div>

          {/* 传输 */}
          <div className="space-y-1.5">
            <span className={labelClass}>{t("ai_settings.mcp_transport")}</span>
            <Select
              ariaLabel={t("ai_settings.mcp_transport")}
              value={draft.transport}
              onChange={(value) =>
                patch({ transport: value as MCPServerDraft["transport"] })
              }
              options={transportOptions}
            />
            <p className="text-xs text-muted-foreground">
              {t("ai_settings.mcp_transport_hint")}
            </p>
          </div>

          {/* URL */}
          <div className="space-y-1.5">
            <label htmlFor="mcp-url" className={labelClass}>
              {t("ai_settings.mcp_url")}
            </label>
            <input
              id="mcp-url"
              type="text"
              value={draft.url}
              onChange={(e) => patch({ url: e.target.value })}
              placeholder="https://example.com/mcp"
              className={cn(inputClass, "font-mono text-xs")}
            />
          </div>

          {/* 认证 */}
          <div className="space-y-1.5">
            <span className={labelClass}>{t("ai_settings.mcp_auth")}</span>
            <Select
              ariaLabel={t("ai_settings.mcp_auth")}
              value={draft.authType}
              onChange={(value) =>
                patch({ authType: value as MCPServerDraft["authType"] })
              }
              options={authOptions}
            />
          </div>

          {draft.authType === "header" && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">
                  {t("ai_settings.mcp_headers")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onPress={() =>
                    patch({ headers: [...draft.headers, { key: "", value: "" }] })
                  }
                >
                  <Plus className="size-3.5" />
                  {t("ai_settings.mcp_add_header")}
                </Button>
              </div>
              {draft.headers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("ai_settings.mcp_headers_empty")}
                </p>
              )}
              {draft.headers.map((header, index) => (
                <div
                  key={`header-${index}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input
                    type="text"
                    value={header.key}
                    onChange={(e) => patchHeader(index, { key: e.target.value })}
                    placeholder={t("ai_settings.mcp_header_key")}
                    aria-label={t("ai_settings.mcp_header_key")}
                    className={cn(inputClass, "min-w-[8rem] flex-1")}
                  />
                  <input
                    type="text"
                    value={header.value}
                    onChange={(e) =>
                      patchHeader(index, { value: e.target.value })
                    }
                    placeholder={t("ai_settings.mcp_header_value")}
                    aria-label={t("ai_settings.mcp_header_value")}
                    className={cn(inputClass, "min-w-[8rem] flex-1 font-mono text-xs")}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-label={t("actions.delete")}
                    onPress={() =>
                      patch({
                        headers: draft.headers.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                {t("ai_settings.mcp_header_mask_hint", { mask: MCP_MASK })}
              </p>
            </div>
          )}

          {/* 启用 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={labelClass}>{t("ai_settings.mcp_enabled")}</span>
            <HeroSwitch
              aria-label={t("ai_settings.mcp_enabled")}
              isSelected={draft.enabled}
              onChange={(checked: boolean) => patch({ enabled: checked })}
            />
          </div>

          {/* 用途：同一份连接，两种用途可以并存 */}
          <div className="space-y-1.5">
            <span className={labelClass}>{t("ai_settings.mcp_purposes")}</span>
            <ToggleButtonGroup
              selectionMode="multiple"
              size="sm"
              selectedKeys={draft.purposes}
              onSelectionChange={(keys) =>
                patch({ purposes: [...keys].map(String) as MCPPurpose[] })
              }
            >
              <ToggleButton id="ai">
                {t("ai_settings.mcp_purpose_ai")}
              </ToggleButton>
              <ToggleButton id="feed">
                {t("ai_settings.mcp_purpose_feed")}
              </ToggleButton>
            </ToggleButtonGroup>
            <p className="text-xs text-muted-foreground">
              {t("ai_settings.mcp_purposes_hint")}
            </p>
          </div>

          {/* 取数时机 */}
          <div className="space-y-1.5">
            <span className={labelClass}>{t("ai_settings.mcp_fetch_timing")}</span>
            <Select
              ariaLabel={t("ai_settings.mcp_fetch_timing")}
              value={draft.useGlobalFetch ? "global" : "custom"}
              onChange={(value) =>
                patch({ useGlobalFetch: value !== "custom" })
              }
              options={fetchOptions}
            />
            <p className="text-xs text-muted-foreground">
              {t("ai_settings.mcp_fetch_hint")}
            </p>
          </div>

          {!draft.useGlobalFetch && (
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-border p-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <label htmlFor="mcp-timeout" className="text-xs text-muted-foreground">
                  {t("ai_settings.mcp_timeout_seconds")}
                </label>
                <input
                  id="mcp-timeout"
                  type="number"
                  min={1}
                  max={300}
                  value={draft.fetchTimeoutSeconds}
                  onChange={(e) =>
                    patch({ fetchTimeoutSeconds: Number(e.target.value) })
                  }
                  className={inputClass}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="mcp-concurrency" className="text-xs text-muted-foreground">
                  {t("ai_settings.mcp_concurrency")}
                </label>
                <input
                  id="mcp-concurrency"
                  type="number"
                  min={1}
                  max={64}
                  value={draft.fetchConcurrency}
                  onChange={(e) =>
                    patch({ fetchConcurrency: Number(e.target.value) })
                  }
                  className={inputClass}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="mcp-interval" className="text-xs text-muted-foreground">
                  {t("ai_settings.mcp_refresh_interval")}
                </label>
                <input
                  id="mcp-interval"
                  type="number"
                  min={MCP_MIN_REFRESH_INTERVAL_MINUTES}
                  value={draft.refreshIntervalMinutes}
                  onChange={(e) =>
                    patch({ refreshIntervalMinutes: Number(e.target.value) })
                  }
                  className={inputClass}
                />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-3">
                {t("ai_settings.mcp_refresh_interval_hint", {
                  min: MCP_MIN_REFRESH_INTERVAL_MINUTES,
                  timeout: MCP_DEFAULT_TIMEOUT_SECONDS,
                  concurrency: MCP_DEFAULT_CONCURRENCY,
                  interval: MCP_DEFAULT_REFRESH_INTERVAL_MINUTES,
                })}
              </p>
            </div>
          )}

          {showErrors && errors.length > 0 && (
            <ul className="space-y-0.5 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {errors.map((code) => (
                <li key={code}>
                  {t(`ai_settings.mcp_err_${code}`, {
                    min: MCP_MIN_REFRESH_INTERVAL_MINUTES,
                  })}
                </li>
              ))}
            </ul>
          )}

          {saveError && (
            <div className="break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {saveError}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border p-4">
          <Button size="sm" variant="ghost" onPress={() => onOpenChange(false)}>
            {t("actions.cancel")}
          </Button>
          <Button size="sm" isDisabled={isSaving} onPress={() => void handleSave()}>
            {isSaving ? t("settings.saving") : t("actions.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
