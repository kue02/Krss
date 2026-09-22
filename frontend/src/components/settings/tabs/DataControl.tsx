import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AlertDialog, Button } from "@heroui/react";
import {
  startImportOPML,
  watchImportStatus,
  cancelImportOPML,
  exportOPML,
  exportSettings,
  importSettings,
  clearAICache,
  clearAnubisCookies,
  clearIconCache,
  clearReadabilityCache,
  clearEntryCache,
} from "@/api";
import type { ClearAICacheResponse, ClearCacheResponse } from "@/api";
import { cn } from "@/lib/utils";
import { MCPOutboundSection } from "@/components/settings/tabs/MCPOutboundSection";
import { pullSettingsFromServer } from "@/lib/settings-sync";
import type { ImportResult, ImportTask } from "@/types/api";
import type { SettingsExportPayload } from "@/types/settings";

/**
 * 21 批：导入前先确认「这确实是本应用导出的设置文件」——
 * 后续的去重/白名单校验在后端（认不出的键会 400 并把键名带回来），
 * 这里只挡「随手选了张图片」这种明显不对的文件，别让用户白点一次。
 */
function isSettingsExportPayload(value: unknown): value is SettingsExportPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    version?: unknown;
    settings?: unknown;
  };
  return (
    typeof candidate.version === "number" &&
    typeof candidate.settings === "object" &&
    candidate.settings !== null
  );
}

export function DataControl() {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [task, setTask] = useState<ImportTask | null>(null);

  // AI cache
  const [isClearingAI, setIsClearingAI] = useState(false);
  const [clearAIResult, setClearAIResult] =
    useState<ClearAICacheResponse | null>(null);
  const [clearAIError, setClearAIError] = useState<string | null>(null);

  // Anubis cookies
  const [isClearingAnubis, setIsClearingAnubis] = useState(false);
  const [clearAnubisResult, setClearAnubisResult] =
    useState<ClearCacheResponse | null>(null);
  const [clearAnubisError, setClearAnubisError] = useState<string | null>(null);

  // Icon cache
  const [isClearingIcon, setIsClearingIcon] = useState(false);
  const [clearIconResult, setClearIconResult] =
    useState<ClearCacheResponse | null>(null);
  const [clearIconError, setClearIconError] = useState<string | null>(null);

  // Readability cache
  const [isClearingReadability, setIsClearingReadability] = useState(false);
  const [clearReadabilityResult, setClearReadabilityResult] =
    useState<ClearCacheResponse | null>(null);
  const [clearReadabilityError, setClearReadabilityError] = useState<
    string | null
  >(null);

  // Entry cache
  const [isClearingEntry, setIsClearingEntry] = useState(false);
  const [clearEntryResult, setClearEntryResult] =
    useState<ClearCacheResponse | null>(null);
  const [clearEntryError, setClearEntryError] = useState<string | null>(null);

  const isImporting = task?.status === "running";

  // Connect to SSE on mount to get current import status
  useEffect(() => {
    const cancel = watchImportStatus((t) => {
      setTask(t);

      if (t.status === "done" && t.result) {
        setImportResult(t.result);
        // Invalidate queries to refresh feed list
        queryClient.invalidateQueries({ queryKey: ["folders"] });
        queryClient.invalidateQueries({ queryKey: ["feeds"] });
        queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      } else if (t.status === "error") {
        setImportError(t.error || "Import failed");
      }
    });

    return cancel;
  }, [queryClient]);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportResult(null);
    setImportError(null);
    setTask(null);

    try {
      await startImportOPML(file);
      // SSE connection is already established in useEffect on mount
      // No need to create another one here - it will receive the updates
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      setImportError(message);
    } finally {
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleCancel = async () => {
    await cancelImportOPML();
  };

  const handleExport = async () => {
    try {
      await exportOPML();
    } catch {
      // Export error handled silently
    }
  };

  // ---------- 21 批：设置导出 / 导入 ----------

  const settingsFileInputRef = useRef<HTMLInputElement>(null);
  const [isExportingSettings, setIsExportingSettings] = useState(false);
  const [pendingSettingsFile, setPendingSettingsFile] = useState<{
    name: string;
    payload: SettingsExportPayload;
  } | null>(null);
  const [isImportingSettings, setIsImportingSettings] = useState(false);
  const [settingsImportCount, setSettingsImportCount] = useState<number | null>(
    null,
  );
  const [settingsError, setSettingsError] = useState<string | null>(null);

  /** 导出设置：拿到 JSON 存成文件（文件名带日期，多份备份能区分开） */
  const handleExportSettings = async () => {
    setIsExportingSettings(true);
    setSettingsError(null);

    try {
      const payload = await exportSettings();
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `krss-settings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setSettingsError(
        err instanceof Error
          ? err.message
          : t("data_control.export_settings_failed"),
      );
    } finally {
      setIsExportingSettings(false);
    }
  };

  /** 选中文件：先本地粗校验，再弹确认（覆盖设置不可撤销） */
  const handlePickSettingsFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    setSettingsImportCount(null);
    setSettingsError(null);

    try {
      if (!file) return;
      const parsed: unknown = JSON.parse(await file.text());
      if (!isSettingsExportPayload(parsed)) {
        setSettingsError(t("data_control.import_settings_invalid_file"));
        return;
      }
      setPendingSettingsFile({ name: file.name, payload: parsed });
    } catch {
      setSettingsError(t("data_control.import_settings_invalid_file"));
    } finally {
      // 允许连续选同一份文件（不清空 value 时第二次 onChange 不触发）
      if (settingsFileInputRef.current) settingsFileInputRef.current.value = "";
    }
  };

  const handleConfirmImportSettings = async () => {
    if (!pendingSettingsFile) return;
    setIsImportingSettings(true);

    try {
      const result = await importSettings({
        version: pendingSettingsFile.payload.version,
        settings: pendingSettingsFile.payload.settings,
      });
      setSettingsImportCount(result.imported);
      setPendingSettingsFile(null);
      // 导入改的是**服务端**那份：立刻以服务端为准刷新本地四组，并让设置表单重新取数
      await pullSettingsFromServer();
      await queryClient.invalidateQueries();
    } catch (err) {
      setSettingsError(
        err instanceof Error
          ? err.message
          : t("data_control.import_settings_failed"),
      );
      setPendingSettingsFile(null);
    } finally {
      setIsImportingSettings(false);
    }
  };

  const handleClearAICache = async () => {
    setIsClearingAI(true);
    setClearAIResult(null);
    setClearAIError(null);

    try {
      const result = await clearAICache();
      setClearAIResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clear failed";
      setClearAIError(message);
    } finally {
      setIsClearingAI(false);
    }
  };

  const handleClearAnubisCookies = async () => {
    setIsClearingAnubis(true);
    setClearAnubisResult(null);
    setClearAnubisError(null);

    try {
      const result = await clearAnubisCookies();
      setClearAnubisResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clear failed";
      setClearAnubisError(message);
    } finally {
      setIsClearingAnubis(false);
    }
  };

  const handleClearIconCache = async () => {
    setIsClearingIcon(true);
    setClearIconResult(null);
    setClearIconError(null);

    try {
      const result = await clearIconCache();
      setClearIconResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clear failed";
      setClearIconError(message);
    } finally {
      setIsClearingIcon(false);
    }
  };

  const handleClearReadabilityCache = async () => {
    setIsClearingReadability(true);
    setClearReadabilityResult(null);
    setClearReadabilityError(null);

    try {
      const result = await clearReadabilityCache();
      setClearReadabilityResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clear failed";
      setClearReadabilityError(message);
    } finally {
      setIsClearingReadability(false);
    }
  };

  const handleClearEntryCache = async () => {
    setIsClearingEntry(true);
    setClearEntryResult(null);
    setClearEntryError(null);

    try {
      const result = await clearEntryCache();
      setClearEntryResult(result);
      // Invalidate entries query to refresh the list
      queryClient.invalidateQueries({ queryKey: ["entries"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Clear failed";
      setClearEntryError(message);
    } finally {
      setIsClearingEntry(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Import Section */}
      <section>
        <h3 className="mb-4 text-sm font-semibold text-muted-foreground">
          {t("data_control.import_data")}
        </h3>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {t("data_control.import_feeds")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("data_control.import_description")}
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".opml,.xml"
              className="hidden"
              onChange={handleFileChange}
            />

            <button
              type="button"
              onClick={handleImportClick}
              disabled={isImporting}
              className={cn(
                "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-[var(--radius)] border border-border bg-background px-4 text-sm font-medium",
                "transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {isImporting ? (
                <>
                  <svg
                    className="size-4 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  <span>{t("data_control.importing")}</span>
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
                      strokeWidth={1.5}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
                  </svg>
                  <span>{t("data_control.select_file")}</span>
                </>
              )}
            </button>
          </div>

          {/* Import Progress */}
          {task && task.status === "running" && task.total > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-primary transition-all duration-300"
                    style={{ width: `${(task.current / task.total) * 100}%` }}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t("data_control.stop")}
                </button>
              </div>
              <div className="text-xs text-muted-foreground">
                {task.feed
                  ? `${task.feed} (${task.current}/${task.total})`
                  : `${task.current}/${task.total}`}
              </div>
            </div>
          )}

          {/* Import Cancelled */}
          {task && task.status === "cancelled" && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm dark:border-yellow-900 dark:bg-yellow-950">
              <div className="font-medium text-yellow-800 dark:text-yellow-200">
                {t("data_control.import_stopped")}
              </div>
              <div className="mt-1 text-yellow-700 dark:text-yellow-300">
                {t("data_control.imported_progress", {
                  current: task.current,
                  total: task.total,
                })}
              </div>
            </div>
          )}

          {/* Import Result */}
          {importResult && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-900 dark:bg-green-950">
              <div className="font-medium text-green-800 dark:text-green-200">
                {t("data_control.import_success")}
              </div>
              <ul className="mt-1 space-y-0.5 text-green-700 dark:text-green-300">
                <li>
                  {t("data_control.folders_created", {
                    count: importResult.foldersCreated,
                  })}
                </li>
                <li>
                  {t("data_control.feeds_created", {
                    count: importResult.feedsCreated,
                  })}
                </li>
                {(importResult.foldersSkipped > 0 ||
                  importResult.feedsSkipped > 0) && (
                  <li className="text-green-600 dark:text-green-400">
                    {t("data_control.skipped_items", {
                      foldersSkipped: importResult.foldersSkipped,
                      feedsSkipped: importResult.feedsSkipped,
                    })}
                  </li>
                )}
              </ul>
            </div>
          )}

          {/* Import Error */}
          {importError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950">
              <div className="font-medium text-red-800 dark:text-red-200">
                {t("data_control.import_failed")}
              </div>
              <div className="mt-1 text-red-700 dark:text-red-300">
                {importError}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Export Section */}
      <section>
        <h3 className="mb-4 text-sm font-semibold text-muted-foreground">
          {t("data_control.export_data")}
        </h3>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {t("data_control.export_feeds")}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("data_control.export_description")}
            </div>
          </div>

          <button
            type="button"
            onClick={handleExport}
            className={cn(
              "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-[var(--radius)] border border-border bg-background px-4 text-sm font-medium",
              "transition-colors hover:bg-secondary",
            )}
          >
            <svg
              className="size-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            <span>{t("data_control.export")}</span>
          </button>
        </div>
      </section>

      {/* 设置导出 / 导入（21 批，2026-09-18） */}
      <section>
        <h3 className="mb-4 text-sm font-semibold text-muted-foreground">
          {t("data_control.settings_backup")}
        </h3>

        <div className="space-y-4">
          {/* 导出设置 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {t("data_control.export_settings")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("data_control.export_settings_description")}
              </div>
            </div>

            <Button
              type="button"
              size="sm"
              variant="outline"
              isDisabled={isExportingSettings}
              onPress={() => void handleExportSettings()}
            >
              {t("data_control.export")}
            </Button>
          </div>

          {/* 导入设置 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {t("data_control.import_settings")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("data_control.import_settings_description")}
              </div>
            </div>

            <Button
              type="button"
              size="sm"
              variant="outline"
              isDisabled={isImportingSettings}
              onPress={() => settingsFileInputRef.current?.click()}
            >
              {t("data_control.import_settings")}
            </Button>

            <input
              ref={settingsFileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void handlePickSettingsFile(event)}
            />
          </div>

          {settingsImportCount !== null && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
              {t("data_control.import_settings_success", {
                count: settingsImportCount,
              })}
            </div>
          )}

          {settingsError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950">
              <div className="font-medium text-red-800 dark:text-red-200">
                {t("data_control.import_settings_failed")}
              </div>
              <div className="mt-1 break-all text-red-700 dark:text-red-300">
                {settingsError}
              </div>
            </div>
          )}
        </div>

        {/* 导入确认：覆盖设置不可撤销，必须问一句（AlertDialog 照 RSSHub 那处用法） */}
        <AlertDialog>
          <Button className="hidden" aria-hidden />
          <AlertDialog.Backdrop
            isOpen={pendingSettingsFile !== null}
            onOpenChange={(open) => !open && setPendingSettingsFile(null)}
          >
            <AlertDialog.Container>
              <AlertDialog.Dialog className="max-w-lg">
                <AlertDialog.Header>
                  <AlertDialog.Heading>
                    {t("data_control.import_settings_confirm_title")}
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <div className="text-sm text-muted-foreground">
                    {t("data_control.import_settings_confirm_body", {
                      count: pendingSettingsFile
                        ? Object.keys(pendingSettingsFile.payload.settings)
                            .length
                        : 0,
                    })}
                  </div>
                  {pendingSettingsFile && (
                    <div className="mt-2 break-all text-xs text-muted-foreground">
                      {pendingSettingsFile.name}
                    </div>
                  )}
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setPendingSettingsFile(null)}
                  >
                    {t("actions.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    isDisabled={isImportingSettings}
                    onPress={() => void handleConfirmImportSettings()}
                  >
                    {t("data_control.import_settings_confirm")}
                  </Button>
                </AlertDialog.Footer>
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog>
      </section>

      {/* 出向：Krss 自己当 MCP 服务器（只读 tools + resources、长期 token） */}
      <MCPOutboundSection />

      {/* Clear Cache Section */}
      <section>
        <h3 className="mb-4 text-sm font-semibold text-muted-foreground">
          {t("data_control.clear_cache")}
        </h3>

        <div className="space-y-4">
          {/* Entry Cache */}
          <ClearCacheItem
            title={t("data_control.clear_entry_cache")}
            description={t("data_control.clear_entry_cache_description")}
            isClearing={isClearingEntry}
            onClear={handleClearEntryCache}
            result={
              clearEntryResult &&
              t("data_control.cleared_count", {
                count: clearEntryResult.deleted,
              })
            }
            error={clearEntryError}
            t={t}
          />

          {/* Readability Cache */}
          <ClearCacheItem
            title={t("data_control.clear_readability_cache")}
            description={t("data_control.clear_readability_cache_description")}
            isClearing={isClearingReadability}
            onClear={handleClearReadabilityCache}
            result={
              clearReadabilityResult &&
              t("data_control.cleared_count", {
                count: clearReadabilityResult.deleted,
              })
            }
            error={clearReadabilityError}
            t={t}
          />

          {/* Icon Cache */}
          <ClearCacheItem
            title={t("data_control.clear_icon_cache")}
            description={t("data_control.clear_icon_cache_description")}
            isClearing={isClearingIcon}
            onClear={handleClearIconCache}
            result={
              clearIconResult &&
              t("data_control.cleared_count", {
                count: clearIconResult.deleted,
              })
            }
            error={clearIconError}
            t={t}
          />

          {/* AI Cache */}
          <ClearCacheItem
            title={t("data_control.clear_ai_cache")}
            description={t("data_control.clear_ai_cache_description")}
            isClearing={isClearingAI}
            onClear={handleClearAICache}
            result={
              clearAIResult &&
              t("data_control.cleared_ai_items", {
                summaries: clearAIResult.summaries,
                translations:
                  clearAIResult.translations + clearAIResult.listTranslations,
              })
            }
            error={clearAIError}
            t={t}
          />

          {/* Anubis Cookies */}
          <ClearCacheItem
            title={t("data_control.clear_anubis_cookies")}
            description={t("data_control.clear_anubis_cookies_description")}
            isClearing={isClearingAnubis}
            onClear={handleClearAnubisCookies}
            result={
              clearAnubisResult &&
              t("data_control.cleared_count", {
                count: clearAnubisResult.deleted,
              })
            }
            error={clearAnubisError}
            t={t}
          />
        </div>
      </section>
    </div>
  );
}

interface ClearCacheItemProps {
  title: string;
  description: string;
  isClearing: boolean;
  onClear: () => void;
  result: string | null | false;
  error: string | null;
  t: (key: string) => string;
}

function ClearCacheItem({
  title,
  description,
  isClearing,
  onClear,
  result,
  error,
  t,
}: ClearCacheItemProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>

        <button
          type="button"
          onClick={onClear}
          disabled={isClearing}
          className={cn(
            "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-[var(--radius)] border px-4 text-sm font-medium",
            "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950 dark:text-red-400 dark:hover:bg-red-900",
          )}
        >
          {isClearing ? (
            <>
              <svg
                className="size-4 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>{t("data_control.clearing")}</span>
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
                  strokeWidth={1.5}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              <span>{t("data_control.clear")}</span>
            </>
          )}
        </button>
      </div>

      {/* Result */}
      {result && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-2 text-xs dark:border-green-900 dark:bg-green-950">
          <span className="text-green-700 dark:text-green-300">{result}</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs dark:border-red-900 dark:bg-red-950">
          <span className="text-red-700 dark:text-red-300">{error}</span>
        </div>
      )}
    </div>
  );
}
