import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertDialog, Button, Tabs } from "@heroui/react";
import { Copy, RefreshCw } from "lucide-react";
import { HeroSwitch } from "@/components/ui/hero-switch";
import { cn } from "@/lib/utils";
import {
  createMCPOutboundToken,
  getMCPOutbound,
  revokeMCPOutboundToken,
  updateMCPOutbound,
} from "@/api";
import { buildMCPClientConfigExample, mcpErrorMessage } from "@/lib/mcp";
import type { MCPOutboundStatus } from "@/types/mcp";
import { copyToClipboard } from "@/stores/toast-store";
import { MCPJsonView } from "./MCPJsonView";

/**
 * 设置 → 数据控制里的出向段：「Krss 作为 MCP 服务器」（方案 §五 / B4 拍板放这个页）。
 *
 * 三块：启用开关（含「允许写操作」）、长期 Token（17-2：明文存库、可重复查看复制）、
 * 一段可直接复制的 MCP 客户端配置示例（复制即用，Token 已填好）。
 */
export function MCPOutboundSection() {
  const { t } = useTranslation();

  const [status, setStatus] = useState<MCPOutboundStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  /** 客户端配置示例的写法：HTTP 与 SSE 两种都给（17-x 微调），可复制 */
  const [exampleTransport, setExampleTransport] = useState<"http" | "sse">(
    "http",
  );
  /** 对外访问地址的本地草稿（文本框要显式保存，不跟开关一样即时落） */
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      setStatus(await getMCPOutbound());
    } catch (err) {
      // 只存原文；空串表示没有可显示的原文，渲染时退回「加载失败」
      setLoadError(mcpErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clientConfig = useMemo(() => {
    // 对外地址优先用用户填的 baseUrl；没填才回落到浏览器当前 origin
    // （生产单机部署时两者一致；开发时前后端不同源，必须填）。
    const origin =
      status?.baseUrl?.trim() ||
      (typeof window === "undefined" ? undefined : window.location.origin);
    // 17-5：复制即用 —— 有真 Token 直接填进去
    return buildMCPClientConfigExample(origin, exampleTransport, status?.token);
  }, [exampleTransport, status?.baseUrl, status?.token]);

  const saveConfig = useCallback(
    async (
      changes: Partial<
        Pick<MCPOutboundStatus, "enabled" | "writeEnabled" | "baseUrl">
      >,
    ) => {
      if (!status) return;
      const next = { ...status, ...changes };
      // 开关是即时型（本项目设置页的惯例）：先落本地让开关跟手，失败再退回来并报错
      setStatus(next);
      setIsSaving(true);
      setActionError(null);
      try {
        setStatus(
          await updateMCPOutbound({
            enabled: next.enabled,
            writeEnabled: next.writeEnabled,
            baseUrl: next.baseUrl ?? "",
          }),
        );
      } catch (err) {
        setStatus(status);
        setActionError(
          err instanceof Error ? err.message : t("data_control.mcp_save_failed"),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [status, t],
  );

  const handleGenerateToken = useCallback(async () => {
    setIsGenerating(true);
    setActionError(null);
    try {
      // 17-2：明文存库 —— 返回的状态里直接带明文，常驻显示
      setStatus(await createMCPOutboundToken());
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : t("data_control.mcp_token_generate_failed"),
      );
    } finally {
      setIsGenerating(false);
    }
  }, [t]);

  const handleRevokeToken = useCallback(async () => {
    setIsRevoking(true);
    setActionError(null);
    try {
      await revokeMCPOutboundToken();
      setConfirmRevoke(false);
      await load();
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : t("data_control.mcp_token_revoke_failed"),
      );
    } finally {
      setIsRevoking(false);
    }
  }, [load, t]);

  const fieldValueClass = cn(
    "min-w-0 flex-1 truncate font-mono text-xs text-foreground",
  );

  /** 生成时间 raw UTC → 本地化显示（17-5）；坏值回落原文 */
  const createdAtLabel = useMemo(() => {
    const raw = status?.tokenCreatedAt;
    if (!raw) return "—";
    const time = new Date(raw).getTime();
    if (Number.isNaN(time)) return raw;
    return new Date(time).toLocaleString();
  }, [status?.tokenCreatedAt]);

  return (
    <section>
      <h3 className="mb-4 text-sm font-semibold text-muted-foreground">
        {t("data_control.mcp_outbound_title")}
      </h3>

      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("data_control.mcp_outbound_hint")}
        </p>

        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw className="size-3.5 animate-spin" />
            {t("data_control.mcp_loading")}
          </div>
        )}

        {loadError !== null && (
          <div className="break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {loadError || t("data_control.mcp_load_failed")}
          </div>
        )}

        {status && (
          <>
            {/* 端点与协议版本：只读展示 */}
            <div className="space-y-1.5 rounded-lg border border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-xs text-muted-foreground">
                  {t("data_control.mcp_endpoint")}
                </span>
                <span className={fieldValueClass}>{status.endpoint}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-xs text-muted-foreground">
                  {t("data_control.mcp_protocol")}
                </span>
                <span className={fieldValueClass}>{status.protocolVersion}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-xs text-muted-foreground">
                  {t("data_control.mcp_exposed")}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {t("data_control.mcp_exposed_count", {
                    tools: status.toolCount,
                    resources: status.resourceCount,
                  })}
                </span>
              </div>
            </div>

            {/* 启用出向服务 */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {t("data_control.mcp_enable")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("data_control.mcp_enable_hint")}
                </div>
              </div>
              <HeroSwitch
                aria-label={t("data_control.mcp_enable")}
                isSelected={status.enabled}
                isDisabled={isSaving}
                onChange={(checked: boolean) =>
                  void saveConfig({ enabled: checked })
                }
              />
            </div>

            {/* 允许写操作（默认关） */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {t("data_control.mcp_allow_write")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("data_control.mcp_allow_write_hint")}
                </div>
              </div>
              <HeroSwitch
                aria-label={t("data_control.mcp_allow_write")}
                isSelected={status.writeEnabled}
                isDisabled={isSaving || !status.enabled}
                onChange={(checked: boolean) =>
                  void saveConfig({ writeEnabled: checked })
                }
              />
            </div>

            {/* 对外访问地址：客户端配置示例用它拼 /mcp（不拿浏览器 origin 凑） */}
            <div className="space-y-1.5">
              <div className="text-sm font-medium">
                {t("data_control.mcp_base_url")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("data_control.mcp_base_url_hint")}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="url"
                  aria-label={t("data_control.mcp_base_url")}
                  value={baseUrlDraft ?? status.baseUrl ?? ""}
                  onChange={(event) => setBaseUrlDraft(event.target.value)}
                  placeholder="http://192.0.2.1:8082"
                  className={cn(
                    "h-9 min-w-[12rem] flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground",
                    "placeholder:text-muted-foreground/60",
                    "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary",
                  )}
                />
                <Button
                  size="sm"
                  isDisabled={
                    isSaving ||
                    (baseUrlDraft ?? status.baseUrl ?? "") ===
                      (status.baseUrl ?? "")
                  }
                  onPress={() =>
                    void (async () => {
                      await saveConfig({
                        baseUrl: (baseUrlDraft ?? "").trim(),
                      });
                      setBaseUrlDraft(null);
                    })()
                  }
                >
                  {t("actions.save")}
                </Button>
              </div>
            </div>

            {/* 长期 Token（17-2：明文存库，常驻显示 + 随时复制） */}
            <div className="space-y-2 rounded-lg border border-border px-3 py-3">
              <div className="text-sm font-medium">
                {t("data_control.mcp_token_title")}
              </div>

              {!status.tokenSet && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 text-xs text-muted-foreground">
                    {t("data_control.mcp_token_not_set")}
                  </div>
                  <Button
                    size="sm"
                    isDisabled={isGenerating}
                    onPress={() => void handleGenerateToken()}
                  >
                    {isGenerating
                      ? t("data_control.mcp_token_generating")
                      : t("data_control.mcp_token_generate")}
                  </Button>
                </div>
              )}

              {/* 明文常驻：显示 + 复制 + 重新生成 + 撤销 */}
              {status.tokenSet && status.token && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-[12rem] flex-1 break-all rounded-md bg-secondary px-2 py-1.5 font-mono text-xs text-foreground">
                      {status.token}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onPress={() =>
                        void copyToClipboard(
                          status.token ?? "",
                          t("data_control.mcp_token_copied"),
                          t("actions.copy_failed"),
                        )
                      }
                    >
                      <Copy className="size-3.5" />
                      {t("data_control.mcp_token_copy")}
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {t("data_control.mcp_token_prefix")}
                    </span>
                    <span className={fieldValueClass}>
                      {status.tokenPrefix ?? "—"}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {t("data_control.mcp_token_created_at")}
                    </span>
                    <span className={fieldValueClass}>{createdAtLabel}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={isGenerating}
                      onPress={() => void handleGenerateToken()}
                    >
                      {t("data_control.mcp_token_regenerate")}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      isDisabled={isRevoking}
                      onPress={() => setConfirmRevoke(true)}
                    >
                      {t("data_control.mcp_token_revoke")}
                    </Button>
                  </div>
                </div>
              )}

              {/* 存量哈希：明文不可回显，点一次重新生成即可 */}
              {status.tokenSet && !status.token && (
                <div className="space-y-2">
                  <div className="rounded-md border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    {t("data_control.mcp_token_legacy_hint")}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={isGenerating}
                      onPress={() => void handleGenerateToken()}
                    >
                      {t("data_control.mcp_token_regenerate")}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      isDisabled={isRevoking}
                      onPress={() => setConfirmRevoke(true)}
                    >
                      {t("data_control.mcp_token_revoke")}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {actionError && (
              <div className="break-all rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {actionError}
              </div>
            )}

            {/* 客户端配置示例（token 用占位符；HTTP 与 SSE 两种写法都给，可复制） */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {t("data_control.mcp_client_config")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("data_control.mcp_client_config_hint")}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() =>
                    void copyToClipboard(
                      clientConfig,
                      t("data_control.mcp_client_config_copied"),
                      t("actions.copy_failed"),
                    )
                  }
                >
                  <Copy className="size-3.5" />
                  {t("data_control.mcp_token_copy")}
                </Button>
              </div>
              <Tabs.Root
                selectedKey={exampleTransport}
                onSelectionChange={(key) =>
                  setExampleTransport(key as "http" | "sse")
                }
              >
                <Tabs.List>
                  <Tabs.Tab id="http">
                    {t("data_control.mcp_client_config_http")}
                  </Tabs.Tab>
                  <Tabs.Tab id="sse">
                    {t("data_control.mcp_client_config_sse")}
                  </Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel id="http" className="pt-2">
                  <MCPJsonView code={clientConfig} maxHeight="220px" />
                </Tabs.Panel>
                <Tabs.Panel id="sse" className="pt-2">
                  <MCPJsonView code={clientConfig} maxHeight="220px" />
                </Tabs.Panel>
              </Tabs.Root>
            </div>
          </>
        )}
      </div>

      {/* 撤销 token 需要确认（会让现有 agent 立刻失效） */}
      <AlertDialog>
        <Button className="hidden" aria-hidden />
        <AlertDialog.Backdrop
          isOpen={confirmRevoke}
          onOpenChange={(open) => !open && setConfirmRevoke(false)}
        >
          <AlertDialog.Container>
            <AlertDialog.Dialog className="max-w-lg">
              <AlertDialog.Header>
                <AlertDialog.Heading>
                  {t("data_control.mcp_token_revoke_confirm_title")}
                </AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <div className="text-sm text-muted-foreground">
                  {t("data_control.mcp_token_revoke_confirm_body")}
                </div>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setConfirmRevoke(false)}
                >
                  {t("actions.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  isDisabled={isRevoking}
                  onPress={() => void handleRevokeToken()}
                >
                  {t("data_control.mcp_token_revoke")}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </section>
  );
}
