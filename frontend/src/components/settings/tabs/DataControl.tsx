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
  exportFullBackup,
  importFullBackup,
  clearAICache,
  clearAnubisCookies,
  clearIconCache,
  clearReadabilityCache,
  clearEntryCache,
} from "@/api";
import type { ClearAICacheResponse, ClearCacheResponse, BackupImportResult } from "@/api";
import { Archive, Download, Trash2, Upload } from "lucide-react";
import {
  SectionCard,
  SettingRow,
} from "@/components/settings/settings-primitives";
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

  // ---------- 全量备份（整库）导出 / 导入 ----------

  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const [isExportingBackup, setIsExportingBackup] = useState(false);
  const [pendingBackupFile, setPendingBackupFile] = useState<File | null>(null);
  const [isImportingBackup, setIsImportingBackup] = useState(false);
  const [backupImportResult, setBackupImportResult] =
    useState<BackupImportResult | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  /** 导出整库备份：直接下载后端给的 JSON（前端不再 JSON.parse，避免 int64 精度丢）。 */
  const handleExportBackup = async () => {
    setIsExportingBackup(true);
    setBackupError(null);

    try {
      await exportFullBackup();
    } catch (err) {
      setBackupError(
        err instanceof Error
          ? err.message
          : t("data_control.export_full_backup_failed"),
      );
    } finally {
      setIsExportingBackup(false);
    }
  };

  /** 选中备份文件：不解析 JSON（保精度），直接弹确认。 */
  const handlePickBackupFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setBackupImportResult(null);
    setBackupError(null);
    setPendingBackupFile(file);
    // 允许连续选同一份文件
    if (backupFileInputRef.current) backupFileInputRef.current.value = "";
  };

  const handleConfirmImportBackup = async () => {
    if (!pendingBackupFile) return;
    setIsImportingBackup(true);

    try {
      const result = await importFullBackup(pendingBackupFile);
      setBackupImportResult(result);
      setPendingBackupFile(null);
      // 整库变了：文件夹 / 订阅 / 未读数全部重新取数
      await queryClient.invalidateQueries();
    } catch (err) {
      setBackupError(
        err instanceof Error
          ? err.message
          : t("data_control.import_full_backup_failed"),
      );
      setPendingBackupFile(null);
    } finally {
      setIsImportingBackup(false);
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
    <div className="space-y-5">
      {/* 导入数据 */}
      <SectionCard
        icon={<Upload className="size-4" />}
        title={t("data_control.import_data")}
        description={t("data_control.import_description")}
      >
        <div className="divide-y divide-border/50">
          <SettingRow label={t("data_control.import_feeds")}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".opml,.xml"
              className="hidden"
              onChange={handleFileChange}
            />
            <Button
              size="sm"
              variant="outline"
              isDisabled={isImporting}
              onPress={handleImportClick}
            >
              {isImporting ? (
                <>
                  <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {t("data_control.importing")}
                </>
              ) : (
                <>
                  <Upload className="size-3.5" />
                  {t("data_control.select_file")}
                </>
              )}
            </Button>
          </SettingRow>
        </div>

        {(isImporting ||
          (task && task.status === "cancelled") ||
          importResult ||
          importError) && (
          <div className="space-y-2 px-1 pb-2 pt-1">
            {/* 导入进度 */}
            {isImporting && task && task.total > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{ width: `${(task.current / task.total) * 100}%` }}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => void handleCancel()}
                    className="h-6 min-w-0 px-2 text-xs text-muted-foreground"
                  >
                    {t("data_control.stop")}
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground">
                  {task.feed
                    ? `${task.feed} (${task.current}/${task.total})`
                    : `${task.current}/${task.total}`}
                </div>
              </div>
            )}

            {/* 导入被停止 */}
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

            {/* 导入结果 */}
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

            {/* 导入失败 */}
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
        )}
      </SectionCard>

      {/* 导出数据 */}
      <SectionCard
        icon={<Download className="size-4" />}
        title={t("data_control.export_data")}
      >
        <div className="divide-y divide-border/50">
          <SettingRow
            label={t("data_control.export_feeds")}
            hint={t("data_control.export_description")}
          >
            <Button size="sm" variant="outline" onPress={() => void handleExport()}>
              <Download className="size-3.5" />
              {t("data_control.export")}
            </Button>
          </SettingRow>
        </div>
      </SectionCard>

      {/* 设置备份：导出 / 导入整份设置（21 批） */}
      <SectionCard
        icon={<Archive className="size-4" />}
        title={t("data_control.settings_backup")}
      >
        <div className="divide-y divide-border/50">
          <SettingRow
            label={t("data_control.export_settings")}
            hint={t("data_control.export_settings_description")}
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              isDisabled={isExportingSettings}
              onPress={() => void handleExportSettings()}
            >
              {t("data_control.export")}
            </Button>
          </SettingRow>

          <SettingRow
            label={t("data_control.import_settings")}
            hint={t("data_control.import_settings_description")}
          >
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
          </SettingRow>
        </div>

        {(settingsImportCount !== null || settingsError) && (
          <div className="space-y-2 px-1 pb-2 pt-1">
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
        )}

        {/* 导入确认：覆盖设置不可撤销，必须问一句 */}
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
      </SectionCard>

      {/* 全量备份：整库（文件夹层级+类型、全部订阅、非敏感设置、插件、MCP 连接） */}
      <SectionCard
        icon={<Archive className="size-4" />}
        title={t("data_control.full_backup")}
      >
        <div className="divide-y divide-border/50">
          <SettingRow
            label={t("data_control.export_full_backup")}
            hint={t("data_control.export_full_backup_description")}
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              isDisabled={isExportingBackup}
              onPress={() => void handleExportBackup()}
            >
              {t("data_control.export")}
            </Button>
          </SettingRow>

          <SettingRow
            label={t("data_control.import_full_backup")}
            hint={t("data_control.import_full_backup_description")}
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              isDisabled={isImportingBackup}
              onPress={() => backupFileInputRef.current?.click()}
            >
              {t("data_control.import_full_backup")}
            </Button>
            <input
              ref={backupFileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handlePickBackupFile}
            />
          </SettingRow>
        </div>

        {(backupImportResult !== null || backupError) && (
          <div className="space-y-2 px-1 pb-2 pt-1">
            {backupImportResult !== null && (
              <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
                {t("data_control.import_full_backup_success", {
                  folders: backupImportResult.foldersCreated,
                  feeds: backupImportResult.feedsCreated,
                  settings: backupImportResult.settingsApplied,
                })}
              </div>
            )}
            {backupError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950">
                <div className="font-medium text-red-800 dark:text-red-200">
                  {t("data_control.import_full_backup_failed")}
                </div>
                <div className="mt-1 break-all text-red-700 dark:text-red-300">
                  {backupError}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 导入确认：会向库里合并文件夹/订阅/配置，必须问一句 */}
        <AlertDialog>
          <Button className="hidden" aria-hidden />
          <AlertDialog.Backdrop
            isOpen={pendingBackupFile !== null}
            onOpenChange={(open) => !open && setPendingBackupFile(null)}
          >
            <AlertDialog.Container>
              <AlertDialog.Dialog className="max-w-lg">
                <AlertDialog.Header>
                  <AlertDialog.Heading>
                    {t("data_control.import_full_backup_confirm_title")}
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <div className="text-sm text-muted-foreground">
                    {t("data_control.import_full_backup_confirm_body")}
                  </div>
                  {pendingBackupFile && (
                    <div className="mt-2 break-all text-xs text-muted-foreground">
                      {pendingBackupFile.name}
                    </div>
                  )}
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setPendingBackupFile(null)}
                  >
                    {t("actions.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    isDisabled={isImportingBackup}
                    onPress={() => void handleConfirmImportBackup()}
                  >
                    {t("data_control.import_full_backup_confirm")}
                  </Button>
                </AlertDialog.Footer>
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog>
      </SectionCard>

      {/* 出向：Krss 自己当 MCP 服务器（只读 tools + resources、长期 token） */}
      <MCPOutboundSection />

      {/* 清理缓存 */}
      <SectionCard
        icon={<Trash2 className="size-4" />}
        title={t("data_control.clear_cache")}
      >
        <div className="divide-y divide-border/50">
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
      </SectionCard>
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
    <div>
      <SettingRow label={title} hint={description}>
        <Button
          type="button"
          size="sm"
          variant="danger"
          isDisabled={isClearing}
          onPress={onClear}
        >
          {isClearing ? (
            <>
              <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {t("data_control.clearing")}
            </>
          ) : (
            <>
              <Trash2 className="size-3.5" />
              {t("data_control.clear")}
            </>
          )}
        </Button>
      </SettingRow>

      {(result || error) && (
        <div className="space-y-1 px-1 pb-2">
          {result && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-2 text-xs dark:border-green-900 dark:bg-green-950">
              <span className="text-green-700 dark:text-green-300">
                {result}
              </span>
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs dark:border-red-900 dark:bg-red-950">
              <span className="text-red-700 dark:text-red-300">{error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
