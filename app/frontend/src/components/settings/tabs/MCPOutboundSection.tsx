import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertDialog, Button } from "@heroui/react";
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

/**
 * 设置 → 数据控制里的出向段：「Krss 作为 MCP 服务器」（方案 §五 / B4 拍板放这个页）。
 *
 * 三块：启用开关（含「允许写操作」）、长期 token（生成时明文只显示一次、库里只存哈希）、
 * 一段可直接复制的 MCP 客户端配置示例（token 用占位符，绝不带真值）。
 */
export function MCPOutboundSection() {
  const { t } = useTranslation();

  const [status, setStatus] = useState<MCPOutboundStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  /** 刚生成的明文 token —— 只在这一次渲染里存在，刷新页面就拿不到了 */
  const [newToken, setNewToken] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

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

  const clientConfig = useMemo(
    () =>
      buildMCPClientConfigExample(
        typeof window === "undefined" ? undefined : window.location.origin,
      ),
    [],
  );

  const saveConfig = useCallback(
    async (changes: Partial<Pick<MCPOutboundStatus, "enabled" | "writeEnabled">>) => {
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
      const result = await createMCPOutboundToken();
      setStatus(result);
      setNewToken(result.token);
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
      setNewToken(null);
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

            {/* 长期 token */}
            <div className="space-y-2 rounded-lg border border-border px-3 py-3">
              <div className="text-sm font-medium">
                {t("data_control.mcp_token_title")}
              </div>

              {!status.tokenSet && !newToken && (
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

              {/* 明文：只显示这一次 */}
              {newToken && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-[12rem] flex-1 break-all rounded-md bg-secondary px-2 py-1.5 font-mono text-xs text-foreground">
                      {newToken}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onPress={() =>
                        void copyToClipboard(
                          newToken,
                          t("data_control.mcp_token_copied"),
                        )
                      }
                    >
                      <Copy className="size-3.5" />
                      {t("data_control.mcp_token_copy")}
                    </Button>
                  </div>
                  <div className="rounded-md border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    {t("data_control.mcp_token_once_warning")}
                  </div>
                </div>
              )}

              {/* 已存在的 token：只给前缀与时间，明文拿不回来 */}
              {status.tokenSet && (
                <div className="space-y-2">
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
                    <span className={fieldValueClass}>
                      {status.tokenCreatedAt ?? "—"}
                    </span>
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

            {/* 客户端配置示例（token 用占位符） */}
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
                  variant="outline"
                  onPress={() =>
                    void copyToClipboard(
                      clientConfig,
                      t("data_control.mcp_client_config_copied"),
                    )
                  }
                >
                  <Copy className="size-3.5" />
                  {t("data_control.mcp_token_copy")}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-md bg-secondary px-3 py-2 font-mono text-xs text-foreground">
                {clientConfig}
              </pre>
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
