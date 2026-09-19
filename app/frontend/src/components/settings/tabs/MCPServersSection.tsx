import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Button,
  Chip,
  Dropdown,
  Label,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
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
  discoverMCPOAuth,
  listMCPServers,
  redetectMCPTransport,
  revokeMCPOAuth,
  startMCPOAuth,
  testMCPServer,
  updateMCPServer,
} from "@/api";
import {
  buildMCPServerPayload,
  buildOAuthCallbackURL,
  emptyMCPServerDraft,
  MCP_DEFAULT_CONCURRENCY,
  MCP_DEFAULT_REFRESH_INTERVAL_MINUTES,
  MCP_DEFAULT_TIMEOUT_SECONDS,
  MCP_MASK,
  MCP_MIN_REFRESH_INTERVAL_MINUTES,
  mcpDraftFromServer,
  mcpErrorMessage,
  parseMCPJSON,
  validateMCPServerDraft,
  type MCPFailureExit,
  type MCPHeaderDraft,
  type MCPParsedServer,
  type MCPServerDraft,
} from "@/lib/mcp";
import type {
  MCPFailure,
  MCPOAuthDiscovery,
  MCPPurpose,
  MCPServer,
  MCPTestResult,
} from "@/types/mcp";
import { showToast } from "@/stores/toast-store";
import { MCPSubscriptionWizard } from "./MCPSubscriptionWizard";
import { MCPFailureBlock } from "./MCPFailureBlock";
import { MCPJsonEditor } from "./MCPJsonEditor";
import { MCPJsonView } from "./MCPJsonView";

const inputClass = cn(
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground",
  "placeholder:text-muted-foreground/60",
  "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
);

const labelClass = "text-sm font-medium text-foreground";

/**
 * 列表栅格（表头与行共用同一模板，缺一不可）：
 * 图标 22 · 名称+副行(1fr) · 状态列 132 · 用途列 92 · 操作列 140。
 * 末列不能用 auto —— 表头与每行是独立 grid，auto 会按各自内容算，1fr 就对不齐了。
 */
const MCP_ROW_GRID = "grid-cols-[22px_minmax(0,1fr)_132px_92px_140px]";

/**
 * AI 设置栏的「MCP 服务」段（16-6 按 mcp-v2-detailed.html 硬布局）。
 *
 * 列表行钉死：`图标 22 · 名称+副行(主机·传输·能力计数) · 状态列 132 · 用途列 92 · 操作列` + 列头。
 * 用途是标记不是开关（开关挪进编辑对话框）；预设卡片整段删掉。
 * 新建/编辑对话框默认页是粘贴 JSON → 识别结果卡（可改）→ 手动填写页。
 */
export function MCPServersSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [servers, setServers] = useState<MCPServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 弹窗状态：editing 为 null = 新建 */
  const [formOpen, setFormOpen] = useState(false);
  const [formTab, setFormTab] = useState<"paste" | "manual">("paste");
  const [editing, setEditing] = useState<MCPServer | null>(null);
  const [pasteFill, setPasteFill] = useState<MCPServerDraft | null>(null);

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

  const openCreate = useCallback((tab: "paste" | "manual" = "paste") => {
    setEditing(null);
    setPasteFill(null);
    setFormTab(tab);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((server: MCPServer) => {
    setEditing(server);
    setPasteFill(null);
    setFormTab("manual");
    setFormOpen(true);
  }, []);

  const handleSaved = useCallback(
    async (server: MCPServer, created: boolean) => {
      setFormOpen(false);
      setEditing(null);
      setPasteFill(null);
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

  const runTest = useCallback(
    async (server: MCPServer, redetect = false) => {
      setTestingId(server.id + (redetect ? ":redetect" : ""));
      try {
        const result = redetect
          ? await redetectMCPTransport(server.id)
          : await testMCPServer(server.id);
        setTestResults((prev) => ({ ...prev, [server.id]: result }));
        // 连接状态/工具数/失败结构体会变，顺手刷一遍列表
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

  const handleTest = useCallback(
    (server: MCPServer) => void runTest(server, false),
    [runTest],
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
      {/* 段头：说明 + 入口（按草图：粘贴 JSON 新建 / 新建连接 / + 新建 MCP 订阅） */}
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
            variant="secondary"
            onPress={() => openCreate("paste")}
          >
            {t("ai_settings.mcp_paste_json")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => openCreate("manual")}
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

      {/* 连接列表（预设卡片已删，见 16-6） */}
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
        <div className="overflow-hidden rounded-lg border border-border">
          {/* 列头（与行同栅格，数字按草图钉死） */}
          <div
            className={`grid ${MCP_ROW_GRID} items-center gap-3 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground`}
          >
            <span />
            <span>{t("ai_settings.mcp_col_name")}</span>
            <span>{t("ai_settings.mcp_col_status")}</span>
            <span>{t("ai_settings.mcp_col_purpose")}</span>
            <span className="text-right">
              {t("ai_settings.mcp_col_actions")}
            </span>
          </div>
          <div className="divide-y divide-border/60">
            {servers.map((server) => (
              <MCPServerRow
                key={server.id}
                server={server}
                testResult={testResults[server.id] ?? null}
                testing={
                  testingId === server.id ||
                  testingId === `${server.id}:redetect`
                }
                redetecting={testingId === `${server.id}:redetect`}
                onTest={() => handleTest(server)}
                onAuthorize={() => openEdit(server)}
                onEdit={() => openEdit(server)}
                onRedetect={() => void runTest(server, true)}
                onDelete={() => {
                  setDeleteError(null);
                  setPendingDelete(server);
                }}
                onExit={(exit) => {
                  // 列表行失败块的出口：需要改草稿的动作都进编辑框
                  if (exit === "to_sse" || exit === "redetect") {
                    void runTest(server, true);
                  } else {
                    openEdit(server);
                  }
                }}
              />
            ))}
          </div>
        </div>
      )}

      <MCPServerFormDialog
        open={formOpen}
        tab={formTab}
        onTabChange={setFormTab}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) {
            setEditing(null);
            setPasteFill(null);
          }
        }}
        server={editing}
        pasteFill={pasteFill}
        onSaved={handleSaved}
        onReload={load}
      />

      <MCPSubscriptionWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        servers={servers}
        onCreated={handleFeedCreated}
        onNeedConnection={() => {
          setWizardOpen(false);
          openCreate("manual");
        }}
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

// ---------------------------------------------------------------------------
// 列表行：图标 22 · 名称+副行 · 状态 132 · 用途 92 · 操作
// ---------------------------------------------------------------------------

interface MCPServerRowProps {
  server: MCPServer;
  testResult: MCPTestResult | null;
  testing: boolean;
  redetecting: boolean;
  onTest: () => void;
  onAuthorize: () => void;
  onEdit: () => void;
  onRedetect: () => void;
  onDelete: () => void;
  onExit: (exit: MCPFailureExit) => void;
}

function MCPServerRow({
  server,
  testResult,
  testing,
  redetecting,
  onTest,
  onAuthorize,
  onEdit,
  onRedetect,
  onDelete,
  onExit,
}: MCPServerRowProps) {
  const { t } = useTranslation();

  const host = useMemo(() => {
    try {
      return new URL(server.url).host;
    } catch {
      return server.url;
    }
  }, [server.url]);

  const transportLabel = useMemo(() => {
    if (server.transport === "auto") {
      const base = t("ai_settings.mcp_transport_auto");
      return server.lastTransport ? `${base} · ${server.lastTransport}` : base;
    }
    if (server.transport === "sse") return "SSE";
    return "HTTP";
  }, [server.transport, server.lastTransport, t]);

  const capability = useMemo(() => {
    const parts: string[] = [];
    if (server.authType === "oauth")
      parts.push(t("ai_settings.mcp_sub_oauth"));
    if (server.toolCount > 0 || server.resourceCount > 0) {
      parts.push(
        t("ai_settings.mcp_sub_capability", {
          tools: server.toolCount,
          resources: server.resourceCount,
        }),
      );
    } else {
      parts.push(t("ai_settings.mcp_sub_no_tools"));
    }
    return parts.join(" · ");
  }, [server.authType, server.toolCount, server.resourceCount, t]);

  const status = useMemo(() => {
    if (!server.enabled)
      return {
        dot: "bg-muted-foreground/50",
        text: t("ai_settings.mcp_status_unused"),
        danger: false,
      };
    if (server.authType === "oauth" && !server.oauthAuthorized)
      return {
        dot: "bg-amber-500",
        text: t("ai_settings.mcp_status_auth_needed"),
        danger: false,
      };
    if (server.isConnected)
      return {
        dot: "bg-emerald-500",
        text: t("ai_settings.mcp_status_connected"),
        danger: false,
      };
    if (server.lastError || server.lastFailure)
      return {
        dot: "bg-destructive",
        text: t("ai_settings.mcp_status_failed"),
        danger: true,
      };
    return {
      dot: "bg-muted-foreground/50",
      text: t("ai_settings.mcp_disconnected"),
      danger: false,
    };
  }, [
    server.enabled,
    server.authType,
    server.oauthAuthorized,
    server.isConnected,
    server.lastError,
    server.lastFailure,
    t,
  ]);

  const needsAuth = server.authType === "oauth" && !server.oauthAuthorized;
  // 三处共用的失败体：刚测的优先，其次库里的
  const failure: MCPFailure | null =
    testResult?.failure ?? server.lastFailure ?? null;

  return (
    <div className="px-3 py-2.5">
      <div className={`grid ${MCP_ROW_GRID} items-center gap-3`}>
        {/* 图标 22 */}
        <span
          aria-hidden
          className="size-[22px] shrink-0 rounded-md bg-foreground/10"
        />
        {/* 名称 + 副行（主机 · 传输 · 能力计数） */}
        <div className="min-w-0">
          <div className="truncate text-sm text-foreground">{server.name}</div>
          <div
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={`${server.url} · ${transportLabel} · ${capability}`}
          >
            {host} · {transportLabel} · {capability}
          </div>
        </div>
        {/* 状态列 132 */}
        <span className="flex w-[132px] items-center gap-1.5 text-xs">
          <span className={cn("size-2 shrink-0 rounded-full", status.dot)} />
          <span className={cn("truncate", status.danger && "text-destructive")}>
            {status.text}
          </span>
        </span>
        {/* 用途列 92：标记，不是开关 */}
        <span className="flex w-[92px] flex-wrap items-center gap-1">
          {server.purposes.length === 0 && (
            <span className="text-[11px] text-muted-foreground">—</span>
          )}
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
        </span>
        {/* 操作列 140：与栅格末列同宽，内容右对齐吃掉余量 */}
        <span className="flex w-[140px] items-center justify-end gap-1">
          {needsAuth ? (
            <Button size="sm" variant="ghost" onPress={onAuthorize}>
              {t("ai_settings.mcp_oauth_authorize")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={testing}
              aria-label={t("ai_settings.mcp_test")}
              onPress={onTest}
            >
              <RefreshCw className={cn("size-3.5", testing && "animate-spin")} />
              {redetecting
                ? t("ai_settings.mcp_test_redetecting")
                : t("ai_settings.mcp_test")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={t("ai_settings.mcp_menu_edit")}
            onPress={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Dropdown>
            <Dropdown.Trigger
              aria-label={t("ai_settings.mcp_col_actions")}
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-md",
                "text-muted-foreground transition-colors",
                "hover:bg-secondary hover:text-foreground data-[pressed]:bg-secondary",
              )}
            >
              <MoreHorizontal className="size-4" />
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label={t("ai_settings.mcp_col_actions")}
                onAction={(key) => {
                  if (key === "test") onTest();
                  else if (key === "authorize") onAuthorize();
                  else if (key === "redetect") onRedetect();
                  else if (key === "edit") onEdit();
                  else if (key === "delete") onDelete();
                }}
              >
                <Dropdown.Item
                  key="test"
                  id="test"
                  textValue={t("ai_settings.mcp_menu_test")}
                >
                  <Label>{t("ai_settings.mcp_menu_test")}</Label>
                </Dropdown.Item>
                {server.authType === "oauth" && (
                  <Dropdown.Item
                    key="authorize"
                    id="authorize"
                    textValue={t("ai_settings.mcp_menu_authorize")}
                  >
                    <Label>{t("ai_settings.mcp_menu_authorize")}</Label>
                  </Dropdown.Item>
                )}
                <Dropdown.Item
                  key="redetect"
                  id="redetect"
                  textValue={t("ai_settings.mcp_menu_redetect")}
                >
                  <Label>{t("ai_settings.mcp_menu_redetect")}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  key="edit"
                  id="edit"
                  textValue={t("ai_settings.mcp_menu_edit")}
                >
                  <Label>{t("ai_settings.mcp_menu_edit")}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  key="delete"
                  id="delete"
                  textValue={t("ai_settings.mcp_menu_delete")}
                  variant="danger"
                >
                  <Label>{t("ai_settings.mcp_menu_delete")}</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </span>
      </div>

      {/* 测试结果行内回显（成功绿 / 失败进共用失败块） */}
      {testResult && (
        <div className="mt-1.5 pl-[34px]">
          {testResult.connected ? (
            <div className="text-xs text-emerald-600 dark:text-emerald-400">
              {t("ai_settings.mcp_test_ok", {
                count: testResult.toolCount,
                resources: testResult.resourceCount,
              })}
              {testResult.transport ? ` · ${testResult.transport}` : ""}
              {typeof testResult.latencyMs === "number"
                ? ` · ${testResult.latencyMs}ms`
                : ""}
            </div>
          ) : testResult.failure ? (
            <MCPFailureBlock failure={testResult.failure} onExit={onExit} />
          ) : (
            <div className="break-all text-xs text-destructive">
              {testResult.error || t("ai_settings.mcp_test_failed")}
            </div>
          )}
        </div>
      )}

      {/* 库里的失败（没刚测过时看它，与上面同一套组件） */}
      {!testResult && failure && (
        <div className="mt-1.5 pl-[34px]">
          <MCPFailureBlock failure={failure} onExit={onExit} compact />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新建 / 编辑对话框：默认页粘贴 JSON → 识别结果卡 → 手动填写页
// ---------------------------------------------------------------------------

interface MCPServerFormDialogProps {
  open: boolean;
  tab: "paste" | "manual";
  onTabChange: (tab: "paste" | "manual") => void;
  onOpenChange: (open: boolean) => void;
  /** null = 新建 */
  server: MCPServer | null;
  /** 粘贴识别后「填入表单」的内容（新建时用） */
  pasteFill: MCPServerDraft | null;
  onSaved: (server: MCPServer, created: boolean) => void;
  onReload: () => void | Promise<void>;
}

function MCPServerFormDialog({
  open,
  tab,
  onTabChange,
  onOpenChange,
  server,
  pasteFill,
  onSaved,
  onReload,
}: MCPServerFormDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MCPServerDraft>(emptyMCPServerDraft);
  const [showErrors, setShowErrors] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 粘贴页状态（只在新建时出现）
  const [pasteText, setPasteText] = useState("");
  const [isCreatingAll, setIsCreatingAll] = useState(false);
  const [createAllError, setCreateAllError] = useState<string | null>(null);

  // 打开时重置表单：编辑回填连接，新建用粘贴填入（或空草稿）
  useEffect(() => {
    if (!open) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setDraft(
      server
        ? mcpDraftFromServer(server)
        : (pasteFill ?? emptyMCPServerDraft()),
    );
    setShowErrors(false);
    setSaveError(null);
    setPasteText("");
    setCreateAllError(null);
  }, [open, server, pasteFill]);

  const errors = useMemo(() => validateMCPServerDraft(draft), [draft]);

  const parsed = useMemo(
    () => (pasteText.trim() ? parseMCPJSON(pasteText) : null),
    [pasteText],
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

  /** 识别结果「填入表单」：切到手动页继续改（测完再保存） */
  const fillFromParsed = useCallback(
    (item: MCPParsedServer) => {
      const base = emptyMCPServerDraft();
      setDraft({
        ...base,
        name: item.name,
        transport: item.transport,
        url: item.url,
        authType: Object.keys(item.headers).length > 0 ? "header" : "none",
        headers: Object.entries(item.headers).map(([key, value]) => ({
          key,
          value,
        })),
        // 粘贴建档默认两种用途都标（向导里可见，编辑里可改）
        purposes: ["ai", "feed"],
      });
      setShowErrors(false);
      setSaveError(null);
      onTabChange("manual");
    },
    [onTabChange],
  );

  /** 多条一次建完（用途默认双标，跟全局取数；逐条报错不中断） */
  const handleCreateAll = useCallback(async () => {
    if (!parsed || !parsed.ok) return;
    setIsCreatingAll(true);
    setCreateAllError(null);
    let failed = 0;
    for (const item of parsed.servers) {
      try {
        await createMCPServer({
          name: item.name,
          transport: item.transport,
          url: item.url,
          authType: Object.keys(item.headers).length > 0 ? "header" : "none",
          headers: item.headers,
          enabled: true,
          purposes: ["ai", "feed"],
          useGlobalFetch: true,
        });
      } catch (err) {
        failed++;
        setCreateAllError(
          err instanceof Error
            ? err.message
            : t("ai_settings.mcp_save_failed"),
        );
      }
    }
    setIsCreatingAll(false);
    await onReload();
    if (failed === 0) {
      onOpenChange(false);
      showToast(
        t("ai_settings.mcp_recognized_multi", {
          count: parsed.servers.length,
        }),
      );
    }
  }, [parsed, onReload, onOpenChange, t]);

  const transportOptions = useMemo(
    () => [
      { value: "auto", label: t("ai_settings.mcp_transport_auto") },
      { value: "streamable-http", label: t("ai_settings.mcp_transport_http") },
      { value: "sse", label: t("ai_settings.mcp_transport_sse") },
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
          {!server && (
            <Tabs.Root
              selectedKey={tab}
              onSelectionChange={(key) =>
                onTabChange(key as "paste" | "manual")
              }
            >
              <Tabs.List>
                <Tabs.Tab id="paste">
                  {t("ai_settings.mcp_tab_paste")}
                </Tabs.Tab>
                <Tabs.Tab id="manual">
                  {t("ai_settings.mcp_tab_manual")}
                </Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel id="paste" className="space-y-3 pt-3">
                <MCPJsonEditor
                  value={pasteText}
                  onChange={setPasteText}
                  ariaLabel={t("ai_settings.mcp_tab_paste")}
                  rows={5}
                />
                <p className="text-xs text-muted-foreground">
                  {t("ai_settings.mcp_paste_hint")}
                </p>

                {parsed && !parsed.ok && (
                  <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {t(`ai_settings.mcp_parse_${parsed.error}`)}
                  </div>
                )}

                {parsed?.ok && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        {t("ai_settings.mcp_recognized")}
                        {parsed.servers.length > 1 &&
                          ` · ${t("ai_settings.mcp_recognized_multi", { count: parsed.servers.length })}`}
                      </span>
                      {parsed.servers.length > 1 && (
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={isCreatingAll}
                          onPress={() => void handleCreateAll()}
                        >
                          {isCreatingAll
                            ? t("settings.saving")
                            : t("ai_settings.mcp_create_connection")}
                        </Button>
                      )}
                    </div>
                    {createAllError && (
                      <div className="break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {createAllError}
                      </div>
                    )}
                    {parsed.servers.map((item) => (
                      <div
                        key={`${item.name}::${item.url}`}
                        className="space-y-1 rounded-lg border border-emerald-600/40 bg-emerald-500/5 px-3 py-2"
                      >
                        <div className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs">
                          <span className="text-muted-foreground">
                            {t("ai_settings.mcp_recognized_name")}
                          </span>
                          <span className="truncate">{item.name}</span>
                          <span className="text-muted-foreground">
                            {t("ai_settings.mcp_recognized_transport")}
                          </span>
                          <span>
                            <Chip
                              size="sm"
                              variant="tertiary"
                              color={
                                item.transport === "auto" ? "default" : "accent"
                              }
                              className="border border-border"
                            >
                              {item.transport === "auto"
                                ? t("ai_settings.mcp_transport_auto")
                                : item.transport === "sse"
                                  ? "SSE"
                                  : "HTTP"}
                            </Chip>{" "}
                            <span className="text-muted-foreground">
                              （{item.detectedFrom}）
                            </span>
                          </span>
                          <span className="text-muted-foreground">
                            {t("ai_settings.mcp_recognized_address")}
                          </span>
                          <span
                            className="truncate font-mono text-[11px]"
                            title={item.url}
                          >
                            {item.url}
                          </span>
                          <span className="text-muted-foreground">
                            {t("ai_settings.mcp_recognized_auth")}
                          </span>
                          <span>
                            {Object.keys(item.headers).length > 0 ? (
                              <Chip
                                size="sm"
                                variant="tertiary"
                                className="border border-border"
                              >
                                Header
                              </Chip>
                            ) : null}{" "}
                            <span className="text-muted-foreground">
                              {Object.keys(item.headers).length > 0
                                ? t(
                                    "ai_settings.mcp_recognized_auth_header",
                                    {
                                      keys: Object.keys(item.headers).join(
                                        ", ",
                                      ),
                                    },
                                  )
                                : t("ai_settings.mcp_recognized_auth_none")}
                            </span>
                          </span>
                        </div>
                        {/* 原文只读展示（Code + ScrollShadow + 上色） */}
                        <MCPJsonView
                          code={pasteText.trim()}
                          maxHeight="120px"
                        />
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="secondary"
                            onPress={() => fillFromParsed(item)}
                          >
                            {t("ai_settings.mcp_tab_manual")} →
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Tabs.Panel>

              <Tabs.Panel id="manual" className="pt-3">
                <ManualForm
                  draft={draft}
                  patch={patch}
                  patchHeader={patchHeader}
                  server={server}
                  transportOptions={transportOptions}
                  fetchOptions={fetchOptions}
                  onReload={onReload}
                />
              </Tabs.Panel>
            </Tabs.Root>
          )}

          {server && (
            <ManualForm
              draft={draft}
              patch={patch}
              patchHeader={patchHeader}
              server={server}
              transportOptions={transportOptions}
              fetchOptions={fetchOptions}
              onReload={onReload}
            />
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
          {/* 粘贴页不直接保存（走识别卡 → 填入表单 / 全部创建） */}
          {!(server === null && tab === "paste") && (
            <Button
              size="sm"
              isDisabled={isSaving}
              onPress={() => void handleSave()}
            >
              {isSaving ? t("settings.saving") : t("actions.save")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 手动填写页（新建的手动 tab / 编辑共用）
// ---------------------------------------------------------------------------

interface ManualFormProps {
  draft: MCPServerDraft;
  patch: (changes: Partial<MCPServerDraft>) => void;
  patchHeader: (index: number, changes: Partial<MCPHeaderDraft>) => void;
  server: MCPServer | null;
  transportOptions: { value: string; label: string }[];
  fetchOptions: { value: string; label: string }[];
  onReload: () => void | Promise<void>;
}

function ManualForm({
  draft,
  patch,
  patchHeader,
  server,
  transportOptions,
  fetchOptions,
  onReload,
}: ManualFormProps) {
  const { t } = useTranslation();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<MCPTestResult | null>(null);

  const handleTest = useCallback(async () => {
    if (!server) return;
    setTesting(true);
    try {
      // 先保存再测（测的是库里的那份，避免「测的和存的两张皮」）
      const payload = buildMCPServerPayload(draft);
      await updateMCPServer(server.id, payload);
      setTestResult(await testMCPServer(server.id));
      await onReload();
    } catch (err) {
      setTestResult({
        connected: false,
        toolCount: 0,
        resourceCount: 0,
        error: mcpErrorMessage(err),
      });
    } finally {
      setTesting(false);
    }
  }, [server, draft, onReload]);

  const handleExit = useCallback(
    (exit: MCPFailureExit) => {
      if (exit === "to_header") patch({ authType: "header" });
      else if (exit === "to_oauth") patch({ authType: "oauth" });
      else if (exit === "to_sse") {
        patch({ transport: "sse" });
        void handleTest();
      } else if (exit === "redetect" && server) {
        setTesting(true);
        void redetectMCPTransport(server.id)
          .then((result) => {
            setTestResult(result);
            return onReload();
          })
          .catch((err: unknown) => {
            setTestResult({
              connected: false,
              toolCount: 0,
              resourceCount: 0,
              error: mcpErrorMessage(err),
            });
          })
          .finally(() => setTesting(false));
      }
    },
    [patch, handleTest, server, onReload],
  );

  return (
    <div className="space-y-4">
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
          {server?.lastTransport &&
            ` ${t("ai_settings.mcp_transport_last_ok", { t: server.lastTransport })}`}
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

      {/* 认证方式 */}
      <div className="space-y-1.5">
        <span className={labelClass}>{t("ai_settings.mcp_auth")}</span>
        <ToggleButtonGroup
          selectionMode="single"
          size="sm"
          selectedKeys={new Set([draft.authType])}
          onSelectionChange={(keys) => {
            const first = [...keys].map(String)[0];
            if (first === "none" || first === "header" || first === "oauth") {
              patch({ authType: first });
            }
          }}
        >
          <ToggleButton id="none">
            {t("ai_settings.mcp_auth_none")}
          </ToggleButton>
          <ToggleButton id="header">
            {t("ai_settings.mcp_auth_header")}
          </ToggleButton>
          <ToggleButton id="oauth">
            {t("ai_settings.mcp_auth_oauth")}
          </ToggleButton>
        </ToggleButtonGroup>
      </div>

      {draft.authType === "header" && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">
              {t("ai_settings.mcp_headers")}
            </span>
            <Button
              size="sm"
              variant="secondary"
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
                className={cn(
                  inputClass,
                  "min-w-[8rem] flex-1 font-mono text-xs",
                )}
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

      {draft.authType === "oauth" && (
        <OAuthBlock
          server={server}
          draft={draft}
          patch={patch}
          onReload={onReload}
        />
      )}

      {/* 启用（开关在编辑框里，列表上只是标记 —— 16-6） */}
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
          onChange={(value) => patch({ useGlobalFetch: value !== "custom" })}
          options={fetchOptions}
        />
        <p className="text-xs text-muted-foreground">
          {t("ai_settings.mcp_fetch_hint")}
        </p>
      </div>

      {!draft.useGlobalFetch && (
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-border p-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label
              htmlFor="mcp-timeout"
              className="text-xs text-muted-foreground"
            >
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
            <label
              htmlFor="mcp-concurrency"
              className="text-xs text-muted-foreground"
            >
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
            <label
              htmlFor="mcp-interval"
              className="text-xs text-muted-foreground"
            >
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

      {/* 连接测试（编辑态才有：测的是库里的那份） */}
      {server && (
        <div className="space-y-2">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={testing}
            onPress={() => void handleTest()}
          >
            <RefreshCw className={cn("size-3.5", testing && "animate-spin")} />
            {t("ai_settings.mcp_test")}
          </Button>
          {testResult && testResult.connected && (
            <div className="text-xs text-emerald-600 dark:text-emerald-400">
              {t("ai_settings.mcp_test_ok", {
                count: testResult.toolCount,
                resources: testResult.resourceCount,
              })}
              {testResult.transport ? ` · ${testResult.transport}` : ""}
              {typeof testResult.latencyMs === "number"
                ? ` · ${testResult.latencyMs}ms`
                : ""}
            </div>
          )}
          {testResult && !testResult.connected && testResult.failure && (
            <MCPFailureBlock failure={testResult.failure} onExit={handleExit} />
          )}
          {testResult &&
            !testResult.connected &&
            !testResult.failure &&
            testResult.error && (
              <div className="break-all text-xs text-destructive">
                {testResult.error}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OAuth 块（16-11）：发现 → DCR/手填 → PKCE 浏览器授权 → 已授权态
// ---------------------------------------------------------------------------

interface OAuthBlockProps {
  /** null = 还没建档：先保存，再回来授权 */
  server: MCPServer | null;
  draft: MCPServerDraft;
  patch: (changes: Partial<MCPServerDraft>) => void;
  onReload: () => void | Promise<void>;
}

function OAuthBlock({ server, draft, patch, onReload }: OAuthBlockProps) {
  const { t } = useTranslation();
  const [discovery, setDiscovery] = useState<MCPOAuthDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setWaiting(false);
  }, []);

  useEffect(() => () => stopPoll(), [stopPoll]);

  const callbackUrl = useMemo(
    () =>
      typeof window === "undefined"
        ? ""
        : buildOAuthCallbackURL(window.location.origin),
    [],
  );

  const handleDiscover = useCallback(async () => {
    if (!server) return;
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      setDiscovery(await discoverMCPOAuth(server.id));
    } catch (err) {
      setDiscoveryError(
        err instanceof Error
          ? err.message
          : t("ai_settings.mcp_oauth_discovery_failed"),
      );
    } finally {
      setDiscovering(false);
    }
  }, [server, t]);

  // 打开编辑框就发现一次（有 server 才行）
  useEffect(() => {
    if (server) void handleDiscover();
  }, [server, handleDiscover]);

  const refreshServer = useCallback(async () => {
    await onReload();
  }, [onReload]);

  const handleStart = useCallback(async () => {
    if (!server || !callbackUrl) return;
    // 手填了就先存下来（start 自己也会存，这里存是为了「授权前先落库」的顺序感）
    try {
      const payload = buildMCPServerPayload(draft);
      await updateMCPServer(server.id, payload);
    } catch {
      // 存失败不拦授权（start 会带上填的值）；保存错误由底部保存按钮暴露
    }
    setStarting(true);
    setStartError(null);
    try {
      const result = await startMCPOAuth(server.id, {
        redirectUri: callbackUrl,
        clientId: draft.oauthClientId.trim() || undefined,
        clientSecret:
          draft.oauthClientSecret && draft.oauthClientSecret !== MCP_MASK
            ? draft.oauthClientSecret
            : undefined,
      });
      window.open(result.authURL, "_blank", "noopener");
      // 等回调：3 秒轮一次，最多 2 分钟；用户也可以关页面稍后手动回来
      setWaiting(true);
      let rounds = 0;
      pollRef.current = setInterval(() => {
        rounds++;
        void (async () => {
          await refreshServer();
          if (rounds >= 40 && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setWaiting(false);
          }
        })();
      }, 3000);
    } catch (err) {
      setStartError(
        err instanceof Error
          ? err.message
          : t("ai_settings.mcp_oauth_start_failed"),
      );
    } finally {
      setStarting(false);
    }
  }, [server, callbackUrl, draft, refreshServer, t]);

  const handleRevoke = useCallback(async () => {
    if (!server) return;
    setRevoking(true);
    try {
      await revokeMCPOAuth(server.id);
      await refreshServer();
      setDiscovery(null);
    } finally {
      setRevoking(false);
    }
  }, [server, refreshServer]);

  if (!server) {
    return (
      <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {t("ai_settings.mcp_oauth_save_first")}
      </p>
    );
  }

  const authorized = server.oauthAuthorized;
  // needsManual = 发现说要手填，或发现失败过
  const needsManual =
    discovery !== null &&
    (discovery.needsManual || (!discovery.hasDCR && !discovery.hasClientID));

  return (
    <div className="space-y-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
      {authorized ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="size-2 rounded-full bg-emerald-500" />
            <span className="font-medium">
              {t("ai_settings.mcp_oauth_authorized")}
            </span>
            {server.oauthExpiresAt && (
              <span className="text-muted-foreground">
                {t("ai_settings.mcp_oauth_expires", {
                  time: server.oauthExpiresAt,
                })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={starting}
              onPress={() => void handleStart()}
            >
              {t("ai_settings.mcp_oauth_reauth")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={revoking}
              onPress={() => void handleRevoke()}
            >
              {t("ai_settings.mcp_oauth_revoke")}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {t("ai_settings.mcp_oauth_token_note")}
            </span>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="size-2 rounded-full bg-amber-500" />
            <span className="font-medium">
              {t("ai_settings.mcp_oauth_unauthorized")}
            </span>
            <span className="text-muted-foreground">
              · {t("ai_settings.mcp_oauth_discovery_note")}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("ai_settings.mcp_oauth_steps")}
          </p>
          {callbackUrl && (
            <p className="font-mono text-[11px] break-all text-muted-foreground">
              {t("ai_settings.mcp_oauth_callback", { url: callbackUrl })}
            </p>
          )}

          {discovering && (
            <p className="text-xs text-muted-foreground">
              {t("ai_settings.mcp_oauth_discovering")}
            </p>
          )}
          {discoveryError && (
            <p className="break-all text-xs text-destructive">
              {discoveryError}
            </p>
          )}
          {discovery?.instructions && (
            <p className="text-xs text-muted-foreground">
              {discovery.instructions}
            </p>
          )}

          {(needsManual || discoveryError) && (
            <div className="space-y-2 rounded-md border border-border bg-background p-2.5">
              <p className="text-xs font-medium">
                {t("ai_settings.mcp_oauth_no_dcr")}
              </p>
              <div className="space-y-1.5">
                <label
                  htmlFor="mcp-oauth-client-id"
                  className="text-xs text-muted-foreground"
                >
                  {t("ai_settings.mcp_oauth_client_id")}
                </label>
                <input
                  id="mcp-oauth-client-id"
                  type="text"
                  value={draft.oauthClientId}
                  onChange={(e) => patch({ oauthClientId: e.target.value })}
                  className={cn(inputClass, "font-mono text-xs")}
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="mcp-oauth-client-secret"
                  className="text-xs text-muted-foreground"
                >
                  {t("ai_settings.mcp_oauth_client_secret")}
                </label>
                <input
                  id="mcp-oauth-client-secret"
                  type="password"
                  value={draft.oauthClientSecret}
                  onChange={(e) =>
                    patch({ oauthClientSecret: e.target.value })
                  }
                  className={cn(inputClass, "font-mono text-xs")}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("ai_settings.mcp_header_mask_hint", { mask: MCP_MASK })}
              </p>
            </div>
          )}

          {startError && (
            <p className="break-all text-xs text-destructive">{startError}</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              isDisabled={starting || discovering}
              onPress={() => void handleStart()}
            >
              {starting
                ? t("ai_settings.mcp_oauth_starting")
                : t("ai_settings.mcp_oauth_authorize")}
            </Button>
            {waiting && (
              <Button size="sm" variant="ghost" onPress={stopPoll}>
                {t("actions.cancel")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
