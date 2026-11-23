import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AlertDialog, Button, Chip, Description, Dropdown, Label } from "@heroui/react";
import {
  startImportOPML,
  watchImportStatus,
  cancelImportOPML,
  exportOPML,
  importSettings,
  exportFullBackup,
  importFullBackup,
  clearAICache,
  clearAnubisCookies,
  clearIconCache,
  clearReadabilityCache,
  clearEntryCache,
} from "@/api";
import type { ClearAICacheResponse, ClearCacheResponse, BackupImportResult, BackupSection } from "@/api";
import { Archive, ChevronDown, Download, ListChecks, Trash2, Upload } from "lucide-react";
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

/** 备份分区展示顺序（即下拉顺序）。 */
const BACKUP_SECTION_ORDER: BackupSection[] = [
  "subscriptions",
  "settings",
  "credentials",
  "plugins",
  "mcp",
];

interface BackupDocumentLike {
  format?: unknown;
  version?: unknown;
  folders?: unknown;
  feeds?: unknown;
  settings?: unknown;
  plugins?: unknown;
  mcpServers?: unknown;
  sections?: unknown;
}

type PendingImport =
  | { kind: "backup"; name: string; file: File; sections: string[] }
  | { kind: "settings"; name: string; version: number; settings: Record<string, string> };

function isBackupDocument(value: unknown): value is BackupDocumentLike {
  if (typeof value !== "object" || value === null) return false;
  const c = value as BackupDocumentLike;
  return typeof c.format === "string" && typeof c.version === "number";
}

/** 老备份没有 sections 字段时，从实际内容推断分区。 */
function inferBackupSections(doc: BackupDocumentLike): BackupSection[] {
  const set = new Set<BackupSection>();
  if (Array.isArray(doc.folders) && doc.folders.length > 0) set.add("subscriptions");
  if (Array.isArray(doc.feeds) && doc.feeds.length > 0) set.add("subscriptions");
  if (
    doc.settings &&
    typeof doc.settings === "object" &&
    Object.keys(doc.settings as Record<string, unknown>).length > 0
  )
    set.add("settings");
  if (Array.isArray(doc.plugins) && doc.plugins.length > 0) set.add("plugins");
  if (Array.isArray(doc.mcpServers) && doc.mcpServers.length > 0) set.add("mcp");
  return BACKUP_SECTION_ORDER.filter((s) => set.has(s));
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

  // ---------- 备份与恢复（设置 + 全量合并，多选分区） ----------

  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const [selectedSections, setSelectedSections] = useState<Set<BackupSection>>(
    () => new Set<BackupSection>(["subscriptions", "settings", "plugins", "mcp"]),
  );
  const [isExportingBackup, setIsExportingBackup] = useState(false);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [isImportingBackup, setIsImportingBackup] = useState(false);
  const [backupImportResult, setBackupImportResult] =
    useState<BackupImportResult | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  const includeCredentials = selectedSections.has("credentials");

  const runExport = async () => {
    setIsExportingBackup(true);
    setBackupError(null);
    try {
      await exportFullBackup(
        BACKUP_SECTION_ORDER.filter((s) => selectedSections.has(s)),
      );
    } catch (err) {
      setBackupError(
        err instanceof Error
          ? err.message
          : t("data_control.export_full_backup_failed"),
      );
    } finally {
      setIsExportingBackup(false);
      setExportConfirmOpen(false);
    }
  };

  const handleExportBackup = () => {
    setBackupError(null);
    if (selectedSections.size === 0) {
      setBackupError(t("data_control.backup_select_at_least_one"));
      return;
    }
    // 勾了敏感凭证：明文导出，先强确认
    if (includeCredentials) {
      setExportConfirmOpen(true);
      return;
    }
    void runExport();
  };

  const handlePickBackupFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0] ?? null;
    setBackupImportResult(null);
    setBackupError(null);
    try {
      if (!file) return;
      const parsed: unknown = JSON.parse(await file.text());
      if (isBackupDocument(parsed)) {
        setPendingImport({
          kind: "backup",
          name: file.name,
          file,
          sections: Array.isArray(parsed.sections)
            ? (parsed.sections as string[])
            : inferBackupSections(parsed),
        });
      } else if (isSettingsExportPayload(parsed)) {
        // 兼容旧版「设置备份」文件：仍按设置导入
        setPendingImport({
          kind: "settings",
          name: file.name,
          version: parsed.version,
          settings: parsed.settings as Record<string, string>,
        });
      } else {
        setBackupError(t("data_control.backup_invalid_file"));
      }
    } catch {
      setBackupError(t("data_control.backup_invalid_file"));
    } finally {
      if (backupFileInputRef.current) backupFileInputRef.current.value = "";
    }
  };

  const handleConfirmImportBackup = async () => {
    if (!pendingImport) return;
    setIsImportingBackup(true);
    setBackupError(null);
    try {
      if (pendingImport.kind === "settings") {
        const result = await importSettings({
          version: pendingImport.version,
          settings: pendingImport.settings,
        });
        setBackupImportResult({
          foldersCreated: 0,
          foldersSkipped: 0,
          feedsCreated: 0,
          feedsSkipped: 0,
          settingsApplied: result.imported,
          pluginsApplied: 0,
          mcpServersCreated: 0,
          mcpServersSkipped: 0,
        });
        await pullSettingsFromServer();
      } else {
        const result = await importFullBackup(pendingImport.file);
        setBackupImportResult(result);
      }
      setPendingImport(null);
      await queryClient.invalidateQueries();
    } catch (err) {
      setBackupError(
        err instanceof Error
          ? err.message
          : t("data_control.import_full_backup_failed"),
      );
      setPendingImport(null);
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

      {/* 备份与恢复：设置备份 + 全量备份合并，多选分区（含可选敏感凭证） */}
      <SectionCard
        icon={<Archive className="size-4" />}
        title={t("data_control.backup_title")}
        description={t("data_control.backup_description")}
      >
        <div className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <Dropdown>
              <Dropdown.Trigger className="group flex h-auto w-full items-center justify-between gap-3 rounded-xl border border-border bg-background px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-secondary/50 data-[focus-visible]:ring-2 data-[focus-visible]:ring-primary">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                    <ListChecks className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">
                      {t("data_control.backup_sections")}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {selectedSections.size === 0
                        ? t("data_control.backup_select_at_least_one")
                        : BACKUP_SECTION_ORDER.filter((section) =>
                            selectedSections.has(section),
                          )
                            .map((section) =>
                              t(`data_control.backup_section_${section}`),
                            )
                            .join(" · ")}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Chip
                    size="sm"
                    variant="tertiary"
                    className="border border-border tabular-nums text-muted-foreground"
                  >
                    {selectedSections.size}
                  </Chip>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-aria-expanded:rotate-180" />
                </span>
              </Dropdown.Trigger>
              <Dropdown.Popover>
                <Dropdown.Menu
                  selectionMode="multiple"
                  selectedKeys={selectedSections}
                  onSelectionChange={(keys) => {
                    setSelectedSections(
                      keys === "all"
                        ? new Set<BackupSection>(BACKUP_SECTION_ORDER)
                        : new Set<BackupSection>(
                            Array.from(keys) as unknown as BackupSection[],
                          ),
                    );
                  }}
                >
                  {BACKUP_SECTION_ORDER.map((section) => (
                    <Dropdown.Item
                      key={section}
                      id={section}
                      textValue={t(`data_control.backup_section_${section}`)}
                    >
                      <div className="flex flex-col">
                        <Label>
                          {t(`data_control.backup_section_${section}`)}
                        </Label>
                        <Description>
                          {t(`data_control.backup_section_${section}_desc`)}
                        </Description>
                      </div>
                      <Dropdown.ItemIndicator className="ms-auto" />
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
            {includeCredentials && (
              <div className="text-xs text-warning">
                {t("data_control.backup_credentials_warning")}
              </div>
            )}
          </div>

          <div className="divide-y divide-border/50">
            <SettingRow
              label={t("data_control.backup_export")}
              hint={t("data_control.backup_export_desc")}
            >
              <Button
                type="button"
                size="sm"
                variant="outline"
                isDisabled={isExportingBackup || selectedSections.size === 0}
                onPress={handleExportBackup}
              >
                <Download className="size-3.5" />
                {t("data_control.export")}
              </Button>
            </SettingRow>

            <SettingRow
              label={t("data_control.backup_import")}
              hint={t("data_control.backup_import_desc")}
            >
              <Button
                type="button"
                size="sm"
                variant="outline"
                isDisabled={isImportingBackup}
                onPress={() => backupFileInputRef.current?.click()}
              >
                <Upload className="size-3.5" />
                {t("data_control.backup_import")}
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
            <div className="space-y-2">
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
                    {t("data_control.backup_import_failed")}
                  </div>
                  <div className="mt-1 break-all text-red-700 dark:text-red-300">
                    {backupError}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 导出确认：勾了敏感凭证 → 明文导出，强提醒 */}
        <AlertDialog>
          <Button className="hidden" aria-hidden />
          <AlertDialog.Backdrop
            isOpen={exportConfirmOpen}
            onOpenChange={(open) => !open && setExportConfirmOpen(false)}
          >
            <AlertDialog.Container>
              <AlertDialog.Dialog className="max-w-lg">
                <AlertDialog.Header>
                  <AlertDialog.Heading>
                    {t("data_control.backup_export_confirm_title")}
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <div className="text-sm text-muted-foreground">
                    {t("data_control.backup_export_confirm_body")}
                  </div>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setExportConfirmOpen(false)}
                  >
                    {t("actions.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    isDisabled={isExportingBackup}
                    onPress={() => void runExport()}
                  >
                    {t("data_control.backup_export_confirm")}
                  </Button>
                </AlertDialog.Footer>
              </AlertDialog.Dialog>
            </AlertDialog.Container>
          </AlertDialog.Backdrop>
        </AlertDialog>

        {/* 导入预览：按文件实际包含的分区恢复 */}
        <AlertDialog>
          <Button className="hidden" aria-hidden />
          <AlertDialog.Backdrop
            isOpen={pendingImport !== null}
            onOpenChange={(open) => !open && setPendingImport(null)}
          >
            <AlertDialog.Container>
              <AlertDialog.Dialog className="max-w-lg">
                <AlertDialog.Header>
                  <AlertDialog.Heading>
                    {t("data_control.backup_import_confirm_title")}
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <div className="text-sm text-muted-foreground">
                    {t("data_control.backup_import_confirm_body")}
                  </div>
                  {pendingImport && (
                    <div className="mt-3 space-y-1.5 rounded-lg border border-border/60 p-3 text-sm">
                      <div className="break-all text-xs text-muted-foreground">
                        {pendingImport.name}
                      </div>
                      {pendingImport.kind === "settings" ? (
                        <div className="font-medium">
                          {t("data_control.backup_section_settings")} ·{" "}
                          {t("data_control.backup_settings_count", {
                            count: Object.keys(pendingImport.settings).length,
                          })}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {pendingImport.sections.length === 0 && (
                            <span className="text-muted-foreground">
                              {t("data_control.backup_sections_empty")}
                            </span>
                          )}
                          {pendingImport.sections.map((section) => (
                            <span
                              key={section}
                              className="rounded-full bg-secondary px-2 py-0.5 text-xs"
                            >
                              {t(`data_control.backup_section_${section}`)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setPendingImport(null)}
                  >
                    {t("actions.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    isDisabled={isImportingBackup}
                    onPress={() => void handleConfirmImportBackup()}
                  >
                    {t("data_control.backup_import_confirm")}
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
